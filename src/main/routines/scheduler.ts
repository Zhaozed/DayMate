// Routine scheduler (Spec §12 triggers). Uses node-cron for `schedule` triggers
// and setInterval for `email_poll` triggers. `calendar_before` is P1 — not
// implemented here.
//
// Idempotency: each fire builds a time-bucket idempotency key so a duplicate
// trigger (Spec §20 "Routine duplicated trigger") or an in-app double-fire is
// a no-op rather than a duplicate run.

import cron from 'node-cron'
import type { RoutineEngine } from './engine'
import type { RoutineStore } from '../db/store'
import type { RoutineDefinition } from '@shared/types'

type ScheduledJob = ReturnType<typeof cron.schedule>

export class RoutineScheduler {
  private cronJobs = new Map<string, ScheduledJob>()
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  private stopped = false

  constructor(
    private readonly engine: RoutineEngine,
    private readonly store: RoutineStore
  ) {}

  /** Start all enabled scheduled/poll routines. Safe to call once at boot. */
  start(): void {
    const routines = this.store.listRoutines()
    for (const r of routines) {
      if (!r.enabled) continue
      this.schedule(r)
    }
  }

  /** Re-load schedules (call after a routine is enabled/disabled/edited). */
  reschedule(): void {
    this.stop()
    this.start()
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
    // calendar_before (P1) intentionally not implemented.
  }

  private async fire(r: RoutineDefinition, idempotencyKey: string): Promise<void> {
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
    this.stopped = true
  }

  get isStopped(): boolean {
    return this.stopped
  }
}
