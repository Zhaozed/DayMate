import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import type { NormalizedEmail, AgentRuntime } from '@shared/types'
import type { EmailProvider } from '../../src/main/providers/email/email-provider'
import { shouldSkipFunnel } from '../../src/main/util/bulk-mail'

function makeService(): { svc: ApplicationService; store: InMemoryStore; activity: ActivityService } {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const svc = new ApplicationService(store, activity)
  return { svc, store, activity }
}

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: 'gmail',
    accountId: 'acc1',
    messageId: 'msg_' + Math.random().toString(36).slice(2, 8),
    from: { name: '字节跳动招聘', address: 'campus-noreply@bytedance.com' },
    to: [{ name: 'Candidate', address: 'me@example.com' }],
    cc: [],
    subject: '字节跳动面试通知',
    textBody: '同学你好，邀请你参加视频面试。',
    receivedAt: new Date().toISOString(),
    unread: true,
    labels: ['INBOX'],
    sourceUrl: 'https://mail.google.com',
    ...overrides
  }
}

describe('Job Recruiting Scenarios & State Machine', () => {
  it('Scenario 17: detects multi-job ambiguity at the same company and routes to HITL pending queue with candidates', async () => {
    const { svc } = makeService()

    // User applied to TWO different positions at ByteDance
    const appFrontend = svc.create({ company: '字节跳动', position: '前端开发工程师', source: 'email' })
    const appFullstack = svc.create({ company: '字节跳动', position: '全栈开发工程师', source: 'email' })

    const email = makeEmail({
      subject: '字节跳动面试通知',
      textBody: '同学你好，恭喜进入面试环节，请准时参加。'
    })

    const mockRuntime = {
      runAgentStep: async () => ({
        results: [
          {
            messageId: email.messageId,
            eventType: 'interview' as const,
            company: '字节跳动',
            position: undefined, // Omitted in the email subject/body!
            confidence: 'high' as const,
            evidence: email.subject,
            untrusted: false,
            todoTitle: '字节跳动 面试',
            dueDate: '2026-10-15T14:00:00Z'
          }
        ],
        matched: 1,
        pending: 0,
        ignored: 0
      })
    } as unknown as AgentRuntime

    const mockEmailProvider = {
      provider: 'gmail' as const,
      listMessages: async () => [email]
    }

    const res = await svc.syncFromEmails([mockEmailProvider as unknown as EmailProvider], mockRuntime)

    // Should NOT auto-merge to either one, and should NOT auto-create a 3rd app
    expect(res.pending).toBe(1)
    expect(res.created).toBe(0)
    expect(res.synced).toBe(0)

    const pendingProposals = svc.listPendingEmailMatches()
    expect(pendingProposals).toHaveLength(1)
    expect(pendingProposals[0].candidateApplications).toHaveLength(2)
    expect(pendingProposals[0].candidateApplications?.map((c) => c.id)).toContain(appFrontend.application.id)
    expect(pendingProposals[0].candidateApplications?.map((c) => c.id)).toContain(appFullstack.application.id)

    // User confirms matching to Frontend via HITL
    svc.confirmEmailMatch(email.messageId, appFrontend.application.id)
    expect(svc.listPendingEmailMatches()).toHaveLength(0)

    const updatedFrontend = svc.get(appFrontend.application.id)
    expect(updatedFrontend?.events).toHaveLength(2) // applied + interview
    expect(updatedFrontend?.currentStatus).toBe('interview')
  })

  it('Scenario 09: handles Reschedule (改期) by updating the existing interview event instead of creating duplicates', async () => {
    const { svc } = makeService()

    const initialView = svc.create({ company: '美团', position: '后端研发', source: 'email' })
    svc.addEvent({
      applicationId: initialView.application.id,
      type: 'interview',
      round: 1,
      evidence: '初试时间: 2026-10-10 10:00'
    })

    const rescheduleEmail = makeEmail({
      from: { name: '美团招聘', address: 'hr-noreply@meituan.com' },
      subject: '美团后端研发面试时间调整通知 (改期)',
      textBody: '同学你好，原定于10月10日的面试现改期调整至10月12日15:00。'
    })

    const mockRuntime = {
      runAgentStep: async () => ({
        results: [
          {
            messageId: rescheduleEmail.messageId,
            eventType: 'interview' as const,
            company: '美团',
            position: '后端研发',
            confidence: 'high' as const,
            evidence: rescheduleEmail.subject,
            untrusted: false,
            isReschedule: true,
            dueDate: '2026-10-12T15:00:00Z'
          }
        ],
        matched: 1,
        pending: 0,
        ignored: 0
      })
    } as unknown as AgentRuntime

    const mockEmailProvider = {
      provider: 'gmail' as const,
      listMessages: async () => [rescheduleEmail]
    }

    const res = await svc.syncFromEmails([mockEmailProvider as unknown as EmailProvider], mockRuntime)
    expect(res.synced).toBe(1)
    expect(res.created).toBe(0)

    const updated = svc.get(initialView.application.id)
    expect(updated?.events).toHaveLength(2) // Still applied + 1 interview (not 2 interviews!)
    const interviewEvent = updated?.events.find((e) => e.type === 'interview')
    expect(interviewEvent?.evidence).toContain('【改期】')
    expect(updated?.application.stageDeadline).toBe('2026-10-12T15:00:00Z')
  })

  it('Scenario 03 & 04: direct interview notice without prior applied mail auto-backfills applied event and marks suspended_missing_jd', async () => {
    const { svc } = makeService()

    const directInterviewEmail = makeEmail({
      from: { name: '米哈游HR', address: 'campus-noreply@mihoyo.com' },
      subject: '米哈游客户端开发一面邀请',
      textBody: '同学你好，邀请你参加第一轮专业面试，时间：2026-10-20。腾讯会议：123-456-789'
    })

    const mockRuntime = {
      runAgentStep: async () => ({
        results: [
          {
            messageId: directInterviewEmail.messageId,
            eventType: 'interview' as const,
            company: '米哈游',
            position: '客户端开发',
            confidence: 'high' as const,
            evidence: directInterviewEmail.subject,
            untrusted: false,
            meetingInfo: '腾讯会议：123-456-789',
            dueDate: '2026-10-20T10:00:00Z'
          }
        ],
        matched: 1,
        pending: 0,
        ignored: 0
      })
    } as unknown as AgentRuntime

    const mockEmailProvider = {
      provider: 'gmail' as const,
      listMessages: async () => [directInterviewEmail]
    }

    const res = await svc.syncFromEmails([mockEmailProvider as unknown as EmailProvider], mockRuntime)
    expect(res.created).toBe(1)

    const apps = svc.list()
    const app = apps.find((a) => a.application.company === '米哈游')
    expect(app).toBeDefined()
    expect(app?.application.prepStatus).toBe('suspended_missing_jd')
    expect(app?.application.interviewLink).toBe('腾讯会议：123-456-789')
    expect(app?.events).toHaveLength(2) // Backfilled applied + interview
    expect(app?.events[0].type).toBe('applied')
    expect(app?.events[1].type).toBe('interview')
  })

  it('Guards against missing JD in generatePrepMaterial and unlocks when JD is supplied', async () => {
    const { svc } = makeService()
    const view = svc.create({ company: '阿里巴巴', position: 'Java研发' })

    const mockRuntime = {
      runAgentStep: async () => ({
        html: '<div>Prep Dossier</div>',
        selfIntro: 'Intro',
        starProjects: [],
        commonQA: [],
        reverseQuestions: []
      })
    } as unknown as AgentRuntime

    // Attempting to generate prep material without JD must throw
    await expect(svc.generatePrepMaterial(view.application.id, mockRuntime)).rejects.toThrow(
      '缺失岗位 JD，已暂缓深度备战资料生成'
    )
    expect(svc.get(view.application.id)?.application.prepStatus).toBe('suspended_missing_jd')

    // User updates JD text
    svc.updateJdText(view.application.id, '负责高并发微服务系统设计，精通Java/Spring/MySQL')
    expect(svc.get(view.application.id)?.application.prepStatus).toBe('ready')

    // Now generation succeeds
    const prep = await svc.generatePrepMaterial(view.application.id, mockRuntime)
    expect(prep.html).toBe('<div>Prep Dossier</div>')
    expect(svc.get(view.application.id)?.application.prepStatus).toBe('ready')
  })

  it('Supports Undo (撤回) and Rebind (重新分配) of email events for HITL safety', () => {
    const { svc } = makeService()
    const appA = svc.create({ company: '网易', position: '前端开发' })
    const appB = svc.create({ company: '网易', position: '移动端开发' })

    const event = svc.addEvent({
      applicationId: appA.application.id,
      type: 'interview',
      round: 1,
      evidence: '一面通知',
      sourceRef: 'email:msg_netease_1'
    })
    const eventId = event.events[event.events.length - 1].id

    // Test Rebind to appB
    const rebound = svc.rebindEmailEvent(appA.application.id, eventId, appB.application.id)
    expect(rebound).toBe(true)
    expect(svc.get(appA.application.id)?.events).toHaveLength(1) // only initial applied
    expect(svc.get(appB.application.id)?.events).toHaveLength(2) // applied + rebound interview

    // Test Undo on appB
    const newEventId = svc.get(appB.application.id)!.events[1].id
    const undone = svc.undoEmailEvent(appB.application.id, newEventId)
    expect(undone).toBe(true)
    expect(svc.get(appB.application.id)?.events).toHaveLength(1) // back to 1

    // Should be restored to pending proposals
    const pending = svc.listPendingEmailMatches()
    expect(pending.some((p) => p.messageId === 'msg_netease_1')).toBe(true)
  })

  it('Verification code emails (e.g. 招聘官网验证码) and non-job emails are completely blocked from generating events or applications', async () => {
    const { svc } = makeService()
    const app = svc.create({ company: '深信服科技', position: '售前产品经理', source: 'email' })

    const verifyEmail = makeEmail({
      subject: '【深信服科技】招聘官网验证码获取',
      textBody: '您当前获取到的验证码为:578733,请勿轻易泄露并确认是本人操作,有效期10分钟'
    })

    const mockRuntime = {
      runAgentStep: async () => ({
        results: [
          {
            messageId: verifyEmail.messageId,
            eventType: 'communicated' as const,
            company: '深信服科技',
            position: undefined,
            confidence: 'low' as const,
            evidence: '非求职进程',
            untrusted: false,
            isJobRelated: false
          }
        ],
        matched: 0,
        pending: 1,
        ignored: 0
      })
    } as unknown as AgentRuntime

    const mockEmailProvider = {
      provider: 'mail163' as const,
      listMessages: async () => [verifyEmail]
    }

    const res = await svc.syncFromEmails([mockEmailProvider as unknown as EmailProvider], mockRuntime)

    // Verification code must NEVER create an event, never create an app, and never enter pending queue
    expect(res.synced).toBe(0)
    expect(res.created).toBe(0)
    expect(res.pending).toBe(0)

    const updatedApp = svc.get(app.application.id)
    expect(updatedApp?.events).toHaveLength(1) // only initial applied event
    expect(updatedApp?.events[0].type).toBe('applied')
    expect(svc.listPendingEmailMatches()).toHaveLength(0)
  })

  it('Captures thank-you letter / rejection notices (感谢信 / 淘汰通知), penetrates bulk filter, merges into application, and marks status as rejected', async () => {
    const { svc } = makeService()
    const app = svc.create({ company: '深信服科技', position: '产品经理', source: 'email' })

    const rejectionEmail = makeEmail({
      from: { name: '深信服招聘团队', address: 'campus-noreply@sangfor.com' },
      subject: '【深信服科技】校园招聘 - 感谢信',
      textBody: '同学你好，非常感谢你参加深信服科技的面试。经过综合评估，很遗憾地通知您，您目前的背景与岗位要求暂不匹配。我们已将您的简历列入公司人才库。退订请点击链接。',
      bulk: true
    })

    // 1. Bulk filter must NOT drop it because of VIP penetration
    expect(shouldSkipFunnel(rejectionEmail)).toBe(false)

    // 2. Syncing from email identifies it as rejected and merges into the existing application
    const mockRuntime = {
      runAgentStep: async () => ({
        results: [
          {
            messageId: rejectionEmail.messageId,
            eventType: 'rejected' as const,
            company: '深信服科技',
            position: '产品经理',
            confidence: 'high' as const,
            evidence: '深信服科技校园招聘 - 感谢信',
            untrusted: false,
            isJobRelated: true
          }
        ],
        matched: 1,
        pending: 0,
        ignored: 0
      })
    } as unknown as AgentRuntime

    const mockEmailProvider = {
      provider: 'mail163' as const,
      listMessages: async () => [rejectionEmail]
    }

    const res = await svc.syncFromEmails([mockEmailProvider as unknown as EmailProvider], mockRuntime)

    expect(res.synced).toBe(1)
    expect(res.created).toBe(0)

    const updatedApp = svc.get(app.application.id)
    expect(updatedApp?.events).toHaveLength(2) // applied + rejected
    expect(updatedApp?.events[1].type).toBe('rejected')
    expect(updatedApp?.events[1].evidence).toContain('感谢信')
    expect(updatedApp?.currentStatus).toBe('rejected')
    expect(updatedApp?.isTerminal).toBe(true)
  })
})
