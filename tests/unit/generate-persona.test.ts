import { describe, it, expect } from 'vitest'
import { MemoryService } from '../../src/main/services/memory-service'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import type { EmailProvider, NormalizedEmail } from '@shared/types'
import type { EmailProvider as IEmailProvider } from '../../src/main/providers/email/email-provider'

// Persona inference (§16 town-style profile). The `generate_persona` agent
// step reads the user's OWN sent mail (trusted voice, framed by
// frameSentReply — the opposite of §17-untrusted inbound) + confirmed memory,
// and proposes persona / writing_style / email_tone / working_hours items.
// Each proposal lands `confirmed:false`; the user confirms on the Memory page.
// On-demand manual AI — NOT via the routine engine (mirrors generateResume).

/** A minimal fake email provider whose `listSent` returns a fixed corpus. */
function fakeProvider(sent: NormalizedEmail[]): EmailProvider {
  return {
    provider: 'gmail',
    accountId: 'test-acct',
    async connect() {
      return { accountId: 'test-acct', status: 'connected', displayName: 'Test' } as never
    },
    async disconnect() {},
    async getStatus() {
      return 'connected' as const
    },
    async listMessages() {
      return []
    },
    async getMessage() {
      return {} as never
    },
    async searchMessages() {
      return []
    },
    async listSent() {
      return sent
    },
    async createDraft() {
      return {} as never
    },
    async sendDraft() {
      return {} as never
    }
  } as IEmailProvider as EmailProvider
}

function sentAt(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString()
}

describe('MemoryService.generatePersona — on-demand persona inference', () => {
  it('returns a no-proposal summary when no sent mail is available', async () => {
    const store = new InMemoryStore()
    const service = new MemoryService(store)
    const output = await service.generatePersona(
      [fakeProvider([])],
      createDeterministicAgentRuntime()
    )
    expect(output.memoryProposals).toBeUndefined()
    expect(output.summary).toContain('尚未观察')
    // Nothing persisted.
    expect(store.listMemory().length).toBe(0)
  })

  it('auto-confirms persona / writing_style / email_tone / working_hours from a formal corpus', async () => {
    const sent: NormalizedEmail[] = [
      {
        provider: 'gmail',
        accountId: 'test-acct',
        messageId: 's1',
        threadId: 't1',
        from: { name: 'Me', address: 'me@x.com' },
        to: [{ name: 'Prof', address: 'prof@uni.edu' }],
        cc: [],
        subject: 'Re: thesis',
        textBody:
          'Dear Prof, thank you for the feedback. I will revise accordingly. Best regards.',
        receivedAt: sentAt(2),
        unread: false,
        labels: ['SENT'],
        sourceUrl: ''
      }
    ]
    const store = new InMemoryStore()
    const service = new MemoryService(store)
    const output = await service.generatePersona(
      [fakeProvider(sent)],
      createDeterministicAgentRuntime()
    )
    expect(output.memoryProposals?.length).toBeGreaterThan(0)
    // All proposals are persona-family keys.
    const keys = new Set(output.memoryProposals!.map((p) => p.key))
    for (const k of keys) {
      expect(['persona', 'writing_style', 'email_tone', 'working_hours']).toContain(k)
    }
    // Proposals auto-confirm — immediately active and searchable (no 待确认).
    const mem = store.listMemory()
    expect(mem.length).toBeGreaterThan(0)
    expect(mem.every((m) => m.confirmed)).toBe(true)
    expect(service.search('推断').length).toBeGreaterThan(0)
  })

  it('does not clobber a user-authored key (merge, not overwrite)', async () => {
    const sent: NormalizedEmail[] = [
      {
        provider: 'gmail',
        accountId: 'test-acct',
        messageId: 's1',
        threadId: 't1',
        from: { name: 'Me', address: 'me@x.com' },
        to: [{ name: 'Prof', address: 'prof@uni.edu' }],
        cc: [],
        subject: 'Re: thesis',
        textBody: 'Dear Prof, thanks. Best regards.',
        receivedAt: sentAt(2),
        unread: false,
        labels: ['SENT'],
        sourceUrl: ''
      }
    ]
    const store = new InMemoryStore()
    const service = new MemoryService(store)
    // The user manually authored writing_style — the stub must skip it
    // (user truth) and save() must not overwrite it.
    const userItem = service.save({ key: 'writing_style', value: '我手动填的风格', source: 'user' })
    const output = await service.generatePersona(
      [fakeProvider(sent)],
      createDeterministicAgentRuntime()
    )
    // The stub did not emit a proposal for the user-owned key.
    expect(output.memoryProposals?.map((p) => p.key)).not.toContain('writing_style')
    // The user's value is intact (not overwritten by the agent).
    const after = store.listMemory().find((m) => m.key === 'writing_style')
    expect(after?.id).toBe(userItem.id)
    expect(after?.value).toBe('我手动填的风格')
  })

  it('gracefully handles a down provider (others still contribute)', async () => {
    const goodSent: NormalizedEmail[] = [
      {
        provider: 'gmail',
        accountId: 'good',
        messageId: 'g1',
        threadId: 'gt1',
        from: { name: 'Me', address: 'me@x.com' },
        to: [{ name: 'Bob', address: 'bob@x.com' }],
        cc: [],
        subject: 'Re: hey',
        textBody: 'Hi Bob, got it, will do. Thanks!',
        receivedAt: sentAt(3),
        unread: false,
        labels: ['SENT'],
        sourceUrl: ''
      }
    ]
    const throwingProvider: EmailProvider = {
      provider: 'mail163',
      accountId: 'bad',
      async connect() {
        throw new Error('down')
      },
      async disconnect() {},
      async getStatus() {
        return 'error' as const
      },
      async listMessages() {
        throw new Error('down')
      },
      async getMessage() {
        throw new Error('down')
      },
      async searchMessages() {
        throw new Error('down')
      },
      async listSent() {
        throw new Error('163 IMAP unavailable')
      },
      async createDraft() {
        throw new Error('down')
      },
      async sendDraft() {
        throw new Error('down')
      }
    } as unknown as EmailProvider

    const store = new InMemoryStore()
    const service = new MemoryService(store)
    const output = await service.generatePersona(
      [throwingProvider, fakeProvider(goodSent)],
      createDeterministicAgentRuntime()
    )
    // The good provider's mail still drove proposals (auto-confirmed).
    expect(output.memoryProposals?.length).toBeGreaterThan(0)
    expect(store.listMemory().length).toBeGreaterThan(0)
    expect(store.listMemory().every((m) => m.confirmed)).toBe(true)
  })

  it('a second generate updates in place — no duplicate rows per key', async () => {
    const sent: NormalizedEmail[] = [
      {
        provider: 'gmail',
        accountId: 'test-acct',
        messageId: 's1',
        threadId: 't1',
        from: { name: 'Me', address: 'me@x.com' },
        to: [{ name: 'Prof', address: 'prof@uni.edu' }],
        cc: [],
        subject: 'Re: thesis',
        textBody: 'Dear Prof, thanks. Best regards.',
        receivedAt: sentAt(2),
        unread: false,
        labels: ['SENT'],
        sourceUrl: ''
      }
    ]
    const store = new InMemoryStore()
    const service = new MemoryService(store)
    const p = fakeProvider(sent)
    await service.generatePersona([p], createDeterministicAgentRuntime())
    await service.generatePersona([p], createDeterministicAgentRuntime())
    // One confirmed value per key (save updates in place, does not accumulate).
    const all = store.listMemory()
    expect(all.every((m) => m.confirmed)).toBe(true)
    const byKey = new Map<string, number>()
    for (const m of all) byKey.set(m.key, (byKey.get(m.key) ?? 0) + 1)
    for (const count of byKey.values()) expect(count).toBe(1)
  })
})
