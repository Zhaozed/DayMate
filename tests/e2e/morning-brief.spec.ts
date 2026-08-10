import { test, expect } from '@playwright/test'
import { launchDaymate, robotWindow, workbenchWindow, getRobotStatesStable } from './helpers'

// Morning Brief end-to-end (Spec §21 M4). Run the credential-free mock Morning
// Brief from Home and assert the robot reflects the live runtime state
// (working/thinking → done) and the Activity log records the run.
test.describe('Morning Brief', () => {
  test('run from Home drives robot state and records activity', async () => {
    const app = await launchDaymate()
    try {
      const robot = await robotWindow(app)
      const workbench = await workbenchWindow(app)

      // Home is the default page; its "Run Morning Brief" button fires the
      // manual run (deterministic stub — no LLM key needed).
      await workbench.getByRole('button', { name: '运行晨报' }).click()

      // The run completes near-instantly; the controller sets 'done' on
      // routine_completed (then resets to idle after ~6s — accept either).
      const final = await getRobotStatesStable(
        robot,
        (s) => s === 'done' || s === 'idle',
        10_000
      )
      expect(['done', 'idle']).toContain(final)

      // Activity was recorded for the run (the push channel updated Home).
      const activity = await workbench.evaluate(() =>
        (window as unknown as { daymate: { listActivity(): Promise<{ id: string; summary: string }[]> } })
          .daymate.listActivity()
      )
      expect(activity.length).toBeGreaterThan(0)
      expect(activity.some((e) => e.summary.includes('晨报'))).toBe(true)
    } finally {
      await app.close()
    }
  })
})
