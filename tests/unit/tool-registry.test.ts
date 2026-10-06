import { describe, it, expect } from 'vitest'
import { createToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'

function buildContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  return {
    runId: 'run-test',
    routineRunId: 'run-test',
    emailProviders: [new MockEmailProvider()],
    calendarProvider: new MockCalendarProvider(),
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    activityService,
    memoryService: new MemoryService(store),
    applicationService: new ApplicationService(store, activityService),
    notify: () => {},
    ...overrides
  }
}

describe('tool registry', () => {
  const registry = createToolRegistry()

  it('executes an R0 read tool (email.list)', async () => {
    const res = await registry.execute('email.list', { unreadOnly: true }, buildContext())
    expect(res.status).toBe('ok')
    const data = (res as { status: 'ok'; data: unknown[] }).data
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
  })

  it('email.list_sent returns the user own sent mail as a tone corpus (R0)', async () => {
    const res = await registry.execute('email.list_sent', { limit: 10 }, buildContext())
    expect(res.status).toBe('ok')
    const data = (res as { status: 'ok'; data: { to: { address: string }[]; subject: string }[] }).data
    expect(data.length).toBeGreaterThan(0)
    // Sent mail is the user's own voice — every item is FROM me TO a contact.
    expect(data.every((m) => m.to.length > 0)).toBe(true)
    // Filtering by recipient narrows the corpus to that contact's tone.
    const res2 = await registry.execute(
      'email.list_sent',
      { toAddress: 'alice@example.com' },
      buildContext()
    )
    const data2 = (res2 as { status: 'ok'; data: { to: { address: string }[] }[] }).data
    expect(data2.every((m) => m.to.some((t) => t.address === 'alice@example.com'))).toBe(true)
  })

  it('validates parameters and rejects bad args', async () => {
    const res = await registry.execute('email.get', {}, buildContext())
    expect(res.status).toBe('error')
    expect((res as { error: string }).error).toMatch(/Invalid parameters/)
  })

  it('returns needs_approval for an R3 tool without approval context and does NOT execute', async () => {
    const ctx = buildContext()
    const provider = ctx.emailProviders[0]
    // Create a draft first via the provider, then attempt send without approval.
    const draft = await provider.createDraft({
      accountId: 'mock-gmail-001',
      to: [{ address: 'someone@example.com' }],
      subject: 'hi',
      body: 'hello'
    })
    const res = await registry.execute('email.send_draft', { accountId: 'mock-gmail-001', draftId: draft.id }, ctx)
    expect(res.status).toBe('needs_approval')
    expect((res as { risk: string }).risk).toBe('R3')
    // The draft must still exist (send was not executed).
    await expect(provider.sendDraft(draft.id)).resolves.toEqual(
      expect.objectContaining({ messageId: expect.any(String) })
    )
  })

  it('executes an R3 tool when an approval context is present', async () => {
    const ctx = buildContext({ approval: { requestId: 'appr-1' } })
    const provider = ctx.emailProviders[0]
    const draft = await provider.createDraft({
      accountId: 'mock-gmail-001',
      to: [{ address: 'someone@example.com' }],
      subject: 'hi',
      body: 'hello'
    })
    const res = await registry.execute('email.send_draft', { accountId: 'mock-gmail-001', draftId: draft.id }, ctx)
    expect(res.status).toBe('ok')
  })

  it('returns error for an unknown tool', async () => {
    const res = await registry.execute('nope', {}, buildContext())
    expect(res.status).toBe('error')
  })

  it('task.create is idempotent by sourceId', async () => {
    const ctx = buildContext()
    const a = await registry.execute('task.create', { title: 'T1', sourceId: 'src-1' }, ctx)
    const b = await registry.execute('task.create', { title: 'T1', sourceId: 'src-1' }, ctx)
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    expect((a as { data: { id: string } }).data.id).toBe((b as { data: { id: string } }).data.id)
  })

  // ── Milestone A: application + 面经 tools ───────────────────────────────────
  it('application.create + application.search + application.get_latest_resume round-trip', async () => {
    const ctx = buildContext()
    const created = await registry.execute(
      'application.create',
      { company: '腾讯', position: '后端', city: '深圳', jdText: 'Go 微服务' },
      ctx
    )
    expect(created.status).toBe('ok')
    const id = (created as { data: { application: { id: string } } }).data.application.id

    // search by company
    const found = await registry.execute('application.search', { company: '腾讯' }, ctx)
    expect(found.status).toBe('ok')
    const views = (found as { data: { application: { id: string } }[] }).data
    expect(views.some((v) => v.application.id === id)).toBe(true)

    // search by id
    const byId = await registry.execute('application.search', { id }, ctx)
    expect((byId as { data: unknown[] }).data).toHaveLength(1)

    // no resume yet
    const none = await registry.execute('application.get_latest_resume', { applicationId: id }, ctx)
    expect((none as { data: unknown }).data).toBeNull()
  })

  it('application.save_resume versions, application.save_prep_material versions independently', async () => {
    const ctx = buildContext()
    const c = await registry.execute('application.create', { company: 'A', position: 'p' }, ctx)
    const id = (c as { data: { application: { id: string } } }).data.application.id

    const r1 = await registry.execute('application.save_resume', { applicationId: id, html: '<b>1</b>' }, ctx)
    expect((r1 as { data: { version: number } }).data.version).toBe(1)
    const r2 = await registry.execute('application.save_resume', { applicationId: id, html: '<b>2</b>' }, ctx)
    expect((r2 as { data: { version: number } }).data.version).toBe(2)

    const latest = await registry.execute('application.get_latest_resume', { applicationId: id }, ctx)
    expect((latest as { data: { html: string } }).data.html).toBe('<b>2</b>')

    const p1 = await registry.execute('application.save_prep_material', { applicationId: id, html: '<i>t</i>' }, ctx)
    expect((p1 as { data: { version: number } }).data.version).toBe(1)
  })

  it('application.update_field patches rich fields', async () => {
    const ctx = buildContext()
    const c = await registry.execute('application.create', { company: 'A', position: 'p' }, ctx)
    const id = (c as { data: { application: { id: string } } }).data.application.id
    const upd = await registry.execute('application.update_field', { id, city: '上海', priority: 'back' }, ctx)
    expect(upd.status).toBe('ok')
    expect((upd as { data: { application: { city: string; priority: string } } }).data.application.city).toBe('上海')
    expect((upd as { data: { application: { priority: string } } }).data.application.priority).toBe('back')
  })

  it('application.add_event appends a locked manual event', async () => {
    const ctx = buildContext()
    const c = await registry.execute('application.create', { company: 'A', position: 'p' }, ctx)
    const id = (c as { data: { application: { id: string } } }).data.application.id
    const ev = await registry.execute(
      'application.add_event',
      { applicationId: id, type: 'interview', round: 1, evidence: '一面' },
      ctx
    )
    expect(ev.status).toBe('ok')
    const view = (ev as { data: { currentStatus: string; events: { type: string; locked: boolean }[] } }).data
    expect(view.currentStatus).toBe('interview')
    expect(view.events.some((e) => e.type === 'interview' && e.locked)).toBe(true)
  })

  it('interview_notes.create + interview_notes.search', async () => {
    const ctx = buildContext()
    const created = await registry.execute(
      'interview_notes.create',
      { company: '腾讯', position: '后端', tags: ['algorithm', 'project'], content: '一道dp题' },
      ctx
    )
    expect(created.status).toBe('ok')
    const note = (created as { data: { id: string; source: string } }).data
    expect(note.source).toBe('manual')

    const found = await registry.execute('interview_notes.search', { query: 'dp' }, ctx)
    expect((found as { data: { content: string }[] }).data.some((n) => n.content.includes('dp'))).toBe(true)
  })
})
