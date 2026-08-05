// Daymate main process entry.
// Spec §5 architecture constraint: all credentials, Provider calls, Pi Agent
// execution, Routine scheduling and database writes run here, in main. The
// renderer communicates through typed IPC only.

import { app, BrowserWindow } from 'electron'
import { openRobot, openWorkbench } from './windows'
import { registerIpcHandlers } from './ipc/handlers'

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
  registerIpcHandlers()
  // Persistent robot first (ambient surface), workbench on demand.
  openRobot()
  openWorkbench()
}

// Electron is ready.
app.whenReady().then(() => {
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
