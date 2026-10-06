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

    const dir = mkdtempSync(join(tmpdir(), 'daymate-m1-'))
    const dbPath = join(dir, 'daymate.db')

    // --- first "session": create the DB and run Morning Brief ---
    const { db: db1 } = createDb(dbPath)
    const store1 = new SqliteStore(db1)
    const taskService1 = new TaskService(store1)
    const ntkService1 = new NeedToKnowService(store1)
    const activityService1 = new ActivityService(store1)

    taskService1.create({
      title: 'Persist Task',
      priority: 'high',
      sourceType: 'user'
    })
    ntkService1.create({
      title: 'Persist NTK',
      summary: 'Summary text',
      reason: 'Reason text'
    })

    const run = {
      id: 'run-persist-1',
      routineId: 'test-routine',
      status: 'completed' as const,
      triggerType: 'manual',
      idempotencyKey: 'persist-1',
      inputs: {},
      stepOutputs: {},
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }
    store1.createRun(run)
    activityService1.record({
      runId: run.id,
      type: 'routine_started',
      summary: 'Started persist routine'
    })

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
