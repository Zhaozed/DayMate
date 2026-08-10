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
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import type { EmailProvider, EmailQuery, NormalizedEmail } from '@shared/types'

// Spec M3 partial-failure: a down provider does not kill a routine. Auto Inbox
// marks its email.list steps `continueOnError`, so one provider throwing → the
// other is still triaged, a `provider_unavailable` Activity event is recorded,
// the run completes, and a Need to Know is published.

/** A provider whose `listMessages` always throws — simulates 163 being down. */
function throwingProvider(accountId: string): EmailProvider {
  return {
    provider: 'mail163',
    accountId,
    async connect() {
      throw new Error('163 down')
    },
    async disconnect() {},
    async getStatus() {
      return 'error' as const
    },
    async listMessages(_q: EmailQuery): Promise<NormalizedEmail[]> {
      throw new Error('163 IMAP unavailable: connection refused')
    },
    async getMessage() {
      throw new Error('163 down')
    },
    async searchMessages() {
      throw new Error('163 down')
    },
    async listSent() {
      throw new Error('163 down')
    },
    async createDraft() {
      throw new Error('163 down')
    },
    async sendDraft() {
      throw new Error('163 down')
    }
  } as EmailProvider
}

function buildEngine(providers: EmailProvider[]) {
  const store = new InMemoryStore()
  const deps: EngineDeps = {
    store,
    toolRegistry: createToolRegistry(),
    activityService: new ActivityService(store),
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    approvalService: new ApprovalService(store),
    emailProviders: providers,
    calendarProvider: new MockCalendarProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps }
}

describe('partial failure — one provider down', () => {
  it('records provider_unavailable, still triages the other provider, completes', async () => {
    // Gmail works; 163 (mock-163-001) throws.
    const { engine, store } = buildEngine([
      new MockEmailProvider(),
      throwingProvider('mock-163-001')
    ])
    seedPresets(store)

    const run = await engine.run('auto_inbox', { idempotencyKey: 'pf-1' })
    expect(run.status).toBe('completed')

    const events = store.listActivity(run.id)
    // The 163 outage is surfaced as a provider_unavailable event.
    expect(events.some((e) => e.type === 'provider_unavailable')).toBe(true)
    const outage = events.find((e) => e.type === 'provider_unavailable')!
    expect(outage.summary).toContain('163')

    // Gmail mail was still triaged — tasks created from the Gmail feed only.
    const tasks = store.listTasks()
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t) => t.sourceType === 'email')).toBe(true)

    // A Need to Know summarizing the buckets was still published.
    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    expect(ntk[0].title).toBe('收件箱已分类')

    // Agent step ran (classify) and completed despite one inbox missing.
    expect(events.some((e) => e.type === 'agent_completed')).toBe(true)
    expect(events.some((e) => e.type === 'routine_completed')).toBe(true)
    // No agent failure (the stub path ran fine on the single feed).
    expect(events.some((e) => e.type === 'agent_failed')).toBe(false)
  })
})
