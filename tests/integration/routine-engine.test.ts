import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import { nowIso } from '../../src/main/util/ids'
import type { RoutineDefinition } from '@shared/types'

function buildEngine(): { engine: RoutineEngine; store: InMemoryStore; deps: EngineDeps } {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const deps: EngineDeps = {
    store,
    toolRegistry: createToolRegistry(),
    activityService,
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    approvalService: new ApprovalService(store),
    emailProviders: [new MockEmailProvider()],
    calendarProvider: new MockCalendarProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    notify: () => {}
  }
  return { engine: new RoutineEngine(deps), store, deps }
}



describe('routine engine — pause and resume after approval', () => {
  it('pauses on an R3 tool and resumes after approval, running later steps', async () => {
    const { engine, store, deps } = buildEngine()
    const now = nowIso()
    // `email.create_draft` is R1 (auto, no approval — ADR 0022), so it can no
    // longer drive a pause. `email.send_draft` (the actual external send) stays
    // R3 and is the gated tool here; pre-seed a real draft so send_draft has a
    // draft to send on approve.
    const draftId = (
      await deps.emailProviders[0].createDraft({
        accountId: 'mock-gmail-001',
        to: [{ address: 'someone@example.com' }],
        subject: 'draft',
        body: 'body'
      })
    ).id
    const routine: RoutineDefinition = {
      id: 'approval_demo',
      name: 'Approval Demo',
      description: 'pause then resume',
      version: 1,
      enabled: true,
      trigger: { type: 'manual' },
      inputs: {},
      steps: [
        { id: 'before', type: 'create_task', title: 'Before approval' },
        {
          id: 'send_draft',
          type: 'tool',
          tool: 'email.send_draft',
          args: { accountId: 'mock-gmail-001', draftId }
        },
        { id: 'after', type: 'create_task', title: 'After approval' }
      ],
      approvalPolicy: 'writes_only',
      output: 'task',
      createdAt: now,
      updatedAt: now
    }
    store.saveRoutine(routine)

    const run = await engine.run('approval_demo', { idempotencyKey: 'appr-1' })
    // Paused before the gated action executes and before later steps.
    expect(run.status).toBe('waiting_approval')
    expect(run.currentStepId).toBe('send_draft')
    expect(store.listTasks().map((t) => t.title)).toEqual(['Before approval'])

    // The engine created an ApprovalRequest for the gated action (M2).
    const pending = deps.approvalService.list(true)
    expect(pending.length).toBe(1)
    const request = pending[0]
    deps.approvalService.approve(request.id)

    // Resume with the real approval context — the gated step runs, then later steps.
    const resumed = await engine.resume(run.id, { approval: { requestId: request.id } })
    expect(resumed.status).toBe('completed')
    expect(resumed.currentStepId).toBeUndefined()
    expect(store.listTasks().map((t) => t.title).sort()).toEqual(['After approval', 'Before approval'])
    // The approval is now marked executed.
    expect(deps.approvalService.get(request.id)?.status).toBe('executed')
  })
})
