import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { RoutineScheduler } from '../../src/main/routines/scheduler'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockMail163Provider } from '../../src/main/providers/email/mock-mail163-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import type { CalendarEvent, CalendarProvider, DateRange } from '@shared/types'

function buildEngine() {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const deps: EngineDeps = {
    store,
    toolRegistry: createToolRegistry(),
    activityService,
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    approvalService: new ApprovalService(store),
    emailProviders: [new MockEmailProvider(), new MockMail163Provider()],
    calendarProvider: new MockCalendarProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps }
}

describe('meeting prep routine (Spec §13.3)', () => {
  it('prepares the target event: objective, context, questions, references related thread, excludes untrusted mail', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    // The scheduler hands the target event id into the run inputs; the routine
    // reads THAT event (deterministic — the agent does not pick "the next one").
    const run = await engine.run('meeting_prep', {
      idempotencyKey: 'mp-1',
      inputs: { targetEventId: 'mock-evt-001' }
    })
    expect(run.status).toBe('completed')

    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    const prep = ntk[0]
    expect(prep.title).toBe('会议准备：Q3 roadmap review')
    expect(prep.sourceRefs.some((r) => r.type === 'calendar' && r.id === 'mock-evt-001')).toBe(true)
    // mock-msg-001 is from Alice Chen — an attendee — and shares "roadmap"; it
    // is surfaced as a related source. The SPAM fixture mock-msg-003 is never
    // referenced (untrusted, excluded before summarizing — §17).
    expect(prep.sourceRefs.some((r) => r.id === 'mock-msg-001')).toBe(true)
    expect(prep.sourceRefs.some((r) => r.id === 'mock-msg-003')).toBe(false)
    // A draft-to-the-related-thread suggested action is present.
    expect(prep.suggestedActions.some((a) => a.toolName === 'email.create_draft')).toBe(true)

    // The suggested-action must NOT reference the untrusted thread.
    const untrustedThreadIds = prep.suggestedActions.map((a) => a.args?.threadId)
    expect(untrustedThreadIds).not.toContain('mock-thread-003')
  })

  it('a re-run with the same idempotency key is a no-op (no duplicate NTK)', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    await engine.run('meeting_prep', {
      idempotencyKey: 'mp-dup',
      inputs: { targetEventId: 'mock-evt-001' }
    })
    const ntk1 = store.listNeedToKnow().length
    const runs1 = store.listRuns().length

    const run2 = await engine.run('meeting_prep', {
      idempotencyKey: 'mp-dup',
      inputs: { targetEventId: 'mock-evt-001' }
    })
    expect(run2.status).toBe('completed')
    expect(store.listNeedToKnow().length).toBe(ntk1)
    expect(store.listRuns().length).toBe(runs1)
  })

  it('produces a graceful brief when the target event is missing (continueOnError)', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const run = await engine.run('meeting_prep', {
      idempotencyKey: 'mp-none',
      inputs: { targetEventId: 'does-not-exist' }
    })
    expect(run.status).toBe('completed')
    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    expect(ntk[0].summary).toContain('没有可准备')
    // The unavailable calendar.get step recorded a provider_unavailable event.
    const events = store.listActivity(run.id)
    expect(events.some((e) => e.type === 'provider_unavailable')).toBe(true)
  })
})

// A stub calendar provider with fixed, time-stable events so the
// `calendar_before` window logic is deterministic (the mock provider's
// fixtures are relative to wall-clock now, which is non-deterministic for CI).
class StubCalendar implements CalendarProvider {
  readonly provider = 'feishu' as const
  readonly accountId = 'stub-cal-001'
  constructor(private readonly events: CalendarEvent[]) {}
  async listEvents(range: DateRange): Promise<CalendarEvent[]> {
    const s = new Date(range.start).getTime()
    const e = new Date(range.end).getTime()
    return this.events.filter((ev) => {
      const es = new Date(ev.start).getTime()
      return es >= s && es <= e
    })
  }
  async getEvent(eventId: string): Promise<CalendarEvent> {
    const ev = this.events.find((x) => x.eventId === eventId)
    if (!ev) throw new Error(`Event not found: ${eventId}`)
    return ev
  }
}

describe('RoutineScheduler.fireCalendarBefore (§13.3 calendar_before)', () => {
  function buildWith(events: CalendarEvent[]) {
    const store = new InMemoryStore()
    const activityService = new ActivityService(store)
    const cal = new StubCalendar(events)
    const deps: EngineDeps = {
      store,
      toolRegistry: createToolRegistry(),
      activityService,
      taskService: new TaskService(store),
      needToKnowService: new NeedToKnowService(store),
      approvalService: new ApprovalService(store),
      emailProviders: [new MockEmailProvider()],
      calendarProvider: cal,
      agentRuntime: createDeterministicAgentRuntime(),
      memoryService: new MemoryService(store),
      notify: () => {}
    }
    const engine = new RoutineEngine(deps)
    seedPresets(store)
    // Disable every preset except meeting_prep so only the calendar_before
    // routine is in scope.
    for (const r of store.listRoutines()) {
      if (r.id !== 'meeting_prep') store.saveRoutine({ ...r, enabled: false })
    }
    return { store, engine, scheduler: new RoutineScheduler(engine, store, cal) }
  }

  it('fires when now is within minutesBefore of the event start, passing targetEventId', async () => {
    // Event starts at T+10min; minutesBefore is 15 (from the preset). now=T →
    // start-now = 10min <= 15min → fire.
    const t = new Date('2026-08-06T09:00:00.000Z').getTime()
    const events: CalendarEvent[] = [
      {
        provider: 'feishu',
        accountId: 'stub-cal-001',
        eventId: 'evt-soon',
        title: 'Sprint planning',
        start: new Date(t + 10 * 60_000).toISOString(),
        end: new Date(t + 70 * 60_000).toISOString(),
        location: '',
        attendees: [{ name: 'Alice', address: 'alice@example.com' }],
        description: '',
        sourceUrl: ''
      }
    ]
    const { store, scheduler } = buildWith(events)

    await scheduler.fireCalendarBefore(new Date(t))

    const runs = store.listRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].triggerType).toBe('calendar_before')
    expect(runs[0].inputs.targetEventId).toBe('evt-soon')
    // A NTK was published.
    expect(store.listNeedToKnow().length).toBe(1)
  })

  it('does NOT fire when the event is farther out than minutesBefore', async () => {
    const t = new Date('2026-08-06T09:00:00.000Z').getTime()
    const events: CalendarEvent[] = [
      {
        provider: 'feishu',
        accountId: 'stub-cal-001',
        eventId: 'evt-later',
        title: 'Sprint planning',
        start: new Date(t + 2 * 60 * 60_000).toISOString(), // T+2h, beyond 15min
        end: new Date(t + 3 * 60 * 60_000).toISOString(),
        location: '',
        attendees: [],
        description: '',
        sourceUrl: ''
      }
    ]
    const { store, scheduler } = buildWith(events)
    await scheduler.fireCalendarBefore(new Date(t))
    expect(store.listRuns().length).toBe(0)
  })

  it('does NOT fire for an event that already started (start <= now)', async () => {
    const t = new Date('2026-08-06T09:00:00.000Z').getTime()
    const events: CalendarEvent[] = [
      {
        provider: 'feishu',
        accountId: 'stub-cal-001',
        eventId: 'evt-past',
        title: 'Sprint planning',
        start: new Date(t - 5 * 60_000).toISOString(), // 5 min ago
        end: new Date(t + 55 * 60_000).toISOString(),
        location: '',
        attendees: [],
        description: '',
        sourceUrl: ''
      }
    ]
    const { store, scheduler } = buildWith(events)
    await scheduler.fireCalendarBefore(new Date(t))
    expect(store.listRuns().length).toBe(0)
  })

  it('idempotency: a refire within the same event-day is a no-op', async () => {
    const t = new Date('2026-08-06T09:00:00.000Z').getTime()
    const events: CalendarEvent[] = [
      {
        provider: 'feishu',
        accountId: 'stub-cal-001',
        eventId: 'evt-soon2',
        title: 'Sprint planning',
        start: new Date(t + 10 * 60_000).toISOString(),
        end: new Date(t + 70 * 60_000).toISOString(),
        location: '',
        attendees: [],
        description: '',
        sourceUrl: ''
      }
    ]
    const { store, scheduler } = buildWith(events)
    await scheduler.fireCalendarBefore(new Date(t))
    const runs1 = store.listRuns().length
    const ntk1 = store.listNeedToKnow().length
    // Refire one minute later (still same day) → no duplicate.
    await scheduler.fireCalendarBefore(new Date(t + 60_000))
    expect(store.listRuns().length).toBe(runs1)
    expect(store.listNeedToKnow().length).toBe(ntk1)
  })
})
