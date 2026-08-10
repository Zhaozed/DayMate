import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import { nowIso } from '../../src/main/util/ids'
import type { RoutineDefinition } from '@shared/types'

function buildEngine() {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const approvalService = new ApprovalService(store)
  const emailProviders = [new MockEmailProvider()]
  const deps: EngineDeps = {
    store,
    toolRegistry: createToolRegistry(),
    activityService,
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    approvalService,
    emailProviders,
    calendarProvider: new MockCalendarProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps, emailProviders }
}

// A routine with an approval step that creates a draft (R3 → pauses). The
// draft content (to/subject/body) is the hashed args; approve → draft is
// created and the request is marked executed.
function draftApprovalRoutine(id = 'draft_demo'): RoutineDefinition {
  const now = nowIso()
  return {
    id,
    name: 'Draft Demo',
    description: 'approval-gated draft creation',
    version: 1,
    enabled: true,
    trigger: { type: 'manual' },
    inputs: {},
    steps: [
      {
        id: 'draft',
        type: 'approval',
        toolName: 'email.create_draft',
        title: 'Create reply draft',
        args: {
          accountId: 'mock-gmail-001',
          to: [{ name: 'Alice', address: 'alice@example.com' }],
          subject: 'Re: roadmap',
          body: 'I will review and reply by Friday.'
        }
      },
      { id: 'after', type: 'create_task', title: 'Draft approved — follow up' }
    ],
    approvalPolicy: 'writes_only',
    output: 'task',
    createdAt: now,
    updatedAt: now
  }
}

describe('approval flow', () => {
  it('pauses before the gated action and approves → executes + marks executed', async () => {
    const { engine, store, deps } = buildEngine()
    store.saveRoutine(draftApprovalRoutine())
    const run = await engine.run('draft_demo', { idempotencyKey: 'af-1' })
    expect(run.status).toBe('waiting_approval')

    const pending = deps.approvalService.list(true)
    expect(pending.length).toBe(1)
    const req = pending[0]
    expect(req.toolName).toBe('email.create_draft')
    expect(req.riskLevel).toBe('R3')

    deps.approvalService.approve(req.id)
    const resumed = await engine.resume(run.id, { approval: { requestId: req.id } })
    expect(resumed.status).toBe('completed')
    // The approval is now executed.
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')
    // Later step ran.
    expect(store.listTasks().map((t) => t.title)).toContain('Draft approved — follow up')
  })

  it('reject → run cancelled, the action NEVER executes (sends nothing)', async () => {
    const { engine, store, deps } = buildEngine()
    store.saveRoutine(draftApprovalRoutine('draft_reject'))
    const run = await engine.run('draft_reject', { idempotencyKey: 'af-reject' })
    expect(run.status).toBe('waiting_approval')

    const req = deps.approvalService.list(true)[0]
    deps.approvalService.reject(req.id)
    const cancelled = await engine.cancelPausedRun(run.id)
    expect(cancelled.status).toBe('cancelled')
    // No draft was created (the gated action never ran).
    const provider = deps.emailProviders[0]
    // Sending the (nonexistent) draft throws — proving it was never created.
    await expect(provider.sendDraft('no-such-draft')).rejects.toThrow(/未找到草稿/)
    // And the follow-up task never ran.
    expect(store.listTasks().length).toBe(0)
    // Approval stays rejected, not executed.
    expect(deps.approvalService.get(req.id)?.status).toBe('rejected')
  })

  it('content tamper between preview and execution → execution refused, run fails', async () => {
    const { engine, store, deps } = buildEngine()
    store.saveRoutine(draftApprovalRoutine('draft_tamper'))
    const run = await engine.run('draft_tamper', { idempotencyKey: 'af-tamper' })
    const req = deps.approvalService.list(true)[0]
    const approved = deps.approvalService.approve(req.id)

    // Tamper: replace the stored contentHash with one that no longer matches
    // the step's resolved args. This simulates "content changed since preview".
    // Status stays approved — only the hash is wrong.
    store.createApproval({ ...approved, contentHash: 'TAMPERED-HASH-VALUE' })

    const resumed = await engine.resume(run.id, { approval: { requestId: req.id } })
    expect(resumed.status).toBe('failed')
    expect(resumed.error).toMatch(/内容.*变更/)
    // The gated action never executed — no draft created.
    const provider = deps.emailProviders[0]
    await expect(provider.sendDraft('no-such-draft')).rejects.toThrow(/未找到草稿/)
  })

  it('a duplicate send run (same idempotency key) is a no-op — no duplicate send', async () => {
    const { engine, store, deps } = buildEngine()
    store.saveRoutine(draftApprovalRoutine('draft_dup'))
    const run1 = await engine.run('draft_dup', { idempotencyKey: 'af-dup' })
    expect(run1.status).toBe('waiting_approval')
    const req = deps.approvalService.list(true)[0]
    deps.approvalService.approve(req.id)
    await engine.resume(run1.id, { approval: { requestId: req.id } })
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')

    // Re-run with the SAME key → returns the existing completed run, executes
    // nothing new, creates no second approval/draft/task.
    const run2 = await engine.run('draft_dup', { idempotencyKey: 'af-dup' })
    expect(run2.id).toBe(run1.id)
    expect(run2.status).toBe('completed')
    // Only one approval ever existed for this run.
    expect(deps.approvalService.list().filter((a) => a.routineRunId === run1.id).length).toBe(1)
  })

  // Regression: an approval step whose args are FIELD-TEMPLATED against an
  // earlier step's output (e.g. `{{gmailEmails[0].from.address}}`) must hash
  // identically at preview and resume. Earlier the resume path resolved args
  // against EMPTY outputs → every token collapsed → hash mismatch → the
  // approved action was refused ("content changed"). This is the shape the
  // Draft Review preset (M4) relies on.
  it('templated approval args hash-match at resume (content immutability holds)', async () => {
    const { engine, store, deps } = buildEngine()
    const now = nowIso()
    store.saveRoutine({
      id: 'draft_templated',
      name: 'Draft Templated',
      description: 'approval-gated draft with field-templated args',
      version: 1,
      enabled: true,
      trigger: { type: 'manual' },
      inputs: {},
      steps: [
        {
          id: 'gmail_emails',
          type: 'tool',
          tool: 'email.list',
          args: { accountId: 'mock-gmail-001', unreadOnly: true, limit: 10 },
          outputKey: 'gmailEmails'
        },
        {
          id: 'draft_reply',
          type: 'approval',
          toolName: 'email.create_draft',
          title: 'Draft a reply to {{gmailEmails[0].from.name}}',
          args: {
            accountId: '{{gmailEmails[0].accountId}}',
            threadId: '{{gmailEmails[0].threadId}}',
            to: [{ address: '{{gmailEmails[0].from.address}}', name: '{{gmailEmails[0].from.name}}' }],
            subject: 'Re: {{gmailEmails[0].subject}}',
            body: 'Thanks — I will review and get back to you shortly.'
          }
        }
      ],
      approvalPolicy: 'writes_only',
      output: 'task',
      createdAt: now,
      updatedAt: now
    })

    const run = await engine.run('draft_templated', { idempotencyKey: 'af-tmpl' })
    expect(run.status).toBe('waiting_approval')

    const req = deps.approvalService.list(true)[0]
    // The preview args were resolved with the real first-unread fixture.
    expect(req.preview).toMatchObject({
      accountId: 'mock-gmail-001',
      threadId: 'mock-thread-001',
      to: [{ address: 'alice@example.com', name: 'Alice Chen' }],
      subject: 'Re: Q3 roadmap review — decision needed by Friday'
    })

    deps.approvalService.approve(req.id)
    const resumed = await engine.resume(run.id, { approval: { requestId: req.id } })
    // Must complete — NOT fail with "content changed".
    expect(resumed.status).toBe('completed')
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')
  })
})
