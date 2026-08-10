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
import { seedPresets } from '../../src/main/routines/presets'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import type { RoutineDefinition } from '@shared/types'

// Custom Routine builder (Spec §14). Users assemble routines from constrained,
// schema-validated building blocks — they cannot insert arbitrary code. The
// engine re-parses with routineTemplateSchema, refuses preset ids, refuses
// duplicates, and refuses to delete a preset or a routine with an in-flight run.

function buildEngine() {
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

// A valid custom routine assembled from constrained building blocks.
function customDef(): Omit<RoutineDefinition, 'createdAt' | 'updatedAt'> {
  return {
    id: 'my_triage',
    name: 'My Triage',
    description: 'List unread mail then notify',
    version: 1,
    enabled: true,
    trigger: { type: 'manual' },
    inputs: {},
    steps: [
      { id: 's1', type: 'tool', tool: 'email.list', args: { unreadOnly: true, limit: 10 }, outputKey: 'emails', continueOnError: true },
      { id: 's2', type: 'notify', channel: 'desktop_robot', message: 'Inbox triaged' }
    ],
    approvalPolicy: 'writes_only',
    output: 'notification'
  }
}

describe('custom routine builder (Spec §14)', () => {
  it('creates a schema-valid custom routine and runs it', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)

    const created = await engine.createRoutine(customDef())
    expect(created.id).toBe('my_triage')
    expect(store.getRoutine('my_triage')?.name).toBe('My Triage')

    const run = await engine.run('my_triage', { idempotencyKey: 'ct-1' })
    expect(run.status).toBe('completed')
  })

  it('refuses to create a routine with a reserved preset id', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    await expect(
      engine.createRoutine({ ...customDef(), id: 'morning_brief' })
    ).rejects.toThrow(/受保留的预设 id/)
  })

  it('refuses a duplicate id', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    await engine.createRoutine(customDef())
    await expect(engine.createRoutine(customDef())).rejects.toThrow(/已存在/)
  })

  it('refuses a malformed routine (no arbitrary code path) — schema rejects it', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    // Unknown step type — the schema union rejects it.
    const bad = { ...customDef(), id: 'bad1', steps: [{ id: 'x', type: 'exec_shell' as const }] }
    await expect(engine.createRoutine(bad as never)).rejects.toThrow()
    expect(store.getRoutine('bad1')).toBeUndefined()
  })

  it('refuses a routine whose approval step references an unknown tool', async () => {
    // The schema accepts any toolName string, so the builder must additionally
    // constrain tool names. Here we assert the engine refuses an approval step
    // whose toolName is not registered — defence in depth beyond the schema.
    const { engine, store } = buildEngine()
    seedPresets(store)
    const def = {
      ...customDef(),
      id: 'bad2',
      steps: [
        { id: 's1', type: 'approval' as const, toolName: 'shell.exec', title: 'run something', args: {} }
      ]
    }
    await expect(engine.createRoutine(def)).rejects.toThrow()
    expect(store.getRoutine('bad2')).toBeUndefined()
  })

  it('deletes a custom routine; refuses to delete a preset', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    await engine.createRoutine(customDef())
    await engine.deleteRoutine('my_triage')
    expect(store.getRoutine('my_triage')).toBeUndefined()
    // Idempotent: deleting again is a no-op.
    await engine.deleteRoutine('my_triage')

    // Presets cannot be deleted.
    await expect(engine.deleteRoutine('morning_brief')).rejects.toThrow(/无法删除预设例程/)
    expect(store.getRoutine('morning_brief')).toBeDefined()
  })

  it('refuses to delete a routine with an in-flight run', async () => {
    const { engine, store } = buildEngine()
    seedPresets(store)
    await engine.createRoutine(customDef())
    // Simulate an in-flight run waiting on approval by inserting a run record.
    store.createRun({
      id: 'run-inflight',
      routineId: 'my_triage',
      status: 'waiting_approval',
      triggerType: 'manual',
      idempotencyKey: 'inflight',
      currentStepId: 's1',
      inputs: {},
      stepOutputs: {},
      startedAt: new Date().toISOString()
    })
    await expect(engine.deleteRoutine('my_triage')).rejects.toThrow(/存在.*状态的运行/)
  })
})
