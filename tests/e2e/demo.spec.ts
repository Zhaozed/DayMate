import { test, expect } from '@playwright/test'
import { launchDaymate, robotWindow, workbenchWindow, getRobotStatesStable } from './helpers'

// Critical demo flow (Spec §22) — exercised end-to-end on the credential-free
// mock path. Run THREE consecutive times (fresh isolated app each time) to
// satisfy the §19 release gate "critical demo flow succeeds three consecutive
// times".
//
// The slimmed product (ADR 0022) has no draft-approval step in the critical
// flow: `email.create_draft` is R1 (auto, no approval — drafts save to the
// Drafts folder and the user sends manually); the §15 send gate is covered by
// the integration `approval-flow.test.ts` (via `email.send_draft`). This e2e
// therefore traces the new product's main line:
//  1. Run Morning Brief from Home        → robot → done
//  2. Morning Brief publishes Need-to-Know → a 必读 item exists (urgent/high)
//  3. Morning Brief extracts an action     → a Task exists
//  4. Activity shows the brief trace       → listActivity non-empty
//  5. Routines page shows the active presets and no retired ones
//     (morning_brief / auto_inbox / interview_prep present; draft_review /
//     meeting_prep / daily_work_summary / job_recommendation absent)

async function runCriticalDemo(): Promise<void> {
  const app = await launchDaymate()
  try {
    const robot = await robotWindow(app)
    const workbench = await workbenchWindow(app)

    // 1: Run Morning Brief from Home → robot done.
    await workbench.getByRole('button', { name: '运行晨报' }).click()
    await getRobotStatesStable(robot, (s) => s === 'done' || s === 'idle', 10_000)

    // 2: A 必读 item was published (the page filters to urgent/high; the IPC
    // returns all, so assert at least one is urgent or high — the only kind
    // the slimmed 必读 page surfaces).
    const ntk = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listNeedToKnow(): Promise<{ id: string; title: string; priority: string }[]> } })
        .daymate.listNeedToKnow()
    )
    expect(ntk.length).toBeGreaterThan(0)
    expect(ntk.some((n) => n.priority === 'urgent' || n.priority === 'high')).toBe(true)

    // 3: A Task was created from the brief.
    const tasks = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listTasks(): Promise<{ id: string; sourceType: string }[]> } })
        .daymate.listTasks()
    )
    expect(tasks.length).toBeGreaterThan(0)

    // 4: Activity recorded the Morning Brief trace.
    const activity = await workbench.evaluate(() =>
      (window as unknown as { daymate: { listActivity(): Promise<{ id: string; summary: string }[]> } })
        .daymate.listActivity()
    )
    expect(activity.some((e) => e.summary.includes('晨报'))).toBe(true)

    // 5: Routines page shows the active presets and no retired ones. Reachable
    // via the same deep-link path the robot's quick-panel uses.
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
    expect(routines.some((r) => r.id === 'interview_prep')).toBe(true)
    // Retired presets must not survive seedPresets' boot cleanup.
    expect(routines.some((r) => r.id === 'auto_inbox')).toBe(false)
    expect(routines.some((r) => r.id === 'draft_review')).toBe(false)
    expect(routines.some((r) => r.id === 'meeting_prep')).toBe(false)
    expect(routines.some((r) => r.id === 'daily_work_summary')).toBe(false)
    expect(routines.some((r) => r.id === 'job_recommendation')).toBe(false)
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
