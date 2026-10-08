import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApplicationService, extractJobCodeFromText, extractPositionFromText } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
function makeService(): { svc: ApplicationService; store: InMemoryStore; activity: ActivityService } {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const svc = new ApplicationService(store, activity)
  return { svc, store, activity }
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



describe('application service — locked-precedence computeStatus', () => {
  it('a locked terminal pins status against a later auto terminal (§17 risk #3)', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p', appliedAt: '2026-01-01T00:00:00.000Z' })
    const id = v0.application.id
    // locked manual rejected, then an auto offer (locked:false) later
    svc.addEvent({ applicationId: id, type: 'rejected', eventAt: '2026-01-05T00:00:00.000Z' })
    svc.addEvent({ applicationId: id, type: 'offer', eventAt: '2026-01-10T00:00:00.000Z', locked: false })
    const v = svc.list().find((a) => a.application.id === id)!
    // offer event is recorded in the timeline (visible)...
    expect(v.events.map((e) => e.type)).toContain('offer')
    // ...but status stays pinned at the locked rejected
    expect(v.currentStatus).toBe('rejected')
    expect(v.isTerminal).toBe(true)
  })

  it('a locked non-terminal pins status against a later auto event', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p', appliedAt: '2026-01-01T00:00:00.000Z' })
    const id = v0.application.id
    // applied (locked, seeded) is the only locked event; a later auto
    // communicated must not move status off it.
    svc.addEvent({ applicationId: id, type: 'communicated', eventAt: '2026-01-05T00:00:00.000Z', locked: false })
    const v = svc.list().find((a) => a.application.id === id)!
    expect(v.events.map((e) => e.type)).toContain('communicated')
    expect(v.currentStatus).toBe('applied')
  })

  it('all-auto timeline: terminal-wins still applies (no locked anchor)', () => {
    // a manual app seeds a LOCKED applied event — to test the all-auto path,
    // build the app directly so no seeded locked event exists.
    const store = new InMemoryStore()
    const activity = new ActivityService(store)
    const autoSvc = new ApplicationService(store, activity)
    const id = 'app-auto'
    store.createApplication({
      id,
      company: 'A',
      position: 'p',
      source: 'boss',
      appliedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    // all auto (locked:false): rejected then a later interview — terminal wins
    store.createApplicationEvent({
      id: 'e1', applicationId: id, type: 'rejected', source: 'email',
      locked: false, eventAt: '2026-01-05T00:00:00.000Z', createdAt: '2026-01-05T00:00:00.000Z'
    })
    store.createApplicationEvent({
      id: 'e2', applicationId: id, type: 'interview', source: 'email',
      locked: false, eventAt: '2026-01-10T00:00:00.000Z', createdAt: '2026-01-10T00:00:00.000Z'
    })
    const v = autoSvc.list().find((a) => a.application.id === id)!
    expect(v.currentStatus).toBe('rejected')
    expect(v.isTerminal).toBe(true)
  })

  it('lastEventAt uses the newest event regardless of lock', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p', appliedAt: '2026-01-01T00:00:00.000Z' })
    const id = v0.application.id
    svc.addEvent({ applicationId: id, type: 'interview', eventAt: '2026-01-05T00:00:00.000Z', locked: false })
    const v = svc.list().find((a) => a.application.id === id)!
    expect(v.lastEventAt).toBe('2026-01-05T00:00:00.000Z')
  })
})

describe('application service — rich fields / soft delete / archive / maintenance', () => {
  it('create stores rich fields and updateFields patches them', () => {
    const { svc } = makeService()
    const v0 = svc.create({
      company: '腾讯', position: '后端', city: '深圳', salaryRange: '25-40K',
      jdText: '负责后端服务'
    })
    expect(v0.application.city).toBe('深圳')
    expect(v0.application.jdText).toBe('负责后端服务')
    expect(v0.application.priority).toBe('normal')
    const v1 = svc.updateFields(v0.application.id, { stage: '一面', priority: 'back' })
    expect(v1?.application.stage).toBe('一面')
    expect(v1?.application.priority).toBe('back')
  })

  it('soft delete hides from list, restore brings it back, purge removes it', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    svc.softDelete(v0.application.id)
    expect(svc.list().find((a) => a.application.id === v0.application.id)).toBeUndefined()
    expect(svc.listDeleted().find((a) => a.application.id === v0.application.id)).toBeDefined()
    svc.restore(v0.application.id)
    expect(svc.list().find((a) => a.application.id === v0.application.id)).toBeDefined()
    svc.purgeApplication(v0.application.id)
    expect(svc.listDeleted().find((a) => a.application.id === v0.application.id)).toBeUndefined()
  })

  it('archive moves app out of active funnel; unarchive restores', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    svc.archive(v0.application.id)
    expect(svc.list().find((a) => a.application.id === v0.application.id)).toBeUndefined()
    expect(svc.listArchived().find((a) => a.application.id === v0.application.id)).toBeDefined()
    svc.unarchive(v0.application.id)
    expect(svc.list().find((a) => a.application.id === v0.application.id)).toBeDefined()
  })

  it('runMaintenance purges 30d+ soft-deleted rows and demotes 14d+ stale apps', () => {
    // Construct store+service directly so we can backdate deletedAt (the
    // service only ever soft-deletes at "now").
    const store = new InMemoryStore()
    const activity = new ActivityService(store)
    const svc = new ApplicationService(store, activity)

    // a stale app: applied 20 days ago, no progress → should demote to 'back'
    // Use relative dates so the test isn't a date bomb that flips the day the
    // "recent" seed crosses the 14d threshold.
    const DAY = 86_400_000
    const now = Date.now()
    svc.create({ company: '旧', position: 'p', appliedAt: new Date(now - 20 * DAY).toISOString() })
    // a recent app (2 days ago) → stays 'normal' (well under 14d)
    svc.create({ company: '新', position: 'p', appliedAt: new Date(now - 2 * DAY).toISOString() })
    // a soft-deleted row, backdated 40 days → should be purged
    const gone = svc.create({ company: '删', position: 'p', appliedAt: new Date(now - 45 * DAY).toISOString() })
    svc.softDelete(gone.application.id)
    store.softDeleteApplication(gone.application.id, new Date(now - 40 * DAY).toISOString()) // backdate

    const res = svc.runMaintenance()
    expect(res.purged).toBe(1)
    expect(res.demoted).toBe(1)
    // purged row is gone
    expect(store.getApplication(gone.application.id)).toBeUndefined()
    // stale app demoted
    const demotedView = svc.list().find((a) => a.application.company === '旧')
    expect(demotedView?.application.priority).toBe('back')
    // recent app unaffected
    const recentView = svc.list().find((a) => a.application.company === '新')
    expect(recentView?.application.priority).toBe('normal')
  })
})

describe('application service — smart funnel grouping', () => {
  it('groups apps into urgent/active/stale/offered/ended/archived buckets', () => {
    const { svc } = makeService()
    // Relative dates — hardcoded 2026-08-xx drifted past STALE_DAYS (14) as
    // real time advanced, flipping the "active" app to "stale" (date-rot).
    const day = 86_400_000
    const ago = (n: number): string => new Date(Date.now() - n * day).toISOString()
    const ahead = (n: number): string => new Date(Date.now() + n * day).toISOString()
    // active app (applied 5 days ago — within STALE_DAYS)
    svc.create({ company: '进行中', position: 'p', appliedAt: ago(5) })
    // urgent app: stage deadline in 2 days
    const urgent = svc.create({ company: '紧急', position: 'p', stageDeadline: ahead(2) })
    void urgent
    // offered app
    const off = svc.create({ company: '录用', position: 'p' })
    svc.addEvent({ applicationId: off.application.id, type: 'offer', eventAt: ago(5) })
    // ended app
    const rej = svc.create({ company: '拒了', position: 'p' })
    svc.addEvent({ applicationId: rej.application.id, type: 'rejected', eventAt: ago(5) })
    // archived app
    const arc = svc.create({ company: '归档', position: 'p' })
    svc.archive(arc.application.id)

    const buckets = svc.smartSortedViews()
    const groups = buckets.map((b) => b.group)
    expect(groups).toContain('urgent')
    expect(groups).toContain('active')
    expect(groups).toContain('offered')
    expect(groups).toContain('ended')
    expect(groups).toContain('archived')
    // archived bucket contains the archived app
    const archivedBucket = buckets.find((b) => b.group === 'archived')
    expect(archivedBucket?.views.some((v) => v.application.company === '归档')).toBe(true)
    // offered bucket contains the offer app
    const offeredBucket = buckets.find((b) => b.group === 'offered')
    expect(offeredBucket?.views.some((v) => v.application.company === '录用')).toBe(true)
    // empty buckets are dropped
    const staleBucket = buckets.find((b) => b.group === 'stale')
    expect(staleBucket).toBeUndefined()
  })
})

describe('application service — resume / prep-material versioning', () => {
  it('saveResume creates v1 then v2; getLatest returns the newest', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    const r1 = svc.saveResume(v0.application.id, '<b>v1</b>')
    expect(r1.version).toBe(1)
    const r2 = svc.saveResume(v0.application.id, '<b>v2</b>')
    expect(r2.version).toBe(2)
    expect(svc.getLatestResume(v0.application.id)?.html).toBe('<b>v2</b>')
    expect(svc.listResumeVersions(v0.application.id).map((r) => r.version)).toEqual([2, 1])
  })

  it('savePrepMaterial versions independently of resume', () => {
    const { svc } = makeService()
    const v0 = svc.create({ company: 'A', position: 'p' })
    const p1 = svc.savePrepMaterial(v0.application.id, '<i>t1</i>')
    expect(p1.version).toBe(1)
    expect(svc.getLatestPrepMaterial(v0.application.id)?.html).toBe('<i>t1</i>')
    // resume versions are a separate counter
    svc.saveResume(v0.application.id, '<b>r1</b>')
    const p2 = svc.savePrepMaterial(v0.application.id, '<i>t2</i>')
    expect(p2.version).toBe(2)
  })
})

describe('application service — jobCode matching & requisition deduplication', () => {
  it('creates application with jobCode and allows updating it', () => {
    const { svc } = makeService()
    const app = svc.create({ company: '字节跳动', position: '产品经理', jobCode: 'BYTEDANCE_PM_01' })
    expect(app.application.jobCode).toBe('BYTEDANCE_PM_01')

    const updated = svc.updateFields(app.application.id, { jobCode: 'BYTEDANCE_PM_02' })
    expect(updated?.application.jobCode).toBe('BYTEDANCE_PM_02')
  })

  it('confirmEmailMatch sets jobCode on new or existing application', () => {
    const { svc } = makeService()
    const svcInternal = svc as unknown as { emailMatches: Map<string, unknown> }
    svcInternal.emailMatches.set('msg-123', {
      id: 'em-1',
      messageId: 'msg-123',
      subject: '【美团】笔试通知',
      eventType: 'written_test',
      company: '美团',
      position: '后端开发',
      jobCode: 'MT_RD_999',
      confidence: 'high'
    })

    svc.confirmEmailMatch('msg-123', undefined, { jobCode: 'MT_RD_999' })
    const apps = svc.list()
    const meituan = apps.find((a) => a.application.company === '美团')
    expect(meituan).toBeDefined()
    expect(meituan?.application.jobCode).toBe('MT_RD_999')
  })

  it('extractJobCodeFromText rejects Job Requirements and extracts valid job code', () => {
    expect(extractJobCodeFromText('Job Requirements:\n1. 本科及以上学历')).toBeUndefined()
    expect(extractJobCodeFromText('Job Requirement:\n1. 本科及以上学历')).toBeUndefined()
    expect(extractJobCodeFromText('Job Description:\n负责产品研发')).toBeUndefined()
    expect(extractJobCodeFromText('职位编号: J18671')).toBe('J18671')
    expect(extractJobCodeFromText('Req ID: REQ-2024-99')).toBe('REQ-2024-99')
  })

  it('extractPositionFromText correctly captures application confirmation bracketed titles', () => {
    expect(
      extractPositionFromText('理想汽车邀请您投递简历（你申请的【AI 产品经理】岗位已经投递成功）')
    ).toBe('AI 产品经理')
    expect(
      extractPositionFromText('理想汽车邀请您投递简历（你申请的【前线产品Builder-北京】岗位已经投递成功）')
    ).toBe('前线产品Builder-北京')
    expect(
      extractPositionFromText('理想汽车邀请您投递简历（你申请的【AI系统产品经理-北京】岗位已经投递成功）')
    ).toBe('AI系统产品经理-北京')
  })

  it('repairBogusJobCodeMerges clears uirements jobCode and splits falsely merged positions', () => {
    const { svc, store } = makeService()
    // Simulate corrupt state: 1 application with jobCode 'uirements' holding 3 distinct email events + 1 empty seed
    const v = svc.create({
      company: '理想汽车',
      position: 'AI系统产品经理',
      jobCode: 'uirements',
      source: 'email'
    })
    const appId = v.application.id

    // Add 3 distinct email-applied events
    store.createApplicationEvent({
      id: 'evt-1',
      applicationId: appId,
      type: 'applied',
      source: 'email',
      sourceRef: 'email:1677387438',
      evidence: '理想汽车邀请您投递简历（你申请的【AI 产品经理】岗位已经投递成功）',
      locked: false,
      eventAt: '2026-10-08T17:35:58.882Z',
      createdAt: '2026-10-08T17:35:58.882Z'
    })
    store.createApplicationEvent({
      id: 'evt-2',
      applicationId: appId,
      type: 'applied',
      source: 'email',
      sourceRef: 'email:1677387439',
      evidence: '理想汽车邀请您投递简历（你申请的【前线产品Builder-北京】岗位已经投递成功）',
      locked: false,
      eventAt: '2026-10-08T17:35:58.881Z',
      createdAt: '2026-10-08T17:35:58.881Z'
    })
    store.createApplicationEvent({
      id: 'evt-3',
      applicationId: appId,
      type: 'applied',
      source: 'email',
      sourceRef: 'email:1677387440',
      evidence: '理想汽车邀请您投递简历（你申请的【AI系统产品经理-北京】岗位已经投递成功）',
      locked: false,
      eventAt: '2026-10-08T17:35:58.880Z',
      createdAt: '2026-10-08T17:35:58.880Z'
    })

    const result = svc.repairBogusJobCodeMerges()
    expect(result.splitApps).toBe(2)

    const apps = svc.list().filter((a) => a.application.company === '理想汽车')
    expect(apps).toHaveLength(3)

    const positions = apps.map((a) => a.application.position).sort()
    expect(positions).toEqual(['AI 产品经理', 'AI系统产品经理-北京', '前线产品Builder-北京'].sort())

    for (const a of apps) {
      expect(a.application.jobCode).toBeUndefined()
      // Each application should have exactly 1 clean applied event
      expect(a.events).toHaveLength(1)
      expect(a.events[0].type).toBe('applied')
      expect(a.events[0].sourceRef).toBeDefined()
    }
  })
})


