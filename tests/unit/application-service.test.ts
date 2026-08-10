import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import type { ApplicationEventInput } from '@shared/types'

function makeService(): { svc: ApplicationService; store: InMemoryStore; boss: MockBossProvider; activity: ActivityService } {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const boss = new MockBossProvider()
  const svc = new ApplicationService(store, boss, activity)
  return { svc, store, boss, activity }
}

describe('application service — manual CRUD', () => {
  it('creates a manual application and seeds a locked applied event', () => {
    const { svc } = makeService()
    const v = svc.create({ company: '腾讯', position: '后端', source: 'web' })
    expect(v.application.company).toBe('腾讯')
    expect(v.application.source).toBe('web')
    expect(v.events).toHaveLength(1)
    expect(v.events[0].type).toBe('applied')
    expect(v.events[0].locked).toBe(true)
    expect(v.currentStatus).toBe('applied')
    expect(v.isTerminal).toBe(false)
  })

  it('appends a manual progress event and recomputes status', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: '腾讯', position: '后端' })
    const ev: ApplicationEventInput = {
      applicationId: v0.application.id,
      type: 'interview',
      round: 1,
      evidence: '一面'
    }
    const v1 = svc.addEvent(ev)
    expect(v1.events).toHaveLength(2)
    expect(v1.currentStatus).toBe('interview')
    expect(v1.currentRound).toBe(1)
    expect(v1.isTerminal).toBe(false)
    // manual events are locked by default
    expect(v1.events[1].locked).toBe(true)
    expect(v1.events[1].source).toBe('manual')
  })

  it('throws when adding an event to a missing application', () => {
    const { svc } = makeService()
    expect(() =>
      svc.addEvent({ applicationId: 'nope', type: 'interview' })
    ).toThrow(/未找到投递记录/)
  })
})

describe('application service — status computation', () => {
  it('terminal event wins regardless of later non-terminal events', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    const id = v0.application.id
    // rejected, then a later interview event (out of order in time but later createdAt)
    svc.addEvent({ applicationId: id, type: 'rejected', eventAt: '2026-01-01T00:00:00.000Z' })
    svc.addEvent({ applicationId: id, type: 'interview', eventAt: '2026-01-05T00:00:00.000Z' })
    const v = svc.list().find((a) => a.application.id === id)!
    expect(v.currentStatus).toBe('rejected')
    expect(v.isTerminal).toBe(true)
  })

  it('latest terminal wins when multiple terminals exist', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    const id = v0.application.id
    svc.addEvent({ applicationId: id, type: 'rejected', eventAt: '2026-01-01T00:00:00.000Z' })
    svc.addEvent({ applicationId: id, type: 'offer', eventAt: '2026-01-10T00:00:00.000Z' })
    const v = svc.list().find((a) => a.application.id === id)!
    expect(v.currentStatus).toBe('offer')
    expect(v.isTerminal).toBe(true)
  })

  it('latest non-terminal event wins when no terminal', () => {
    const { svc } = makeService()
    // Seed applied at an early date so it sorts before the manual events below
    // (the seeded event otherwise defaults to `now`).
    const v0 = svc.create({ company: 'A', position: 'p', appliedAt: '2025-12-01T00:00:00.000Z' })
    const id = v0.application.id
    svc.addEvent({ applicationId: id, type: 'communicated', eventAt: '2026-01-01T00:00:00.000Z' })
    svc.addEvent({ applicationId: id, type: 'assessment', eventAt: '2026-01-03T00:00:00.000Z' })
    const v = svc.list().find((a) => a.application.id === id)!
    expect(v.currentStatus).toBe('assessment')
    expect(v.isTerminal).toBe(false)
  })

  it('application with no events defaults to applied', () => {
    const { svc, store } = makeService()
    // bypass create() seeding by writing an application directly
    store.createApplication({
      id: 'app-bare',
      company: 'Bare',
      position: 'p',
      source: 'manual',
      bossSecurityId: undefined,
      appliedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const v = svc.list().find((a) => a.application.id === 'app-bare')!
    expect(v.events).toHaveLength(0)
    expect(v.currentStatus).toBe('applied')
    expect(v.isTerminal).toBe(false)
  })
})

describe('application service — boss sync', () => {
  it('pulls applied + interviews + chats from the mock boss provider', async () => {
    const { svc } = makeService()
    const res = await svc.syncFromBoss()
    expect(res.synced).toBe(2) // two applied jobs in the mock
    const list = svc.list()
    // 字节跳动 (golang) has applied + interview + communicated events
    const bytedance = list.find((v) => v.application.company === '字节跳动')
    expect(bytedance).toBeDefined()
    const types = bytedance!.events.map((e) => e.type).sort()
    expect(types).toContain('applied')
    expect(types).toContain('interview')
    expect(types).toContain('communicated')
    // 美团 (frontend) has only applied
    const meituan = list.find((v) => v.application.company === '美团')
    expect(meituan!.events.map((e) => e.type)).toEqual(['applied'])
    expect(bytedance!.currentStatus).toBe('interview')
    // boss-detected events are not locked (auto-detected)
    const interviewEv = bytedance!.events.find((e) => e.type === 'interview')
    expect(interviewEv!.locked).toBe(false)
    expect(interviewEv!.source).toBe('boss')
  })

  it('is idempotent — syncing twice does not duplicate applications or events', async () => {
    const { svc } = makeService()
    await svc.syncFromBoss()
    const firstCount = svc.list().length
    const firstEvents = svc.list().flatMap((v) => v.events).length
    await svc.syncFromBoss()
    expect(svc.list().length).toBe(firstCount)
    expect(svc.list().flatMap((v) => v.events).length).toBe(firstEvents)
  })

  it('records a provider_unavailable activity on boss failure and returns gracefully', async () => {
    const { svc, store, boss } = makeService()
    // Force listApplications to throw a BossCliError-shaped error.
    boss.listApplications = async () => {
      throw new (class extends Error {
        code = 'not_authenticated' as const
      })('boss-cli 未安装')
    }
    const res = await svc.syncFromBoss()
    expect(res.synced).toBe(0)
    expect(res.message).toContain('同步失败')
    const activities = store.listActivity()
    const unavailable = activities.find((a) => a.type === 'provider_unavailable')
    expect(unavailable).toBeDefined()
    expect(unavailable!.summary).toContain('BOSS 直聘同步失败')
  })

  it('matches interviews/chats by company+position when securityId is absent', async () => {
    const { svc, boss } = makeService()
    // Strip securityId from the interview fixture so matching falls back to
    // company+position (the golang job).
    const original = await boss.listInterviews()
    boss.listInterviews = async () =>
      original.map((i) => ({ ...i, securityId: undefined }))
    await svc.syncFromBoss()
    const bytedance = svc.list().find((v) => v.application.company === '字节跳动')
    expect(bytedance!.events.map((e) => e.type)).toContain('interview')
  })
})
