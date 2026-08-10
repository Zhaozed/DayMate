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

describe('routine engine — Morning Brief end to end', () => {
  it('runs the mock Morning Brief to completion and records every step', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const run = await engine.run('morning_brief', { manual: true, idempotencyKey: 'k1' })
    expect(run.status).toBe('completed')

    const activity = store.listActivity(run.id)
    // routine_started, 5× (tool_requested+tool_completed: email.list, calendar.list,
    // task.list, memory.search, memory.save_proposals), agent_started, create_task
    // completed, need_to_know completed, notify completed, routine_completed.
    const types = activity.map((e) => e.type)
    expect(types).toContain('routine_started')
    expect(types).toContain('routine_completed')
    expect(types.filter((t) => t === 'tool_requested').length).toBe(5)
    expect(types.filter((t) => t === 'tool_completed').length).toBeGreaterThanOrEqual(6)
    expect(types).toContain('agent_started')

    // A Task was created from the brief's suggested action.
    const tasks = store.listTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0].sourceId).toBe('mock-msg-001')
    expect(tasks[0].routineRunId).toBe(run.id)

    // A Need to Know was published.
    const ntk = store.listNeedToKnow()
    expect(ntk.length).toBe(1)
    expect(ntk[0].sourceRefs.length).toBeGreaterThan(0)

    // A passive memory proposal landed from the brief (§16): the priority
    // sender became a proposed (NOT yet confirmed) `contact` entry.
    const memory = store.listMemory()
    const proposed = memory.filter((m) => !m.confirmed)
    expect(proposed.length).toBeGreaterThan(0)
    expect(proposed.some((m) => m.key === 'contact' && m.value.includes('alice@example.com'))).toBe(true)
  })

  it('is idempotent: a second run with the same key is a no-op and does not duplicate Tasks', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const first = await engine.run('morning_brief', { idempotencyKey: 'dup-key' })
    const second = await engine.run('morning_brief', { idempotencyKey: 'dup-key' })
    expect(second.id).toBe(first.id)
    // Only one run record and one task — no duplicate external writes.
    expect(store.listRuns().length).toBe(1)
    expect(store.listTasks().length).toBe(1)
  })

  it('never acts on the prompt-injection fixture (no task/ntk from it)', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    await engine.run('morning_brief', { idempotencyKey: 'inj' })
    // The only task created references the trusted roadmap email (mock-msg-001),
    // never the injection email (mock-msg-003).
    const tasks = store.listTasks()
    expect(tasks.every((t) => t.sourceId !== 'mock-msg-003')).toBe(true)
  })
})

describe('routine engine — pause and resume after approval', () => {
  it('pauses on an R3 tool and resumes after approval, running later steps', async () => {
    const { engine, store, deps } = buildEngine()
    const now = nowIso()
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
          id: 'create_draft',
          type: 'tool',
          tool: 'email.create_draft',
          args: {
            accountId: 'mock-gmail-001',
            to: [{ address: 'someone@example.com' }],
            subject: 'draft',
            body: 'body'
          }
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
    expect(run.currentStepId).toBe('create_draft')
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
