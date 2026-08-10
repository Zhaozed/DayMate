import { describe, it, expect } from 'vitest'
import { createToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'

function buildContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const store = new InMemoryStore()
  return {
    runId: 'run-test',
    routineRunId: 'run-test',
    emailProviders: [new MockEmailProvider()],
    calendarProvider: new MockCalendarProvider(),
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    activityService: new ActivityService(store),
    memoryService: new MemoryService(store),
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
})
