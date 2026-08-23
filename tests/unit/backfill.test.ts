import { describe, it, expect, vi } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { EmailBriefingService } from '../../src/main/services/email-briefing-service'
import type { NormalizedEmail, EmailProvider } from '@shared/types'

// Minimal mock agent runtime: records every classify_inbox call's input and
// returns one todo-bearing result per email (so tasksCreated counts work).
function makeAgentRuntime() {
  const calls: { action: string; emails: NormalizedEmail[] }[] = []
  const rt = {
    async runAgentStep(action: string, input: { emails: NormalizedEmail[] }): Promise<unknown> {
      if (action === 'classify_inbox') {
        calls.push({ action, emails: input.emails })
        return {
          results: input.emails.map((e) => ({
            provider: e.provider,
            accountId: e.accountId,
            messageId: e.messageId,
            classification: 'reply',
            topic: 'general',
            untrusted: false,
            reason: '期待回复',
            todoTitle: `回复 ${e.from.name ?? '发件人'}`,
            category: 'other'
          })),
          counts: { reply: input.emails.length, ignore: 0, follow_up: 0 }
        }
      }
      throw new Error(`unexpected action ${action}`)
    }
  }
  return { rt, calls }
}

function realEmail(id: string, over: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: 'gmail',
    accountId: 'gmail-real',
    messageId: id,
    threadId: 't',
    from: { name: 'Alice', address: 'alice@x.com' },
    to: [{ address: 'me@x.com' }],
    cc: [],
    subject: 'plain subject',
    textBody: 'body',
    receivedAt: new Date().toISOString(),
    unread: true,
    labels: [],
    sourceUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
    ...over
  }
}

// Minimal provider: listBackfill returns a fixed array; cast as EmailProvider.
function makeProvider(emails: NormalizedEmail[]): EmailProvider {
  return {
    provider: 'gmail',
    accountId: 'gmail-real',
    listBackfill: async () => emails
  } as unknown as EmailProvider
}

function makeBriefing(skipTokens?: string[]): {
  briefing: EmailBriefingService
  tasks: TaskService
  calls: { action: string; emails: NormalizedEmail[] }[]
} {
  const store = new InMemoryStore()
  const tasks = new TaskService(store)
  const ntk = new NeedToKnowService(store)
  const activity = new ActivityService(store)
  const { rt, calls } = makeAgentRuntime()
  const briefing = new EmailBriefingService({
    agentRuntime: rt as unknown as never,
    needToKnowService: ntk,
    toolRegistry: { execute: vi.fn() } as unknown as never,
    memoryService: { list: () => [] } as unknown as never,
    emailProviders: [],
    activityService: activity,
    toolContext: {} as never,
    taskService: tasks,
    onTasksChanged: () => {},
    skipTokens
  })
  return { briefing, tasks, calls }
}

describe('EmailBriefingService.backfillAccount (ADR 0027 cold-start)', () => {
  it('passes a ~60-day sinceDate to listBackfill (newest-first provider contract)', async () => {
    const emails = [realEmail('a')]
    const { briefing } = makeBriefing()
    const provider = {
      provider: 'gmail',
      accountId: 'gmail-real',
      listBackfill: vi.fn(async () => emails)
    } as unknown as EmailProvider
    await briefing.backfillAccount(provider)
    const since = (provider as unknown as { listBackfill: ReturnType<typeof vi.fn> }).listBackfill
      .mock.calls[0][0] as Date
    expect(since).toBeInstanceOf(Date)
    expect(Date.now() - since.getTime()).toBeGreaterThan(59 * 86_400_000)
    expect(Date.now() - since.getTime()).toBeLessThan(61 * 86_400_000)
  })

  it('chunks into batches of batchSize — ONE classify call per batch', async () => {
    const emails = Array.from({ length: 50 }, (_, i) => realEmail(`m${i}`))
    const { briefing, calls } = makeBriefing()
    await briefing.backfillAccount(makeProvider(emails), { batchSize: 20 })
    expect(calls).toHaveLength(3) // 20 + 20 + 10
    expect(calls[0].emails).toHaveLength(20)
    expect(calls[2].emails).toHaveLength(10)
  })

  it('filters [student_ips] school spam BEFORE the LLM (never reaches classify)', async () => {
    const spam = realEmail('spam-1', {
      subject: '[student_ips] 学院周知',
      from: { name: 'Mailman', address: 'list@school.edu' }
    })
    const real = realEmail('real-1', { subject: 'Re: 面试' })
    const { briefing, calls } = makeBriefing(['[student_ips]'])
    const r = await briefing.backfillAccount(makeProvider([spam, real]), { batchSize: 20 })
    expect(calls).toHaveLength(1)
    expect(calls[0].emails.map((e) => e.messageId)).toEqual(['real-1'])
    expect(r.scanned).toBe(2) // scanned counts all fetched; surfaced/todo by filtered
    expect(r.tasksCreated).toBe(1)
  })

  it('skips drafts during backfill (skipDrafts — no generate_draft_reply call)', async () => {
    let draftCalled = false
    const localRt = {
      async runAgentStep(action: string, input: { emails: NormalizedEmail[] }): Promise<unknown> {
        if (action === 'classify_inbox') {
          return {
            results: input.emails.map((e) => ({
              messageId: e.messageId,
              classification: 'reply',
              topic: 'recruiting', // important + reply → would draft in normal loop
              untrusted: false,
              todoTitle: '回复 ' + (e.from.name ?? 'X'),
              category: 'job'
            })),
            counts: {}
          }
        }
        if (action === 'generate_draft_reply') {
          draftCalled = true
          return {}
        }
        throw new Error(`unexpected ${action}`)
      }
    }
    // Rebuild briefing with the draft-spying runtime.
    const store = new InMemoryStore()
    const briefing2 = new EmailBriefingService({
      agentRuntime: localRt as unknown as never,
      needToKnowService: new NeedToKnowService(store),
      toolRegistry: { execute: vi.fn() } as unknown as never,
      memoryService: { list: () => [] } as unknown as never,
      emailProviders: [],
      activityService: new ActivityService(store),
      toolContext: {} as never,
      taskService: new TaskService(store),
      onTasksChanged: () => {}
    })
    await briefing2.backfillAccount(makeProvider([realEmail('r1')]), { batchSize: 20 })
    expect(draftCalled).toBe(false)
  })

  it('marks a task per filtered email with category + sourceLink (Gmail)', async () => {
    const { briefing, tasks } = makeBriefing()
    await briefing.backfillAccount(
      makeProvider([realEmail('g1', { subject: 'Re: 面试' })]),
      { batchSize: 20 }
    )
    const t = tasks.list().find((x) => x.sourceId === 'email:g1')
    expect(t).toBeDefined()
    expect(t?.category).toBe('other')
    expect(t?.sourceLink).toBe('https://mail.google.com/mail/u/0/#all/g1')
    expect(t?.sourceProvider).toBe('gmail')
  })

  it('is idempotent — re-running does not duplicate tasks (sourceId dedup)', async () => {
    const { briefing, tasks } = makeBriefing()
    const provider = makeProvider([realEmail('dup-1')])
    await briefing.backfillAccount(provider, { batchSize: 20 })
    await briefing.backfillAccount(provider, { batchSize: 20 })
    expect(tasks.list().filter((t) => t.sourceId === 'email:dup-1')).toHaveLength(1)
  })
})

describe('GmailProvider.listAllSince paging (ADR 0027)', () => {
  it('pages through nextPageToken and stops at the internalDate boundary', async () => {
    // Drive the pure helper against a mocked http + token store. We exercise
    // listAllSince directly via a minimal GmailProvider shim that overrides
    // gmailGet to return canned pages.
    const { GmailProvider } = await import('../../src/main/providers/email/gmail-provider')
    const now = Date.now()
    const boundary = now - 60 * 86_400_000 // 60d ago
    // Page 1: 2 new (internalDate > boundary), pageToken → page2.
    // Page 2: 1 new + 1 old (<= boundary) → stop, no page3.
    const page1 = {
      messages: [
        { id: 'a', threadId: 'ta' },
        { id: 'b', threadId: 'tb' }
      ],
      nextPageToken: 'tok2'
    }
    const page2 = {
      messages: [
        { id: 'c', threadId: 'tc' },
        { id: 'd', threadId: 'td' }
      ]
      // no nextPageToken → end
    }
    const msgById: Record<string, { internalDate: string }> = {
      a: { internalDate: String(now - 1 * 86_400_000) },
      b: { internalDate: String(now - 5 * 86_400_000) },
      c: { internalDate: String(now - 30 * 86_400_000) }, // newer than boundary
      d: { internalDate: String(boundary - 86_400_000) } // older → boundary hit
    }
    const seenPaths: string[] = []
    const provider = new GmailProvider({
      secrets: {
        readKey: async () => JSON.stringify({ accessToken: 'tok', expiresAt: now + 99999 }),
        save: async () => {},
        has: async () => true,
        delete: async () => {},
        readKeySync: () => '',
        hasSync: () => false,
        list: () => []
      } as never,
      openExternal: async () => {},
      fetch: (async (url: string) => {
        seenPaths.push(url)
        if (url.includes('/messages/')) {
          const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? ''
          return {
            ok: true,
            json: async () => ({ id, internalDate: msgById[id]?.internalDate })
          }
        }
        // list endpoint: page by pageToken presence
        const hasTok2 = url.includes('pageToken=tok2')
        return { ok: true, json: async () => (hasTok2 ? page2 : page1) }
      }) as never
    })
    const out = await provider.listAllSince(boundary, 20)
    expect(out.map((e) => e.messageId).sort()).toEqual(['a', 'b', 'c'])
    // d is the boundary message — fetched but not included.
    expect(seenPaths.some((p) => p.includes('/messages/d'))).toBe(true)
  })
})
