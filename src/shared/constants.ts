// App-wide constants shared across main, preload and renderer.

export const APP_NAME = 'Daymate'

// Robot visual states mirror Agent runtime state. (Spec §4)
export const ROBOT_STATES = [
  'idle',
  'observing',
  'thinking',
  'working',
  'need_approval',
  'done',
  'error'
] as const

// Renderer windows. Each has its own HTML entry and React root.
export const WINDOWS = {
  robot: 'robot',
  workbench: 'workbench'
} as const

export type WindowName = (typeof WINDOWS)[keyof typeof WINDOWS]

// Typed IPC channel namespace. All renderer <-> main traffic goes through
// channels prefixed here. The preload is the only thing that touches ipcRenderer.
export const IPC = {
  // System / health
  PING: 'daymate:ping',
  GET_APP_INFO: 'daymate:get-app-info',
  GET_ROBOT_STATE: 'daymate:get-robot-state',
  SET_ROBOT_STATE: 'daymate:set-robot-state',
  // Window management
  OPEN_WINDOW: 'daymate:open-window'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
