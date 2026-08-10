import { test, expect } from '@playwright/test'
import { launchDaymate, robotWindow, workbenchWindow, getRobotState } from './helpers'

// Boot smoke (Spec §21 M4). The app launches both windows and the robot starts
// in the idle state (the ambient surface, no spurious activity).
test.describe('boot', () => {
  test('opens robot + workbench windows and reports idle state', async () => {
    const app = await launchDaymate()
    try {
      const robot = await robotWindow(app)
      const workbench = await workbenchWindow(app)
      expect(await robot.title()).toBe('Daymate 机器人')
      expect(await workbench.title()).toBe('Daymate')

      // Robot reflects the idle ambient state — no Node APIs exposed to the
      // renderer; the typed bridge is the only path (Spec §5/§6).
      expect(await getRobotState(robot)).toBe('idle')
      expect(await getRobotState(workbench)).toBe('idle')
    } finally {
      await app.close()
    }
  })
})
