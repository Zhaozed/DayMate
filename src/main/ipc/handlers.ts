// Main-process IPC handlers. Implements the typed DaymateApi surface.
// Everything here runs in main: no credential or token ever crosses to the
// renderer — only validated, plain-data responses do.

import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC } from './contracts'
import type { AppInfo, RobotState } from './contracts'
import { APP_NAME, WINDOWS, type WindowName } from '@shared/constants'
import { openWorkbench, openRobot } from '../windows'

// Milestone 0 in-memory robot state. From Milestone 1 onward the agent
// runtime owns this state and persists it via the Activity Service.
let currentRobotState: RobotState = 'idle'

export function getRobotState(): RobotState {
  return currentRobotState
}

export function setRobotState(next: RobotState): RobotState {
  currentRobotState = next
  // Push to the robot window so it can re-render its visual state.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.title === 'Daymate Robot') {
      win.webContents.send('daymate:robot-state-changed', next)
    }
  }
  return currentRobotState
}

function buildAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }
}

function openWindowByName(name: WindowName): void {
  if (name === WINDOWS.workbench) openWorkbench()
  else if (name === WINDOWS.robot) openRobot()
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.PING, () => 'pong')
  ipcMain.handle(IPC.GET_APP_INFO, () => buildAppInfo())
  ipcMain.handle(IPC.GET_ROBOT_STATE, () => getRobotState())
  ipcMain.handle(IPC.SET_ROBOT_STATE, (_e, state: RobotState) => setRobotState(state))
  ipcMain.handle(IPC.OPEN_WINDOW, (_e, name: WindowName) => openWindowByName(name))
}
