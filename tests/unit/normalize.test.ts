import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import { runAgentStep } from '../../src/main/agent/agent-runtime'
import type { EmailProvider } from '../../src/main/providers/email/email-provider'
import type { NormalizedEmail } from '@shared/types'

// The normalized company/position compare is the cross-message dedup safety
// net (the per-event sourceRef only dedupes the SAME email). These cases anchor
// that "字节跳动有限公司" vs "字节跳动" + same-position-normalized collapse to one
// application, while genuinely different positions at the same company stay
// separate funnel items.

const runtime = { runAgentStep: (a: string, i: Record<string, unknown>) => runAgentStep(a, i) }

function makeService(): ApplicationService {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  return new ApplicationService(store, new MockBossProvider(), activity)
}

function makeEmailProvider(emails: NormalizedEmail[]): EmailProvider {
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
    async listMessages() {
      return emails
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
    receivedAt: '2026-08-10T10:00:00.000Z',
    unread: true,
    labels: []
  }
}

describe('normalize dedup (company/position suffix stripping)', () => {
  it('"字节跳动有限公司" + "后端工程师" matches "字节跳动" + "后端"', async () => {
    const svc = makeService()
    svc.create({ company: '字节跳动有限公司', position: '后端工程师' })
    const res = await svc.syncFromEmails(
      [
        makeEmailProvider([
          makeEmail({
            messageId: 'n1',
            fromName: '字节跳动招聘',
            subject: '面试:后端',
            body: '字节跳动 面试邀请'
          })
        ])
      ],
      runtime
    )
    expect(res.created).toBe(0) // normalized hit → no new app
    expect(res.synced).toBe(1)
    expect(svc.list()).toHaveLength(1)
  })

  it('"字节跳动" + "后端" does NOT match "字节跳动" + "前端" (different positions stay separate)', async () => {
    const svc = makeService()
    svc.create({ company: '字节跳动', position: '后端' })
    const res = await svc.syncFromEmails(
      [
        makeEmailProvider([
          makeEmail({
            messageId: 'n2',
            fromName: '字节跳动招聘',
            subject: '面试:前端',
            body: '字节跳动 前端 面试邀请'
          })
        ])
      ],
      runtime
    )
    // Different position → aggressive create a separate item.
    expect(res.created).toBe(1)
    expect(svc.list()).toHaveLength(2)
  })

  it('English "Foo Inc." matches "Foo"', async () => {
    const svc = makeService()
    svc.create({ company: 'Foo Inc.', position: 'engineer' })
    const res = await svc.syncFromEmails(
      [
        makeEmailProvider([
          makeEmail({
            messageId: 'n3',
            fromName: 'Foo招聘',
            subject: 'position:engineer',
            body: 'Foo interview invitation'
          })
        ])
      ],
      runtime
    )
    expect(res.created).toBe(0)
    expect(res.synced).toBe(1)
    expect(svc.list()).toHaveLength(1)
  })
})
