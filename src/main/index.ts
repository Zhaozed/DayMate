// Daymate main process entry.
// Spec §5 architecture constraint: all credentials, Provider calls, Pi Agent
// execution, Routine scheduling and database writes run here, in main. The
// renderer communicates through typed IPC only.

import { app, BrowserWindow } from 'electron'
import { openRobot, openWorkbench } from './windows'
import { installRobotContextMenu } from './windows/robot-window'
import { registerIpcHandlers, bootstrapContainer } from './ipc/handlers'
import { getContainer } from './app/container'
import { installContentSecurityPolicy } from './security/csp'

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
  // Persistent robot first (ambient surface), workbench on demand.
  openRobot()
  // Native right-click context menu on the robot (M4 §18). Actions inject the
  // container's scheduler + windows so robot-window stays cycle-free.
  installRobotContextMenu({
    onPause: () => getContainer().scheduler.pause(),
    onResume: () => getContainer().scheduler.resume(),
    onOpenWorkbench: () => openWorkbench(),
    onQuit: () => app.quit()
  })
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
      bootstrap()
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
