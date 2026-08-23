import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import type { EmailProvider } from '../../src/main/providers/email/email-provider'
import type { NormalizedEmail, EmailSyncCursor } from '@shared/types'

// Incremental cursor behavior: the per-provider high-water-mark ensures the
// classify agent only runs on NEW mail (token-cost control), and the cursor is
// advanced + persisted by the caller (container). These tests anchor the
// service half of that contract: given a cursor, only mail past it is fetched,
// and an empty delta short-circuits the agent entirely.

function makeService(): ApplicationService {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  return new ApplicationService(store, new MockBossProvider(), activity)
}

// A counting runtime — records every classify_application_email call so the
// tests can assert "agent not invoked when there is no new mail".
function countingRuntime(): {
  rt: { runAgentStep: (a: string, i: Record<string, unknown>) => Promise<unknown> }
  count: () => number
} {
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

function gmailProvider(emails: NormalizedEmail[]): EmailProvider {
  return {
    provider: 'gmail',
    accountId: 'gmail-test',
    async connect() {
      return { provider: 'gmail', accountId: 'gmail-test', status: 'connected' }
    },
    async disconnect() {},
    async getStatus() {
      return 'connected' as const
    },
    async listMessages(q) {
      let items = [...emails]
      if (q.sinceInternalDate) {
        items = items.filter((m) => new Date(m.receivedAt).getTime() > q.sinceInternalDate!)
      }
      if (q.limit) items = items.slice(0, q.limit)
      return items
    },
    async getMessage(id) {
      return emails.find((e) => e.messageId === id)!
    },
    async searchMessages() {
      return emails
    },
    async listSent() {
      return []
    },
    async createDraft() {
      throw new Error('not implemented')
    },
    async sendDraft() {
      throw new Error('not implemented')
    }
  }
}

function mail163Provider(emails: NormalizedEmail[]): EmailProvider {
  return {
    provider: 'mail163',
    accountId: 'mail163-test',
    async connect() {
      return { provider: 'mail163', accountId: 'mail163-test', status: 'connected' }
    },
    async disconnect() {},
    async getStatus() {
      return 'connected' as const
    },
    async listMessages(q) {
      let items = [...emails]
      if (q.sinceUid) {
        items = items.filter((m) => {
          const uid = Number(m.messageId)
          return Number.isFinite(uid) && uid > q.sinceUid!
        })
      }
      if (q.limit) items = items.slice(0, q.limit)
      return items
    },
    async getMessage(id) {
      return emails.find((e) => e.messageId === id)!
    },
    async searchMessages() {
      return emails
    },
    async listSent() {
      return []
    },
    async createDraft() {
      throw new Error('not implemented')
    },
    async sendDraft() {
      throw new Error('not implemented')
    }
  }
}

function makeEmail(opts: {
  messageId: string
  receivedAt: string
  fromName?: string
  subject: string
  body: string
}): NormalizedEmail {
  return {
    provider: 'gmail',
    accountId: 'gmail-test',
    messageId: opts.messageId,
    from: { address: 'recruit@example.com', name: opts.fromName ?? '' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    subject: opts.subject,
    textBody: opts.body,
    receivedAt: opts.receivedAt,
    unread: false, // already-read mail must STILL be caught (cursor is the gate)
    labels: []
  }
}

describe('email sync — incremental cursor', () => {
  it('advances the gmail cursor to the latest internalDate and skips already-processed mail', async () => {
    const svc = makeService()
    const { rt, count } = countingRuntime()
    const emails = [
      makeEmail({
        messageId: 'g1',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromName: '字节跳动招聘',
        subject: '面试:后端',
        body: '字节跳动 面试邀请'
      })
    ]
    const provider = gmailProvider(emails)
    const r1 = await svc.syncFromEmails([provider], rt, {})
    expect(r1.synced + r1.created).toBeGreaterThan(0)
    expect(r1.cursor.gmailLastInternalDate).toBe(new Date('2026-08-10T10:00:00.000Z').getTime())

    // Second sync with the advanced cursor → no new mail → agent not called.
    const before = count()
    const r2 = await svc.syncFromEmails([provider], rt, r1.cursor)
    expect(count()).toBe(before) // no new classify call
    expect(r2.synced).toBe(0)
    expect(r2.created).toBe(0)
    expect(r2.message).toContain('无新邮件')
  })

  it('only processes mail past the cursor when a new email arrives', async () => {
    const svc = makeService()
    const { rt } = countingRuntime()
    const emails = [
      makeEmail({
        messageId: 'g1',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromName: '字节跳动招聘',
        subject: '面试:后端',
        body: '字节跳动 面试邀请'
      }),
      makeEmail({
        messageId: 'g2',
        receivedAt: '2026-08-10T11:00:00.000Z',
        fromName: '美团招聘',
        subject: '面试:Go',
        body: '美团 面试邀请'
      })
    ]
    const provider = gmailProvider(emails)
    // Cursor set just before g2 → only g2 is fetched.
    const cursor: EmailSyncCursor = {
      gmailLastInternalDate: new Date('2026-08-10T10:00:00.000Z').getTime()
    }
    const res = await svc.syncFromEmails([provider], rt, cursor)
    expect(res.created).toBe(1)
    // The pre-cursor email was NOT reprocessed → no 字节跳动 application.
    expect(svc.list().some((v) => v.application.company === '字节跳动')).toBe(false)
    expect(svc.list().some((v) => v.application.company === '美团')).toBe(true)
  })

  it('mail163 advances the UID cursor and filters by UID > last', async () => {
    const svc = makeService()
    const { rt } = countingRuntime()
    // Numeric messageId = IMAP UID (mirrors the real mail163 path).
    const emails = [
      makeEmail({
        messageId: '100',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromName: '字节跳动招聘',
        subject: '面试:后端',
        body: '字节跳动 面试邀请'
      })
    ]
    const provider = mail163Provider(emails)
    const r1 = await svc.syncFromEmails([provider], rt, {})
    expect(r1.cursor.mail163LastUid).toBe(100)
    expect(r1.created).toBe(1)

    // Second sync → UID 100 filtered out (not > 100) → no new mail.
    const r2 = await svc.syncFromEmails([provider], rt, r1.cursor)
    expect(r2.created).toBe(0)
    expect(r2.message).toContain('无新邮件')
  })

  it('already-read mail is still caught when past the cursor (unreadOnly is not the gate)', async () => {
    const svc = makeService()
    const { rt } = countingRuntime()
    const emails = [
      makeEmail({
        messageId: 'g-rd',
        receivedAt: '2026-08-10T12:00:00.000Z',
        fromName: '字节跳动招聘',
        subject: '面试:后端',
        body: '字节跳动 面试邀请'
      })
    ]
    // unread:false above — the cursor (empty) must still pick it up.
    const res = await svc.syncFromEmails([gmailProvider(emails)], rt, {})
    expect(res.created).toBe(1)
  })

  it('empty inbox → agent not called, cursor returned unchanged', async () => {
    const svc = makeService()
    const { rt, count } = countingRuntime()
    const before = count()
    const res = await svc.syncFromEmails([gmailProvider([])], rt, {})
    expect(count()).toBe(before)
    expect(res.synced).toBe(0)
    expect(res.created).toBe(0)
    expect(res.message).toContain('无新邮件')
  })
})

// A bulk-aware email builder (ADR 0023 funnel pre-filter tests).
function makeBulkEmail(opts: {
  messageId: string
  receivedAt: string
  fromAddress: string
  fromName?: string
  subject: string
  body: string
  bulk?: boolean
}): NormalizedEmail {
  return {
    provider: 'mail163',
    accountId: 'mail163-test',
    messageId: opts.messageId,
    from: { address: opts.fromAddress, name: opts.fromName ?? '' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    subject: opts.subject,
    textBody: opts.body,
    receivedAt: opts.receivedAt,
    unread: false,
    labels: [],
    bulk: opts.bulk ?? true
  }
}

describe('email sync — 群发预过滤（漏斗路径, ADR 0023）', () => {
  it('pure-marketing bulk (ads keywords) → classify_application_email NOT called, no 投递', async () => {
    const svc = makeService()
    const { rt, count } = countingRuntime()
    const before = count()
    const emails = [
      makeBulkEmail({
        messageId: '500',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromAddress: 'noreply@career-weekly.com',
        subject: '本周热门职位推荐 限时优惠',
        body: '点击查看更多职位。如不想收到请退订 unsubscribe。'
      })
    ]
    const res = await svc.syncFromEmails([mail163Provider(emails)], rt, {})
    expect(count()).toBe(before) // pure ads bulk skipped before LLM
    expect(res.created).toBe(0)
    expect(svc.list().length).toBe(0)
  })

  it('bulk application-confirmation (投递成功, not ads) → KEPT → classified (not dropped)', async () => {
    const svc = makeService()
    const { rt, count } = countingRuntime()
    const before = count()
    const emails = [
      makeBulkEmail({
        messageId: '501',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromAddress: 'noreply@zhipuai.com',
        fromName: '智谱AI招聘',
        subject: '投递成功 — 后端工程师',
        body: '已收到您的简历，HR 将尽快审阅。'
      })
    ]
    const res = await svc.syncFromEmails([mail163Provider(emails)], rt, {})
    // 投递确认 is bulk but NOT ads → funnel keeps it → classify_application_email ran.
    expect(count()).toBeGreaterThan(before)
    // It was processed (synced/created/pending) — NOT silently dropped by the pre-filter.
    expect(res.synced + res.created + res.pending).toBeGreaterThan(0)
  })

  it('mixed delta: ads bulk skipped, 投递确认 bulk kept', async () => {
    const svc = makeService()
    const { rt, count } = countingRuntime()
    const before = count()
    const emails = [
      makeBulkEmail({
        messageId: '502',
        receivedAt: '2026-08-10T09:00:00.000Z',
        fromAddress: 'noreply@edm.com',
        subject: '招聘周报 限时优惠',
        body: '退订 unsubscribe'
      }),
      makeBulkEmail({
        messageId: '503',
        receivedAt: '2026-08-10T10:00:00.000Z',
        fromAddress: 'noreply@zhipuai.com',
        fromName: '智谱AI招聘',
        subject: '投递成功 — 后端工程师',
        body: '已收到您的简历'
      })
    ]
    const res = await svc.syncFromEmails([mail163Provider(emails)], rt, {})
    // classify ran exactly once — on the kept 投递确认 (the ads edm was filtered out).
    expect(count()).toBe(before + 1)
    // The kept email was processed; the ads edm produced nothing.
    expect(res.synced + res.created + res.pending).toBeGreaterThan(0)
    expect(svc.list().some((v) => v.application.company === '招聘周报')).toBe(false)
  })
})

