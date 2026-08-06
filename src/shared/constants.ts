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

// ── Domain enum types (derived from the const arrays above) ────────────────
export type RobotState = (typeof ROBOT_STATES)[number]
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskPriority = (typeof TASK_PRIORITIES)[number]
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number]
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number]
export type StepStatus = (typeof STEP_STATUSES)[number]
export type RiskLevel = (typeof RISK_LEVELS)[number]
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]
export type RoutineOutput = (typeof ROUTINE_OUTPUTS)[number]
export type RoutineStepType = (typeof ROUTINE_STEP_TYPES)[number]
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number]

// ── Domain enums (Spec §8) ────────────────────────────────────────────────
export const TASK_STATUSES = [
  'need_to_know',
  'need_approval',
  'todo',
  'waiting',
  'done',
  'dismissed'
] as const

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

export const TASK_SOURCE_TYPES = ['email', 'calendar', 'assistant', 'routine'] as const

export const INTEGRATION_STATUSES = [
  'connected',
  'expired',
  'error',
  'disconnected'
] as const

export const ACCOUNT_PROVIDERS = ['gmail', 'mail163', 'feishu'] as const

export const ROUTINE_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled'
] as const

export const STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
  'waiting_approval'
] as const

// Risk levels gate external writes. (Spec §11)
// R0/R1 automatic, R2 approval, R3 preview+approval, R4 forbidden in MVP.
export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed'
] as const

export const APPROVAL_POLICIES = ['none', 'writes_only', 'all_actions'] as const

export const ROUTINE_OUTPUTS = [
  'need_to_know',
  'task',
  'assistant',
  'notification'
] as const

export const ROUTINE_STEP_TYPES = [
  'tool',
  'agent',
  'condition',
  'create_task',
  'need_to_know',
  'approval',
  'notify'
] as const

// Activity event types. (Spec §8)
export const ACTIVITY_EVENT_TYPES = [
  'routine_started',
  'routine_completed',
  'routine_failed',
  'agent_started',
  'tool_requested',
  'tool_completed',
  'tool_failed',
  'approval_requested',
  'approval_resolved'
] as const

// ── IPC channel namespace ───────────────────────────────────────────────────
// All renderer <-> main traffic goes through channels prefixed here. The preload
// is the only thing that touches ipcRenderer.
export const IPC = {
  // System / health
  PING: 'daymate:ping',
  GET_APP_INFO: 'daymate:get-app-info',
  GET_ROBOT_STATE: 'daymate:get-robot-state',
  SET_ROBOT_STATE: 'daymate:set-robot-state',
  // Window management
  OPEN_WINDOW: 'daymate:open-window',
  // Routines (M1)
  ROUTINE_LIST: 'daymate:routine:list',
  ROUTINE_RUN: 'daymate:routine:run',
  ROUTINE_LIST_RUNS: 'daymate:routine:list-runs',
  ROUTINE_GET_RUN: 'daymate:routine:get-run',
  ROUTINE_SET_ENABLED: 'daymate:routine:set-enabled',
  // Tasks (M1)
  TASK_LIST: 'daymate:task:list',
  TASK_UPDATE: 'daymate:task:update',
  // Need to Know (M1)
  NEED_TO_KNOW_LIST: 'daymate:need-to-know:list',
  // Activity (M1)
  ACTIVITY_LIST: 'daymate:activity:list',
  ACTIVITY_CHANGED: 'daymate:activity:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// Hard ceiling on Routine step execution to prevent runaway loops. (Spec §12.7)
export const ROUTINE_MAX_STEPS = 100
