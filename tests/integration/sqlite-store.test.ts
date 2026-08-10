import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real-better-sqlite3 persistence test. This is the ONLY test that loads the
// native addon, so it is skipped when the binary is built for Electron's ABI
// (the default after `predev`/`prebuild`). To run it: rebuild for Node first
// (`pnpm rebuild better-sqlite3`), then `pnpm test`. See ADR 0002.
const req = createRequire(import.meta.url)
let nativeOk = false
try {
  // Probe by actually instantiating — `require` loads only the JS wrapper;
  // an ABI mismatch throws only when the native `.node` binding is used.
  const Database = req('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
  nativeOk = true
} catch {
  nativeOk = false
}

describe.runIf(nativeOk)('SqliteStore persistence (real better-sqlite3)', () => {
  it('persists Tasks, Need to Know and Routine runs across a "restart"', async () => {
    const { createDb } = await import('../../src/main/db/client')
    const { SqliteStore } = await import('../../src/main/db/sqlite-store')
    const { ActivityService } = await import('../../src/main/services/activity-service')
    const { TaskService } = await import('../../src/main/services/task-service')
    const { NeedToKnowService } = await import('../../src/main/services/need-to-know-service')
    const { ApprovalService } = await import('../../src/main/services/approval-service')
    const { MemoryService } = await import('../../src/main/services/memory-service')
    const { createDeterministicAgentRuntime } = await import('../../src/main/agent/agent-runtime')
    const { createToolRegistry } = await import('../../src/main/agent/tool-registry')
    const { RoutineEngine } = await import('../../src/main/routines/engine')
    const { seedPresets } = await import('../../src/main/routines/presets')
    const { MockEmailProvider } = await import('../../src/main/providers/email/mock-email-provider')
    const { MockCalendarProvider } = await import('../../src/main/providers/calendar/mock-calendar-provider')

    const dir = mkdtempSync(join(tmpdir(), 'daymate-m1-'))
    const dbPath = join(dir, 'daymate.db')

    // --- first "session": create the DB and run Morning Brief ---
    const { db: db1 } = createDb(dbPath)
    const store1 = new SqliteStore(db1)
    const engine = new RoutineEngine({
      store: store1,
      toolRegistry: createToolRegistry(),
      activityService: new ActivityService(store1),
      taskService: new TaskService(store1),
      needToKnowService: new NeedToKnowService(store1),
      approvalService: new ApprovalService(store1),
      memoryService: new MemoryService(store1),
      emailProviders: [new MockEmailProvider()],
      calendarProvider: new MockCalendarProvider(),
      agentRuntime: createDeterministicAgentRuntime(),
      notify: () => {}
    })
    seedPresets(store1)
    const run = await engine.run('morning_brief', { idempotencyKey: 'persist-1' })
    expect(run.status).toBe('completed')

    const taskBefore = store1.listTasks()
    const ntkBefore = store1.listNeedToKnow()
    const runsBefore = store1.listRuns()
    expect(taskBefore.length).toBe(1)
    expect(ntkBefore.length).toBe(1)
    expect(runsBefore.length).toBe(1)

    // M2: create an approval (with content_hash) and verify it survives too.
    const approvalService1 = new ApprovalService(store1)
    const approval = approvalService1.create({
      routineRunId: run.id,
      toolCallId: 'call-persist',
      toolName: 'email.send_draft',
      riskLevel: 'R3',
      title: 'Persist test',
      preview: { draftId: 'd-1' },
      args: { draftId: 'd-1' }
    })
    approvalService1.approve(approval.id)

    // --- "restart": open a fresh handle over the same file and read back ---
    const { db: db2 } = createDb(dbPath)
    const store2 = new SqliteStore(db2)
    expect(store2.listTasks().length).toBe(1)
    expect(store2.listTasks()[0].id).toBe(taskBefore[0].id)
    expect(store2.listNeedToKnow().length).toBe(1)
    expect(store2.listRuns().length).toBe(1)
    const resumed = store2.getRunByIdempotencyKey('persist-1')
    expect(resumed?.status).toBe('completed')

    // Activity also survives (every step still visible after restart).
    expect(store2.listActivity(run.id).length).toBeGreaterThan(0)

    // M2: the approval + its content_hash + status survive the restart.
    const approvalAfter = store2.getApproval(approval.id)
    expect(approvalAfter).toBeTruthy()
    expect(approvalAfter?.contentHash).toBe(approval.contentHash)
    expect(approvalAfter?.status).toBe('approved')
  })
})
