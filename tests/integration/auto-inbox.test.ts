import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockMail163Provider } from '../../src/main/providers/email/mock-mail163-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'

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
    memory: new Map(),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps }
}

describe('auto inbox', () => {
  it('classifies across two providers, creates tasks, publishes NTK, ignores injection', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const run = await engine.run('auto_inbox', { idempotencyKey: 'ai-1' })
    expect(run.status).toBe('completed')

    // Tasks were created — only for actionable (non-ignore) emails, deduped by
    // sourceId = "provider:messageId". The two SPAM/injection fixtures must
    // NOT have produced tasks.
    const tasks = store.listTasks()
    expect(tasks.length).toBeGreaterThan(0)
    // mock-msg-003 (Gmail SPAM) and mock-163-003 (163 SPAM) never produce tasks.
    expect(tasks.every((t) => !t.sourceId?.includes('mock-msg-003'))).toBe(true)
    expect(tasks.every((t) => !t.sourceId?.includes('mock-163-003'))).toBe(true)
    // And they're from the email source.
    expect(tasks.every((t) => t.sourceType === 'email')).toBe(true)

    // A Need to Know summarizing the buckets was published.
    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    expect(ntk[0].title).toBe('Inbox classified')

    // Activity captured every step.
    const events = store.listActivity(run.id)
    expect(events.some((e) => e.type === 'routine_started')).toBe(true)
    expect(events.some((e) => e.type === 'routine_completed')).toBe(true)
    expect(events.some((e) => e.type === 'tool_requested' && e.summary.includes('email.list'))).toBe(true)
  })

  it('a re-run with the same idempotency key duplicates nothing', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const run1 = await engine.run('auto_inbox', { idempotencyKey: 'ai-dup' })
    expect(run1.status).toBe('completed')
    const tasksAfter1 = store.listTasks().length
    const ntkAfter1 = store.listNeedToKnow().length
    const runsAfter1 = store.listRuns().length

    // Re-run with the SAME key → the existing run is returned, no re-execution.
    const run2 = await engine.run('auto_inbox', { idempotencyKey: 'ai-dup' })
    expect(run2.id).toBe(run1.id)
    expect(store.listTasks().length).toBe(tasksAfter1)
    expect(store.listNeedToKnow().length).toBe(ntkAfter1)
    expect(store.listRuns().length).toBe(runsAfter1)
  })

  it('the deterministic classifier marks SPAM/injection fixtures untrusted + ignore', async () => {
    const { runAgentStep } = await import('../../src/main/agent/agent-runtime')
    const { MockEmailProvider } = await import('../../src/main/providers/email/mock-email-provider')
    const { MockMail163Provider } = await import('../../src/main/providers/email/mock-mail163-provider')
    const gmail = new MockEmailProvider()
    const mail163 = new MockMail163Provider()
    const gmailEmails = await gmail.listMessages({})
    const mail163Emails = await mail163.listMessages({})
    const out = (await runAgentStep('classify_inbox', { gmailEmails, mail163Emails })) as {
      results: Array<{ messageId: string; classification: string; untrusted: boolean }>
      counts: Record<string, number>
    }
    // Both injection fixtures classified ignore + untrusted.
    const gmailSpam = out.results.find((r) => r.messageId === 'mock-msg-003')
    const mail163Spam = out.results.find((r) => r.messageId === 'mock-163-003')
    expect(gmailSpam?.classification).toBe('ignore')
    expect(gmailSpam?.untrusted).toBe(true)
    expect(mail163Spam?.classification).toBe('ignore')
    expect(mail163Spam?.untrusted).toBe(true)
    // No suggested action on untrusted items.
    // Counts include at least the ignore bucket.
    expect(out.counts.ignore).toBeGreaterThanOrEqual(2)
  })
})
