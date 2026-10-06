// Daymate main process entry.
// Spec §5 architecture constraint: all credentials, Provider calls, Pi Agent
// execution, Routine scheduling and database writes run here, in main. The
// renderer communicates through typed IPC only.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { openWorkbench } from './windows'
import { registerIpcHandlers, bootstrapContainer } from './ipc/handlers'
import { installContentSecurityPolicy } from './security/csp'

// Load .env configuration (e.g. DAYMATE_SERVER_URL for remote cloud mode)
try {
  if (typeof process.loadEnvFile === 'function') {
    const envPath = resolve(process.cwd(), '.env')
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath)
    }
  }
} catch {
  // Ignore env loading error
}

// Prevent transient background network/socket errors (e.g. IMAP ECONNRESET, Socket timeout)
// from triggering Electron's default native modal crash dialogs.
process.on('uncaughtException', (err) => {
  console.error('[main process] Uncaught Exception:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[main process] Unhandled Rejection:', reason)
})

// Single-instance lock — the robot is a persistent ambient surface.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  // Re-show the workbench if someone launches a second copy.
  openWorkbench()
})

function bootstrap(): void {
  installContentSecurityPolicy()
  // Open the DB, seed presets, start the scheduler — must happen after app
  // is ready so app.getPath('userData') resolves.
  bootstrapContainer()
  registerIpcHandlers()
  // Launch the workbench directly (desktop robot orb removed per user preference)
  openWorkbench()
}

// Electron is ready.
app.whenReady().then(() => {
  // E2E isolation: when Playwright sets DAYMATE_USER_DATA, point userData at a
  // fresh temp dir BEFORE bootstrap reads it (DB + secrets + settings all live
  // under userData). Spec §21: DB persists in userData; tests must not clobber
  // the real user profile.
  if (process.env.DAYMATE_USER_DATA) {
    app.setPath('userData', process.env.DAYMATE_USER_DATA)
  }
  bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWorkbench()
    }
  })
})

// macOS: keep running with no windows (robot reopens on activate).
// Quit when all windows are closed on non-macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
