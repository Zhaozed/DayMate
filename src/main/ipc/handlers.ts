// Main-process IPC handlers. Implements the typed DaymateApi surface.
// Everything here runs in main: no credential or token ever crosses to the
// renderer — only validated, plain-data responses do.

import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC } from './contracts'
import type { AppInfo, RobotState, WindowName, TaskUpdate } from './contracts'
import { APP_NAME, WINDOWS } from '@shared/constants'
import { openWorkbench, openRobot } from '../windows'
import { getContainer, initContainer } from '../app/container'

// M0 in-memory robot state. From M1 onward the agent runtime drives this via
// the notify callback (container.ts); it is still surfaced to the renderer
// through getRobotState/setRobotState.
let currentRobotState: RobotState = 'idle'

export function getRobotState(): RobotState {
  return currentRobotState
}

export function setRobotState(next: RobotState): RobotState {
  currentRobotState = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.title === `${APP_NAME} Robot` || win.title === 'Daymate Robot') {
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
  // System / health
  ipcMain.handle(IPC.PING, () => 'pong')
  ipcMain.handle(IPC.GET_APP_INFO, () => buildAppInfo())
  ipcMain.handle(IPC.GET_ROBOT_STATE, () => getRobotState())
  ipcMain.handle(IPC.SET_ROBOT_STATE, (_e, state: RobotState) => setRobotState(state))
  ipcMain.handle(IPC.OPEN_WINDOW, (_e, name: WindowName) => openWindowByName(name))

  const container = getContainer()

  // Routines
  ipcMain.handle(IPC.ROUTINE_LIST, () => container.store.listRoutines())
  ipcMain.handle(IPC.ROUTINE_RUN, async (_e, routineId: string) => {
    const run = await container.engine.run(routineId, { manual: true })
    container.broadcastActivity(run.id)
    return run
  })
  ipcMain.handle(IPC.ROUTINE_LIST_RUNS, (_e, routineId?: string) =>
    container.store.listRuns(routineId)
  )
  ipcMain.handle(IPC.ROUTINE_GET_RUN, (_e, runId: string) => {
    const run = container.store.getRun(runId)
    const steps = container.store.listRunSteps(runId)
    return { run, steps }
  })
  ipcMain.handle(IPC.ROUTINE_SET_ENABLED, (_e, routineId: string, enabled: boolean) => {
    const next = container.store.setRoutineEnabled(routineId, enabled)
    container.scheduler.reschedule()
    return next
  })

  // Tasks
  ipcMain.handle(IPC.TASK_LIST, () => container.taskService.list())
  ipcMain.handle(IPC.TASK_UPDATE, (_e, id: string, patch: TaskUpdate) =>
    container.taskService.update(id, patch)
  )

  // Need to Know
  ipcMain.handle(IPC.NEED_TO_KNOW_LIST, () => container.needToKnowService.list())

  // Activity
  ipcMain.handle(IPC.ACTIVITY_LIST, (_e, runId?: string) =>
    container.activityService.list(runId)
  )
}

// Called from bootstrap once the app is ready and the DB path is resolvable.
export function bootstrapContainer(): void {
  initContainer()
}
