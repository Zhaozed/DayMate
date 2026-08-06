// Preload bridge. This is the ONLY path between the renderer and Node/Electron.
// Spec §5/§6: renderer communicates through typed IPC only. Never expose
// Node.js, tokens, authorization codes or raw database access to the renderer.
//
// Both the robot and workbench windows load this same preload. It exposes a
// single typed `window.daymate` API; the renderer never touches ipcRenderer.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/constants'
import type { DaymateApi } from '@shared/types'

const api: DaymateApi = {
  ping: () => ipcRenderer.invoke(IPC.PING),
  getAppInfo: () => ipcRenderer.invoke(IPC.GET_APP_INFO),
  getRobotState: () => ipcRenderer.invoke(IPC.GET_ROBOT_STATE),
  setRobotState: (state) => ipcRenderer.invoke(IPC.SET_ROBOT_STATE, state),
  openWindow: (name) => ipcRenderer.invoke(IPC.OPEN_WINDOW, name),

  // Routines (M1)
  listRoutines: () => ipcRenderer.invoke(IPC.ROUTINE_LIST),
  runRoutine: (routineId) => ipcRenderer.invoke(IPC.ROUTINE_RUN, routineId),
  listRoutineRuns: (routineId) => ipcRenderer.invoke(IPC.ROUTINE_LIST_RUNS, routineId),
  getRoutineRun: (runId) => ipcRenderer.invoke(IPC.ROUTINE_GET_RUN, runId),
  setRoutineEnabled: (routineId, enabled) =>
    ipcRenderer.invoke(IPC.ROUTINE_SET_ENABLED, routineId, enabled),

  // Tasks (M1)
  listTasks: () => ipcRenderer.invoke(IPC.TASK_LIST),
  updateTask: (id, patch) => ipcRenderer.invoke(IPC.TASK_UPDATE, id, patch),

  // Need to Know (M1)
  listNeedToKnow: () => ipcRenderer.invoke(IPC.NEED_TO_KNOW_LIST),

  // Activity (M1)
  listActivity: (runId) => ipcRenderer.invoke(IPC.ACTIVITY_LIST, runId),
  onActivityChanged: (cb) => {
    const listener = (_e: unknown, events: Parameters<typeof cb>[0]): void => cb(events)
    ipcRenderer.on(IPC.ACTIVITY_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.ACTIVITY_CHANGED, listener)
  },

  // Approvals (M2 — Spec §8, §15, §18)
  listApprovals: () => ipcRenderer.invoke(IPC.APPROVAL_LIST),
  getApproval: (id) => ipcRenderer.invoke(IPC.APPROVAL_GET, id),
  approveRequest: (id) => ipcRenderer.invoke(IPC.APPROVAL_APPROVE, id),
  rejectRequest: (id) => ipcRenderer.invoke(IPC.APPROVAL_REJECT, id),
  onApprovalChanged: (cb) => {
    const listener = (_e: unknown, approvals: Parameters<typeof cb>[0]): void => cb(approvals)
    ipcRenderer.on(IPC.APPROVAL_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.APPROVAL_CHANGED, listener)
  }
}

// contextIsolation is on; this is the safe way to give the renderer a typed API.
contextBridge.exposeInMainWorld('daymate', api)
