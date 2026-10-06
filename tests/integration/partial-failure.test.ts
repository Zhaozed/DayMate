import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import type { EmailProvider, EmailQuery, NormalizedEmail } from '@shared/types'

// Spec M3 partial-failure: a down provider does not kill the mail-driven
// funnel. The container's email sync loop calls `syncFromEmails` with every
// connected provider; a provider whose `listMessages` throws is caught inside
// the service, recorded as a `provider_unavailable` Activity, and the other
// provider's mail is still classified + built into 投递. (Originally anchored
// on the `auto_inbox` routine — ADR 0024 retired it; the sync loop now owns
// this path, so the partial-failure guarantee is re-anchored here.)

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

function countingRuntime() {
  let n = 0
  const rt = {
    runAgentStep: async (a: string, i: Record<string, unknown>) => {
      n++
      const { runAgentStep } = await import('../../src/main/agent/agent-runtime')
      return runAgentStep(a, i)
    }
  }
  return { rt, count: () => n }
}

describe('partial failure — one provider down (sync loop)', () => {
  it('records provider_unavailable, still builds 投递 from the surviving provider', async () => {
    const store = new InMemoryStore()
    const activity = new ActivityService(store)
    const svc = new ApplicationService(store, activity)
    const { rt } = countingRuntime()
    // Gmail works; 163 throws.
    const providers: EmailProvider[] = [
      new MockEmailProvider(),
      throwingProvider('mock-163-001')
    ]

    const res = await svc.syncFromEmails(providers, rt, {})
    // The run completes — Gmail mail was still classified + built.
    expect(res.synced + res.created + res.pending).toBeGreaterThan(0)

    // The 163 outage is surfaced as a provider_unavailable Activity event.
    const events = activity.list()
    const outage = events.find((e) => e.type === 'provider_unavailable')
    expect(outage).toBeDefined()
    expect(outage!.summary).toContain('163')
  })
})
