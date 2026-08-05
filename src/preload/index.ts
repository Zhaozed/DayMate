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
  openWindow: (name) => ipcRenderer.invoke(IPC.OPEN_WINDOW, name)
}

// contextIsolation is on; this is the safe way to give the renderer a typed API.
contextBridge.exposeInMainWorld('daymate', api)
