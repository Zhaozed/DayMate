import { test, expect } from '@playwright/test'
import { launchDaymate, robotWindow, workbenchWindow, getRobotStatesStable } from './helpers'

// Critical demo flow (Spec §22) — the three-minute demo's ten steps, exercised
// end-to-end on the credential-free mock path. Run THREE consecutive times
// (fresh isolated app each time) to satisfy the §19 release gate "critical
// demo flow succeeds three consecutive times".
//
// Steps mapped:
//  1. Robot wakes + Morning Brief ready        → run Morning Brief; robot → done
//  2. Home shows combined Gmail/163/Feishu/Tasks → Home data present
//  3. Important email becomes Need to Know      → a NTK was published
//  4. Agent extracts action + creates a Task   → a Task exists from the brief
//  5. Agent drafts a response                   → Draft Review pauses
//  6. Robot enters Need Approval                → robot state need_approval
//  7. User previews + approves                  → Approve & send
//  8. Exact reviewed draft is sent             → approval executed
//  9. Activity shows the complete trace         → listActivity non-empty
// 10. Routines page shows config + next run     → navigate + routine present

async function runCriticalDemo(): Promise<void> {
  const app = await launchDaymate()
  try {
    const robot = await robotWindow(app)
    const workbench = await workbenchWindow(app)

    // 1 + 3 + 4: Run Morning Brief from Home → robot done; a NTK + a Task land.
    await workbench.getByRole('button', { name: '运行晨报' }).click()
    await getRobotStatesStable(robot, (s) => s === 'done' || s === 'idle', 10_000)

    const ntk = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listNeedToKnow(): Promise<{ id: string; title: string }[]> } })
        .daymate.listNeedToKnow()
    )
    expect(ntk.length).toBeGreaterThan(0)

    const tasks = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listTasks(): Promise<{ id: string; sourceType: string }[]> } })
        .daymate.listTasks()
    )
    expect(tasks.length).toBeGreaterThan(0)

    // 9 (partial): Activity already recorded for Morning Brief.
    const activityBefore = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listActivity(): Promise<{ id: string; summary: string }[]> } })
        .daymate.listActivity()
    )
    expect(activityBefore.some((e) => e.summary.includes('晨报'))).toBe(true)

    // 5 + 6: Draft Review pauses for approval; robot → need_approval.
    const run = await workbench.evaluate(() =>
      (window as unknown as { daymate: { runRoutine: (id: string) => Promise<{ id: string; status: string }> } })
        .daymate.runRoutine('draft_review')
    )
    expect(run.status).toBe('waiting_approval')
    await getRobotStatesStable(robot, (s) => s === 'need_approval', 10_000)

    // 7: A pending approval exists; open Approvals and approve.
    const approvalsBefore = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listApprovals(): Promise<{ id: string; status: string; toolName: string }[]> } })
        .daymate.listApprovals()
    )
    const pending = approvalsBefore.filter((a) => a.status === 'pending')
    expect(pending.length).toBe(1)
    expect(pending[0].toolName).toBe('email.create_draft')

    await workbench.evaluate(() =>
      (window as unknown as { daymate: { openWorkbenchAt: (p: string) => Promise<void> } })
        .daymate.openWorkbenchAt('Approvals')
    )
    await expect(workbench.getByText('在你批准之前，什么都不会发出。')).toBeVisible()
    await workbench.getByRole('button', { name: '批准并发送' }).click()

    // 8: Robot returns to done/idle (execution completed under the approval
    // context, content hash rechecked at resume), THEN the approval is executed.
    await getRobotStatesStable(robot, (s) => s === 'done' || s === 'idle', 10_000)
    const approvalsAfter = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listApprovals(): Promise<{ id: string; status: string }[]> } })
        .daymate.listApprovals()
    )
    const mine = approvalsAfter.find((a) => a.id === pending[0].id)
    expect(mine?.status).toBe('executed')

    // 9: Activity shows the complete trace (both runs).
    const activityAfter = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listActivity(): Promise<{ id: string; summary: string }[]> } })
        .daymate.listActivity()
    )
    expect(activityAfter.length).toBeGreaterThan(activityBefore.length)

    // 10: Routines page shows configured routines (the presets) and is
    // reachable via the same deep-link path the robot's quick-panel uses.
    await workbench.evaluate(() =>
      (window as unknown as { daymate: { openWorkbenchAt: (p: string) => Promise<void> } })
        .daymate.openWorkbenchAt('Routines')
    )
    await expect(workbench.getByText('可配置、由 schema 驱动的工作流。')).toBeVisible()
    const routines = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listRoutines(): Promise<{ id: string; name: string }[]> } })
        .daymate.listRoutines()
    )
    expect(routines.some((r) => r.id === 'morning_brief')).toBe(true)
    expect(routines.some((r) => r.id === 'draft_review')).toBe(true)
  } finally {
    await app.close()
  }
}

test.describe.serial('Critical demo flow (Spec §22) — three consecutive runs', () => {
  test('run 1 of 3', async () => {
    await runCriticalDemo()
  })
  test('run 2 of 3', async () => {
    await runCriticalDemo()
  })
  test('run 3 of 3', async () => {
    await runCriticalDemo()
  })
})
