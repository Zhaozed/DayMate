// Milestone D §D2 — the engine's `notify` step routes through `notifyRich`
// (when wired) carrying the firing routineId + `routine` category, so the
// NotificationService can apply per-routine toggles + quiet hours. Verifies
// the rich path is actually used (not the plain legacy `notify`).
import { describe, it, expect } from 'vitest'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockMail163Provider } from '../../src/main/providers/email/mock-mail163-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'

describe('engine notifyRich path (Milestone D §D2)', () => {
  it('a routine notify step calls notifyRich with routineId + category', async () => {
    const store = new InMemoryStore()
    const activityService = new ActivityService(store)
    const applicationService = new ApplicationService(store, new MockBossProvider(), activityService)
    const plain: string[] = []
    const rich: Array<{ message: string; category?: string; routineId?: string }> = []
    const deps: EngineDeps = {
      store,
      toolRegistry: createToolRegistry(),
      activityService,
      taskService: new TaskService(store),
      needToKnowService: new NeedToKnowService(store),
      approvalService: new ApprovalService(store),
      emailProviders: [new MockEmailProvider(), new MockMail163Provider()],
      calendarProvider: new MockCalendarProvider(),
      bossProvider: new MockBossProvider(),
      agentRuntime: createDeterministicAgentRuntime(),
      memoryService: new MemoryService(store),
      applicationService,
      notify: (m) => {
        plain.push(m)
      },
      notifyRich: (input) => {
        rich.push({ message: input.message, category: input.category, routineId: input.routineId })
      }
    }
    const engine = new RoutineEngine(deps)
    seedPresets(store)
    store.saveRoutine({ ...store.getRoutine('morning_brief')!, enabled: true })

    await engine.run('morning_brief', { manual: true })

    // The morning_brief preset ends with a `notify` step — the rich path must
    // have fired with the routine's id + the `routine` category, and the plain
    // path must NOT have been used (notifyRich takes precedence).
    const morningRich = rich.find((r) => r.routineId === 'morning_brief')
    expect(morningRich).toBeDefined()
    expect(morningRich!.category).toBe('routine')
    expect(plain).toHaveLength(0)
  })

  it('falls back to the plain notify path when notifyRich is absent (tests)', async () => {
    const store = new InMemoryStore()
    const activityService = new ActivityService(store)
    const applicationService = new ApplicationService(store, new MockBossProvider(), activityService)
    const plain: string[] = []
    const deps: EngineDeps = {
      store,
      toolRegistry: createToolRegistry(),
      activityService,
      taskService: new TaskService(store),
      needToKnowService: new NeedToKnowService(store),
      approvalService: new ApprovalService(store),
      emailProviders: [new MockEmailProvider(), new MockMail163Provider()],
      calendarProvider: new MockCalendarProvider(),
      bossProvider: new MockBossProvider(),
      agentRuntime: createDeterministicAgentRuntime(),
      memoryService: new MemoryService(store),
      applicationService,
      notify: (m) => {
        plain.push(m)
      }
    }
    const engine = new RoutineEngine(deps)
    seedPresets(store)
    store.saveRoutine({ ...store.getRoutine('morning_brief')!, enabled: true })
    await engine.run('morning_brief', { manual: true })
    expect(plain.length).toBeGreaterThan(0) // legacy path used
  })
})
