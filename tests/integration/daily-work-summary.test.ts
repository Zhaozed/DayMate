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
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import type { CalendarEvent, CalendarProvider, DateRange } from '@shared/types'

// A calendar whose events are stable relative to wall-clock now — the agent
// stub computes "attended" (end <= now) and "tomorrow" from the same now, so
// the two agree (the test does not run across midnight).
class RelativeCalendar implements CalendarProvider {
  readonly provider = 'feishu' as const
  readonly accountId = 'rel-cal-001'
  private readonly events: CalendarEvent[]
  constructor() {
    const now = new Date()
    // "Attended" = a meeting that has already ended, regardless of when the
    // test runs (end = now − 2h, always in the past). The stub counts
    // attended as events with end <= Date.now(), so a fixed 10:00 today would
    // be in the future when run before 10:00 and yield attended=0.
    const attended = new Date(now.getTime() - 2 * 60 * 60_000) // 2h ago → ended
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0, 0, 0)
    this.events = [
      {
        provider: 'feishu',
        accountId: 'rel-cal-001',
        eventId: 'evt-attended',
        title: 'Standup',
        start: new Date(attended.getTime() - 30 * 60_000).toISOString(),
        end: attended.toISOString(),
        location: '',
        attendees: [],
        description: '',
        sourceUrl: ''
      },
      {
        provider: 'feishu',
        accountId: 'rel-cal-001',
        eventId: 'evt-tomorrow',
        title: 'Tomorrow planning',
        start: tomorrow.toISOString(),
        end: new Date(tomorrow.getTime() + 60 * 60_000).toISOString(),
        location: '',
        attendees: [],
        description: '',
        sourceUrl: ''
      }
    ]
  }
  async listEvents(_range: DateRange): Promise<CalendarEvent[]> {
    // Return all seeded events. This stub verifies the SUMMARY logic
    // (counts / waiting / tomorrow / no productivity inference), not the
    // calendar range filtering — which is unit-tested in tool-registry.
    // Returning all events makes the test independent of the day-of-week:
    // on a Saturday, `this_week` (Sun→Sat) would otherwise exclude
    // tomorrow's (Sunday's) meeting, flakily dropping tomorrowHighlights.
    return this.events
  }
  async getEvent(eventId: string): Promise<CalendarEvent> {
    const ev = this.events.find((x) => x.eventId === eventId)
    if (!ev) throw new Error(`Event not found: ${eventId}`)
    return ev
  }
}

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
    emailProviders: [new MockEmailProvider()],
    calendarProvider: new RelativeCalendar(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps }
}

describe('daily work summary routine (Spec §13.4)', () => {
  it('summarizes handled work: emails, tasks, attended meetings, waiting, tomorrow — no productivity inference', async () => {
    const { engine, store, deps } = buildEngine()
    seedPresets(store)

    // Seed a couple of tasks the user/agent already created today (one done,
    // one waiting) so the summary reflects real handled data.
    deps.taskService.create({
      title: 'Reply to Alice',
      sourceType: 'email',
      sourceId: 'gmail:mock-msg-001',
      priority: 'high'
    })
    const waiting = deps.taskService.create({
      title: 'Awaiting Bob sign-off',
      sourceType: 'assistant',
      priority: 'medium'
    })
    // Move it to waiting via the task service.
    deps.taskService.update(waiting.id, { status: 'waiting' })

    const run = await engine.run('daily_work_summary', { idempotencyKey: 'dws-1' })
    expect(run.status).toBe('completed')

    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    const s = ntk[0]
    expect(s.title).toBe('今日工作总结')
    // The summary is built from counts — no productivity/slacking language.
    expect(s.summary).toMatch(/处理了 \d+ 封邮件/)
    expect(s.summary).not.toMatch(/productiv|slacking|idle time|效率|摸鱼|闲置|工作时长/)
    // Reason explicitly recaps handled work (Spec §13.4 scope).
    expect(s.summary).toContain('参加了')

    // The structured fields are surfaced as the NTK body too. Inspect the raw
    // agent output via the run step outputs to verify the counts and fields.
    const finalRun = store.getRun(run.id)!
    const summary = finalRun.stepOutputs['summary'] as {
      processedEmails: number
      tasksCreated: number
      tasksCompleted: number
      meetingsAttended: number
      waitingItems: string[]
      tomorrowHighlights: string[]
    }
    expect(summary.processedEmails).toBeGreaterThan(0)
    expect(summary.tasksCreated).toBeGreaterThanOrEqual(1)
    expect(summary.meetingsAttended).toBe(1)
    expect(summary.waitingItems.some((w) => w.includes('Bob'))).toBe(true)
    expect(summary.tomorrowHighlights.some((t) => t.includes('Tomorrow planning'))).toBe(true)
  })

  it('a re-run with the same idempotency key is a no-op (no duplicate NTK)', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    await engine.run('daily_work_summary', { idempotencyKey: 'dws-dup' })
    const ntk1 = store.listNeedToKnow().length
    const runs1 = store.listRuns().length
    const run2 = await engine.run('daily_work_summary', { idempotencyKey: 'dws-dup' })
    expect(run2.status).toBe('completed')
    expect(store.listNeedToKnow().length).toBe(ntk1)
    expect(store.listRuns().length).toBe(runs1)
  })
})
