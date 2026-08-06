// IPC contract mirror for the main process.
// The canonical types live in src/shared so both sides import the same shape.
// This file exists per spec §7 repo structure to keep main-side wiring local.

export { IPC } from '@shared/constants'
export type {
  DaymateApi,
  RobotState,
  AppInfo,
  WindowName,
  TaskUpdate,
  Task,
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  NeedToKnow,
  ActivityEvent
} from '@shared/types'
