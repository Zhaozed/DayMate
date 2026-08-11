// Routine scheduler (Spec §12 triggers). Uses node-cron for `schedule`
// triggers, setInterval for `email_poll` triggers, and a shared poll loop for
// `calendar_before` triggers (M5 §13.3): every minute it lists upcoming events
// and fires any routine whose window (now < start <= now+minutesBefore) is
// reached. Idempotency key `calbefore:<routineId>:<eventId>:<eventDate>` so a
// refire (same tick, restart mid-window) is a no-op rather than a duplicate run.
//
// Idempotency: each fire builds a time-bucket idempotency key so a duplicate
// trigger (Spec §20 "Routine duplicated trigger") or an in-app double-fire is
// a no-op rather than a duplicate run.

import cron from 'node-cron'
import type { RoutineEngine } from './engine'
import type { RoutineStore } from '../db/store'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type { ApplicationService } from '../services/application-service'
import type { CalendarEvent, RoutineDefinition, RoutineTrigger } from '@shared/types'

type ScheduledJob = ReturnType<typeof cron.schedule>

const CAL_BEFORE_POLL_MS = 60_000 // poll every minute
const CAL_BEFORE_LOOKAHEAD_MS = 24 * 60 * 60 * 1000 // look ahead 24h
const APP_STATUS_POLL_MS = 60_000 // shared poll for application_status triggers

export class RoutineScheduler {
  private cronJobs = new Map<string, ScheduledJob>()
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  private calBeforeTimer: ReturnType<typeof setInterval> | undefined
  private appStatusTimer: ReturnType<typeof setInterval> | undefined
  private maintenanceJob: ScheduledJob | undefined
  private stopped = false
  /** When true, scheduled triggers are suppressed (M4 context menu). Manual
   *  runs (runManually / ROUTINE_RUN) are never affected. */
  private paused = false

  constructor(
    private readonly engine: RoutineEngine,
    private readonly store: RoutineStore,
    private readonly calendarProvider?: CalendarProvider,
    private readonly applicationService?: ApplicationService
  ) {}

  /** Start all enabled scheduled/poll routines. Safe to call once at boot. */
  start(): void {
    const routines = this.store.listRoutines()
    for (const r of routines) {
      if (!r.enabled) continue
      this.schedule(r)
    }
    // Shared `calendar_before` poller — one loop for all such routines.
    if (this.calendarProvider && !this.calBeforeTimer) {
      this.calBeforeTimer = setInterval(() => {
        void this.fireCalendarBefore(new Date())
      }, CAL_BEFORE_POLL_MS)
    }
    // Shared `application_status` poller — one loop for all such routines.
    if (this.applicationService && !this.appStatusTimer) {
      this.appStatusTimer = setInterval(() => {
        void this.fireApplicationStatus()
      }, APP_STATUS_POLL_MS)
    }
    // Daily maintenance sweep (§3.1/§5): purge 30d-soft-deleted rows, auto-
    // archive 30d-rejected, demote 14d-stale. A 30d/14d window needs no tighter
    // cadence — daily cron, NOT the 60s poll. This is an internal housekeeping
    // job, not a user-visible Routine (it does not appear in the Routines page);
    // it runs even when routines are paused (unrelated to routine execution).
    if (this.applicationService && !this.maintenanceJob) {
      this.maintenanceJob = cron.schedule('0 3 * * *', () => {
        void this.runMaintenance()
      })
    }
  }

  /** Daily maintenance: purge / auto-archive / auto-demote (§3.1/§5). */
  private async runMaintenance(): Promise<void> {
    if (!this.applicationService) return
    try {
      const result = this.applicationService.runMaintenance()
      console.log(
        `[scheduler] maintenance: purged=${result.purged} archived=${result.archived} demoted=${result.demoted}`
      )
    } catch (err) {
      console.error(
        '[scheduler] maintenance failed:',
        err instanceof Error ? err.message : err
      )
    }
  }

  /** Re-load schedules (call after a routine is enabled/disabled/edited). */
  reschedule(): void {
    this.stop()
    this.start()
  }

  /** Pause all scheduled triggers. Returns the new paused state. */
  pause(): boolean {
    this.paused = true
    return this.paused
  }

  /** Resume scheduled triggers. Returns the new paused state. */
  resume(): boolean {
    this.paused = false
    return this.paused
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Manually trigger a routine now (fresh idempotency key — always runs). */
  async runManually(routineId: string): Promise<unknown> {
    return this.engine.run(routineId, { manual: true })
  }

  private schedule(r: RoutineDefinition): void {
    if (r.trigger.type === 'schedule') {
      const job = cron.schedule(r.trigger.cron, () => {
        void this.fire(r, this.scheduleBucket())
      })
      this.cronJobs.set(r.id, job)
    } else if (r.trigger.type === 'email_poll') {
      // Capture before the closure — TS resets property-access narrowing
      // inside nested arrow functions.
      const intervalMinutes = r.trigger.intervalMinutes
      const ms = intervalMinutes * 60_000
      const timer = setInterval(() => {
        void this.fire(r, this.pollBucket(intervalMinutes))
      }, ms)
      this.pollTimers.set(r.id, timer)
    }
    // calendar_before is handled by the shared poller in `start()` — no
    // per-routine job here.
  }

  /**
   * Poll entry point for `calendar_before` triggers (Spec §13.3). For each
   * enabled routine with a `calendar_before` trigger, list upcoming events and
   * fire the routine once per event whose start is within the minutesBefore
   * window (now < start <= now+minutesBefore). The `targetEventId` is passed
   * into the run so the routine reads THAT event, not "the next one" — keeping
   * the agent step deterministic (§13.3). Exposed for tests with a fixed `now`.
   */
  async fireCalendarBefore(now: Date): Promise<void> {
    if (this.paused) return
    if (!this.calendarProvider) return
    const nowMs = now.getTime()
    const routines = this.store
      .listRoutines()
      .filter((r) => r.enabled && r.trigger.type === 'calendar_before')
    if (routines.length === 0) return

    let events: CalendarEvent[]
    try {
      events = await this.calendarProvider.listEvents({
        start: now.toISOString(),
        end: new Date(nowMs + CAL_BEFORE_LOOKAHEAD_MS).toISOString()
      })
    } catch (err) {
      console.error(
        '[scheduler] calendar_before listEvents failed:',
        err instanceof Error ? err.message : err
      )
      return
    }

    for (const r of routines) {
      const minutesBefore = (r.trigger as Extract<RoutineTrigger, { type: 'calendar_before' }>).minutesBefore
      const windowMs = minutesBefore * 60_000
      for (const e of events) {
        const startMs = new Date(e.start).getTime()
        // Fire once when we are within the minutesBefore window and the event
        // has not yet started. The idempotency key (event + date) makes a
        // refire within the same day a no-op.
        if (startMs > nowMs && startMs - nowMs <= windowMs) {
          const eventDate = e.start.slice(0, 10) // YYYY-MM-DD
          const idempotencyKey = `calbefore:${r.id}:${e.eventId}:${eventDate}`
          try {
            await this.engine.run(r.id, { idempotencyKey, inputs: { targetEventId: e.eventId } })
          } catch (err) {
            console.error(
              `[scheduler] calendar_before run ${r.id} for ${e.eventId} failed:`,
              err instanceof Error ? err.message : err
            )
          }
        }
      }
    }
  }

  /**
   * Poll entry point for `application_status` triggers (Milestone A §F). For
   * each enabled routine with an `application_status` trigger, list
   * applications whose current status is `interview` and that have no prep
   * material yet, and fire the routine once per app. The `targetApplicationId`
   * is passed into the run inputs so the routine reads THAT app (determinism).
   * Idempotency key `appstatus:<rid>:<appId>:interview` so a refire (same tick,
   * restart) is a no-op — and once a prep material is saved the app drops out
   * of the candidate list anyway. Exposed for tests.
   */
  async fireApplicationStatus(): Promise<void> {
    if (this.paused) return
    if (!this.applicationService) return
    const routines = this.store
      .listRoutines()
      .filter((r) => r.enabled && r.trigger.type === 'application_status')
    if (routines.length === 0) return

    const apps = this.applicationService.listInterviewStatusApps()
    if (apps.length === 0) return

    for (const r of routines) {
      for (const v of apps) {
        const idempotencyKey = `appstatus:${r.id}:${v.application.id}:interview`
        try {
          await this.engine.run(r.id, { idempotencyKey, inputs: { targetApplicationId: v.application.id } })
        } catch (err) {
          console.error(
            `[scheduler] application_status run ${r.id} for ${v.application.id} failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
    }
  }

  private async fire(r: RoutineDefinition, idempotencyKey: string): Promise<void> {
    if (this.paused) return // M4 context menu: routines are paused.
    try {
      await this.engine.run(r.id, { idempotencyKey })
    } catch (err) {
      // A failed scheduled run is surfaced via the Activity log; don't crash
      // the scheduler. The next tick will retry with a fresh bucket.
      console.error(`[scheduler] routine ${r.id} failed:`, err instanceof Error ? err.message : err)
    }
  }

  private scheduleBucket(): string {
    // Floor to the minute. Two fires in the same minute (duplicate trigger) →
    // same key → no-op.
    const d = new Date()
    d.setSeconds(0, 0)
    return `sched:${d.toISOString()}`
  }

  private pollBucket(intervalMinutes: number): string {
    const bucket = Math.floor(Date.now() / (intervalMinutes * 60_000))
    return `poll:${bucket}`
  }

  stop(): void {
    for (const job of this.cronJobs.values()) job.stop()
    this.cronJobs.clear()
    for (const t of this.pollTimers.values()) clearInterval(t)
    this.pollTimers.clear()
    if (this.calBeforeTimer) {
      clearInterval(this.calBeforeTimer)
      this.calBeforeTimer = undefined
    }
    if (this.appStatusTimer) {
      clearInterval(this.appStatusTimer)
      this.appStatusTimer = undefined
    }
    if (this.maintenanceJob) {
      this.maintenanceJob.stop()
      this.maintenanceJob = undefined
    }
    this.stopped = true
  }

  get isStopped(): boolean {
    return this.stopped
  }
}
