import { defineConfig } from '@playwright/test'

// Playwright Electron e2e (Spec §21 M4). Uses the bundled Electron via
// `_electron.launch` — no browser download is needed. The `out/` bundle
// (built by `pnpm build`, which the test:e2e script runs first) is the app.
//
// Each test isolates userData via the DAYMATE_USER_DATA env var (see
// main/index.ts) so runs never touch the real user profile or DB.

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Electron single-instance + shared DB → run serially.
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure'
  }
})
