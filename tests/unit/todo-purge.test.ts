// ADR 0027 — one-time purge of legacy email-origin items (ToDos + 投递 + 必读
// NTKs). Gated by `settings.todo.purgeVersion` (bumped after each filtering
// fix) so the cold-start re-backfill regenerates a clean set. Clears
// source='email' tasks, source='email' application rows (mock/demo fixtures +
// fake low-confidence recruiting-outlook 投递 the user never applied to), and
// email-origin 必读 NTKs (LinkedIn ads / [student_ips] / Railway
// auto-notifications the pre-fix surface logic let through). Manual / boss /
// web / referral apps + assistant/routine tasks + morning-brief NTKs survive.
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { TaskService } from '../../src/main/services/task-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { ActivityService } from '../../src/main/services/activity-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import { purgeEmailOriginTasks } from '../../src/main/services/todo-purge'

function setup(): {
  store: InMemoryStore
  tasks: TaskService
  app: ApplicationService
  ntk: NeedToKnowService
} {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const boss = new MockBossProvider()
  return {
    store,
    tasks: new TaskService(store),
    app: new ApplicationService(store, boss, activity),
    ntk: new NeedToKnowService(store)
  }
}

describe('purgeEmailOriginTasks (ADR 0027)', () => {
  it('removes every sourceType=email task, keeps assistant/routine', () => {
    const { tasks, app } = setup()
    tasks.create({ title: '跟进：1677387239', sourceType: 'email', sourceId: 'email:m1' })
    tasks.create({ title: '回复 HR', sourceType: 'email', sourceId: 'email:m2' })
    tasks.create({ title: '买咖啡', sourceType: 'assistant' })
    tasks.create({ title: '晨报', sourceType: 'routine', sourceId: 'routine:mb' })

    const r = purgeEmailOriginTasks(tasks, app)
    expect(r.tasks).toBe(2)
    const left = tasks.list().map((t) => t.sourceType)
    expect(left).not.toContain('email')
    expect(left).toEqual(expect.arrayContaining(['assistant', 'routine']))
    expect(tasks.list()).toHaveLength(2)
  })

  it('purges source=email application rows (incl. fake recruiting-outlook fakes), keeps manual/web/boss', () => {
    const { store, tasks, app } = setup()
    // A real manually-tracked app (web) — KEPT.
    const web = app.create({ company: '腾讯', position: '后端', source: 'web' }).application
    store.updateApplication(web.id, { emailRefId: '1759000000' })
    // A boss-sourced app — KEPT.
    const boss = app.create({ company: 'BossCo', position: 'Y', source: 'boss' }).application
    // Email-inferred apps (source='email') — ALL purged, including the fake
    // Universiti Malaya recruiting-outlook rows (real messageId, no prefix)
    // the old "create even at low confidence" wrongly built.
    const inferred = app
      .create({ company: 'Universiti Malaya', position: 'RA', source: 'email' })
      .application
    store.updateApplication(inferred.id, { emailRefId: '12345' })
    const demo = app.create({ company: 'MockCo', position: 'X', source: 'email' }).application
    store.updateApplication(demo.id, { emailRefId: `demo:${demo.id}` })

    const r = purgeEmailOriginTasks(tasks, app)
    const ids = app.list().map((v) => v.application.id)
    expect(ids).toContain(web.id)
    expect(ids).toContain(boss.id)
    expect(ids).not.toContain(inferred.id)
    expect(ids).not.toContain(demo.id)
    expect(r.applications).toBe(2)
  })

  it('purges email-origin 必读 NTKs, keeps morning-brief + non-email NTKs', () => {
    const { tasks, app, ntk } = setup()
    ntk.create({
      title: '【招聘】LinkedIn 上有新职位',
      summary: '',
      reason: '营销性资讯',
      priority: 'urgent',
      sourceRefs: [{ type: 'email', id: 'email:m1', label: 'linkedin' }]
    })
    ntk.create({
      title: '[student_ips] 讲座通知',
      summary: '',
      reason: 'school spam',
      priority: 'high',
      sourceRefs: [{ type: 'email', id: 'email:m2', label: 'student_ips' }]
    })
    ntk.create({
      title: '今日晨报',
      summary: '',
      reason: 'routine',
      priority: 'medium',
      kind: 'morning_brief',
      sourceRefs: [{ type: 'routine', id: 'routine:mb', label: '晨报' }]
    })

    const r = purgeEmailOriginTasks(tasks, app, ntk)
    const titles = ntk.list().map((n) => n.title)
    expect(titles).not.toContain('【招聘】LinkedIn 上有新职位')
    expect(titles).not.toContain('[student_ips] 讲座通知')
    // morning-brief is excluded from list() (kind filter) — still present on
    // the store, never touched by the purge (no email sourceRef).
    expect(ntk.listMorningBriefs(7).map((n) => n.title)).toContain('今日晨报')
    expect(r.ntk).toBe(2)
  })

  it('is idempotent — a second call is a no-op', () => {
    const { tasks, app } = setup()
    tasks.create({ title: '回复 HR', sourceType: 'email', sourceId: 'email:m1' })
    tasks.create({ title: '买咖啡', sourceType: 'assistant' })
    purgeEmailOriginTasks(tasks, app)
    const second = purgeEmailOriginTasks(tasks, app)
    expect(second.tasks).toBe(0)
    expect(second.applications).toBe(0)
    expect(second.ntk).toBe(0)
    expect(tasks.list()).toHaveLength(1)
  })

  it('never touches manual (assistant) tasks even when they are the only ones', () => {
    const { tasks, app } = setup()
    tasks.create({ title: '写论文', sourceType: 'assistant' })
    const r = purgeEmailOriginTasks(tasks, app)
    expect(r.tasks).toBe(0)
    expect(tasks.list()).toHaveLength(1)
  })

  it('purges routine-extracted mock ToDos (mock- sourceId), keeps real routine tasks (ADR 0028)', () => {
    const { tasks, app } = setup()
    // morning_brief ran on a mock email → routine task with mock-msg sourceId
    tasks.create({ title: 'Decide: Approval Center in P0 or defer', sourceType: 'routine', sourceId: 'mock-msg-001' })
    // a real routine-extracted ToDo (real messageId) — KEPT
    tasks.create({ title: '与 Dr. Adeleh 确认参会日期', sourceType: 'routine', sourceId: '19fe857b1eefa60f' })
    const r = purgeEmailOriginTasks(tasks, app)
    expect(r.tasks).toBe(1)
    const left = tasks.list().map((t) => t.sourceId ?? '')
    expect(left).not.toContain('mock-msg-001')
    expect(left).toContain('19fe857b1eefa60f')
  })

  it('purges mock-sourced morning_brief NTKs (Q3 roadmap mock calendar), keeps real morning_briefs (ADR 0028)', () => {
    const { tasks, app, ntk } = setup()
    // mock-calendar "Q3 roadmap review" event fed morning_brief → fake brief
    ntk.create({
      title: '今日晨间简报：Q3路线图评审在即，需先敲定审批中心决策',
      summary: '',
      reason: 'mock calendar',
      priority: 'medium',
      kind: 'morning_brief',
      sourceRefs: [{ type: 'calendar', id: 'Q3-roadmap-review', label: 'Q3 roadmap review（今日 10:00' }]
    })
    // a real morning_brief (real calendar event) — KEPT
    ntk.create({
      title: '今日晨间简报：导师组会 14:00',
      summary: '',
      reason: 'real calendar',
      priority: 'medium',
      kind: 'morning_brief',
      sourceRefs: [{ type: 'calendar', id: 'evt-real-001', label: '导师组会' }]
    })
    const r = purgeEmailOriginTasks(tasks, app, ntk)
    expect(r.ntk).toBe(1)
    const briefs = ntk.listMorningBriefs(365).map((n) => n.title)
    expect(briefs).not.toContain('今日晨间简报：Q3路线图评审在即，需先敲定审批中心决策')
    expect(briefs).toContain('今日晨间简报：导师组会 14:00')
  })

  it('purges DISMISSED mock-sourced NTKs too (Q3 roadmap stragglers a user dismissed, ADR 0028 v6)', () => {
    const { tasks, app, ntk } = setup()
    // A user dismissed the mock-calendar "Q3 roadmap" mock brief before real
    // providers connected. `list()` excludes dismissed + it's kind=null so
    // listMorningBriefs() never returns it — it would survive v5. The purge
    // scans listAll() (incl. dismissed) and clears it.
    const dismissed = ntk.create({
      title: 'Morning Brief: Q3 Roadmap Decision Due Friday',
      summary: '',
      reason: 'mock calendar',
      priority: 'medium',
      sourceRefs: [{ type: 'calendar', id: 'Q3-roadmap-review', label: 'Q3 roadmap review' }]
    })
    ntk.dismiss(dismissed.id)
    // a real dismissed NTK (no mock markers) — KEPT (it's the user's real dismissal)
    const realDismissed = ntk.create({
      title: '回复导师：确认论文题目',
      summary: '',
      reason: 'real mail',
      priority: 'high',
      sourceRefs: [{ type: 'email', id: '19fe857b1eefa60f', label: '导师' }]
    })
    ntk.dismiss(realDismissed.id)
    const r = purgeEmailOriginTasks(tasks, app, ntk)
    // The dismissed mock Q3-roadmap NTK is cleared; the dismissed real NTK
    // is mock-marker-free so isMockNtk() returns false → kept.
    const all = ntk.listAll().map((n) => n.title)
    expect(all).not.toContain('Morning Brief: Q3 Roadmap Decision Due Friday')
    expect(all).toContain('回复导师：确认论文题目')
    expect(r.ntk).toBeGreaterThanOrEqual(1)
  })
})
