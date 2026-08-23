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
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import { nowIso } from '../../src/main/util/ids'
import type { RoutineDefinition, EmailProvider } from '@shared/types'

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
    bossProvider: new MockBossProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps, emailProviders }
}

// §15 gate mechanism, exercised via `email.send_draft` (still R3 / approval-
// gated). `email.create_draft` was demoted to R1 (auto, no approval) per ADR
// 0022 — drafts auto-save and the user sends manually — so it can no longer
// drive an approval pause. `email.send_draft` (the actual external send) stays
// R3 and is the correct tool to anchor the gate tests. Tests pre-create a real
// draft via the (now R1, directly callable) `createDraft` so send_draft has a
// draft to send on approve.
async function seedDraft(
  provider: EmailProvider,
  subject = 'Re: roadmap'
): Promise<string> {
  const draft = await provider.createDraft({
    accountId: 'mock-gmail-001',
    to: [{ name: 'Alice', address: 'alice@example.com' }],
    subject,
    body: 'I will review and reply by Friday.'
  })
  return draft.id
}

function sendApprovalRoutine(id: string, draftId: string): RoutineDefinition {
  const now = nowIso()
  return {
    id,
    name: 'Send Demo',
    description: 'approval-gated draft send',
    version: 1,
    enabled: true,
    trigger: { type: 'manual' },
    inputs: {},
    steps: [
      {
        id: 'send',
        type: 'approval',
        toolName: 'email.send_draft',
        title: 'Send reply draft',
        args: { accountId: 'mock-gmail-001', draftId }
      },
      { id: 'after', type: 'create_task', title: 'Draft sent — follow up' }
    ],
    approvalPolicy: 'writes_only',
    output: 'task',
    createdAt: now,
    updatedAt: now
  }
}

describe('approval flow', () => {
  it('pauses before the gated send and approves → executes + marks executed', async () => {
    const { engine, store, deps, emailProviders } = buildEngine()
    const draftId = await seedDraft(emailProviders[0])
    store.saveRoutine(sendApprovalRoutine('draft_demo', draftId))
    const run = await engine.run('draft_demo', { idempotencyKey: 'af-1' })
    expect(run.status).toBe('waiting_approval')

    const pending = deps.approvalService.list(true)
    expect(pending.length).toBe(1)
    const req = pending[0]
    expect(req.toolName).toBe('email.send_draft')
    expect(req.riskLevel).toBe('R3')

    deps.approvalService.approve(req.id)
    const resumed = await engine.resume(run.id, { approval: { requestId: req.id } })
    expect(resumed.status).toBe('completed')
    // The approval is now executed.
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')
    // Later step ran.
    expect(store.listTasks().map((t) => t.title)).toContain('Draft sent — follow up')
    // The draft was actually sent (consumed) — resending throws 未找到草稿.
    await expect(emailProviders[0].sendDraft(draftId)).rejects.toThrow(/未找到草稿/)
  })

  it('reject → run cancelled, the send NEVER executes (sends nothing)', async () => {
    const { engine, store, deps, emailProviders } = buildEngine()
    const draftId = await seedDraft(emailProviders[0])
    store.saveRoutine(sendApprovalRoutine('draft_reject', draftId))
    const run = await engine.run('draft_reject', { idempotencyKey: 'af-reject' })
    expect(run.status).toBe('waiting_approval')

    const req = deps.approvalService.list(true)[0]
    deps.approvalService.reject(req.id)
    const cancelled = await engine.cancelPausedRun(run.id)
    expect(cancelled.status).toBe('cancelled')
    // The gated send never ran — the later step never executed.
    expect(store.listTasks().length).toBe(0)
    // Approval stays rejected, not executed.
    expect(deps.approvalService.get(req.id)?.status).toBe('rejected')
  })

  it('content tamper between preview and execution → execution refused, run fails', async () => {
    const { engine, store, deps, emailProviders } = buildEngine()
    const draftId = await seedDraft(emailProviders[0])
    store.saveRoutine(sendApprovalRoutine('draft_tamper', draftId))
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
    // The gated send never executed — the approval stays approved, NOT
    // executed (the content mismatch refused the action before it ran).
    expect(deps.approvalService.get(req.id)?.status).not.toBe('executed')
  })

  it('a duplicate send run (same idempotency key) is a no-op — no duplicate send', async () => {
    const { engine, store, deps, emailProviders } = buildEngine()
    const draftId = await seedDraft(emailProviders[0])
    store.saveRoutine(sendApprovalRoutine('draft_dup', draftId))
    const run1 = await engine.run('draft_dup', { idempotencyKey: 'af-dup' })
    expect(run1.status).toBe('waiting_approval')
    const req = deps.approvalService.list(true)[0]
    deps.approvalService.approve(req.id)
    await engine.resume(run1.id, { approval: { requestId: req.id } })
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')

    // Re-run with the SAME key → returns the existing completed run, executes
    // nothing new, creates no second approval/send/task.
    const run2 = await engine.run('draft_dup', { idempotencyKey: 'af-dup' })
    expect(run2.id).toBe(run1.id)
    expect(run2.status).toBe('completed')
    // Only one approval ever existed for this run.
    expect(deps.approvalService.list().filter((a) => a.routineRunId === run1.id).length).toBe(1)
  })

  // Regression: an approval step whose args are FIELD-TEMPLATED against an
  // earlier step's output must hash identically at preview and resume. The
  // shape now: step 1 creates a draft via `email.create_draft` (R1, auto — no
  // approval), step 2 gates `email.send_draft` (R3) on `{{draft.id}}`. Earlier
  // the resume path resolved args against EMPTY outputs → every token
  // collapsed → hash mismatch → the approved action was refused. This anchors
  // content immutability for templated approval args.
  it('templated approval args hash-match at resume (content immutability holds)', async () => {
    const { engine, store, deps } = buildEngine()
    const now = nowIso()
    store.saveRoutine({
      id: 'draft_templated',
      name: 'Send Templated',
      description: 'approval-gated send with field-templated draftId',
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
          // R1 (auto, no approval) — creates a draft from the first unread
          // fixture, exposing its id to the next step.
          id: 'create_draft',
          type: 'tool',
          tool: 'email.create_draft',
          args: {
            accountId: 'mock-gmail-001',
            threadId: '{{gmailEmails[0].threadId}}',
            to: [{ address: '{{gmailEmails[0].from.address}}', name: '{{gmailEmails[0].from.name}}' }],
            subject: 'Re: {{gmailEmails[0].subject}}',
            body: 'Thanks — I will review and get back to you shortly.'
          },
          outputKey: 'draft'
        },
        {
          id: 'send',
          type: 'approval',
          toolName: 'email.send_draft',
          title: 'Send the drafted reply to {{gmailEmails[0].from.name}}',
          args: {
            accountId: 'mock-gmail-001',
            draftId: '{{draft.id}}'
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
    // The preview draftId was resolved from the create_draft step's output
    // (a real generated draft id), NOT a literal token.
    expect(typeof (req.preview as { draftId?: string }).draftId).toBe('string')
    expect((req.preview as { draftId?: string }).draftId).not.toBe('{{draft.id}}')

    deps.approvalService.approve(req.id)
    const resumed = await engine.resume(run.id, { approval: { requestId: req.id } })
    // Must complete — NOT fail with "content changed".
    expect(resumed.status).toBe('completed')
    expect(deps.approvalService.get(req.id)?.status).toBe('executed')
  })
})
