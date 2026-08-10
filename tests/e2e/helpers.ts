// Helpers for the Electron e2e suite (Spec §21 M4). Each test launches a fresh
// app instance with an isolated userData dir so it never touches the real user
// profile / DB / secrets. The credential-free mock path means no keys or tokens
// are required to exercise a full Routine → Approval → execution flow.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function launchDaymate(): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'daymate-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DAYMATE_USER_DATA: userData },
    timeout: 30_000
  })
  return app
}

// Wait for a window whose loaded <title> matches, polling app.windows() (the
// app opens robot then workbench at boot; both load asynchronously).
export async function waitForWindow(
  app: ElectronApplication,
  titleMatches: (title: string) => boolean,
  timeoutMs = 15_000
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    for (const w of app.windows()) {
      const t = await w.title()
      if (titleMatches(t)) return w
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for window matching title (${timeoutMs}ms)`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

export const robotWindow = (app: ElectronApplication): Promise<Page> =>
  waitForWindow(app, (t) => t.includes('机器人'))

export const workbenchWindow = (app: ElectronApplication): Promise<Page> =>
  waitForWindow(app, (t) => t === 'Daymate')

// Read the live robot state straight from main (the source of truth), via the
// typed preload bridge exposed on the page. Deterministic — not racy with React
// re-render timing.
export async function getRobotState(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { daymate: { getRobotState(): Promise<string> } }).daymate.getRobotState())
}

export async function getRobotStatesStable(page: Page, predicate: (s: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = 'idle'
  while (true) {
    last = await getRobotState(page)
    if (predicate(last)) return last
    if (Date.now() > deadline) throw new Error(`Robot state never matched predicate (last=${last})`)
    await new Promise((r) => setTimeout(r, 120))
  }
}
