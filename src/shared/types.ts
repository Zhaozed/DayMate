// Domain + IPC contract types shared across main, preload and renderer.
// Spec reference: DEVELOPMENT_SPEC.md sections 4, 8, 9, 10, 11, 12.

import type {
  WindowName,
  RobotState,
  AccountProvider,
  IntegrationStatus,
  TaskStatus,
  TaskPriority,
  TaskSourceType,
  RoutineRunStatus,
  StepStatus,
  ApprovalStatus,
  ApprovalPolicy,
  RoutineOutput,
  ActivityEventType
} from './constants'

// Re-export so `@shared/types` is the single import surface for shared types.
export type {
  WindowName,
  RobotState,
  AccountProvider,
  IntegrationStatus,
  TaskStatus,
  TaskPriority,
  TaskSourceType,
  RoutineRunStatus,
  StepStatus,
  RiskLevel,
  ApprovalStatus,
  ApprovalPolicy,
  RoutineOutput,
  RoutineStepType,
  ActivityEventType
} from './constants'

// ── Robot ───────────────────────────────────────────────────────────────────
// The robot visually represents Agent state. It must never claim to understand
// behavior it did not observe. (Spec §4)

// ── Accounts (Spec §8) ──────────────────────────────────────────────────────
export interface IntegrationAccount {
  id: string
  provider: AccountProvider
  displayName: string
  email?: string
  status: IntegrationStatus
  scopes: string[]
  lastSyncAt?: string
  createdAt: string
  updatedAt: string
}

// ── Email (Spec §8, §9) ─────────────────────────────────────────────────────
export interface MailAddress {
  name?: string
  address: string
}

export interface NormalizedEmail {
  provider: 'gmail' | 'mail163'
  accountId: string
  messageId: string
  threadId?: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  textBody: string
  receivedAt: string
  unread: boolean
  labels: string[]
  sourceUrl?: string
}

export interface EmailDraft {
  id: string
  threadId?: string
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  body: string
  createdAt: string
}

export interface EmailDraftInput {
  accountId: string
  threadId?: string
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string
  body: string
}

export interface EmailSendResult {
  messageId: string
  sentAt: string
}

export interface EmailQuery {
  accountId?: string
  unreadOnly?: boolean
  sinceHours?: number
  limit?: number
}

// ── Calendar (Spec §8, §10) ─────────────────────────────────────────────────
export interface CalendarEvent {
  provider: 'feishu'
  accountId: string
  eventId: string
  title: string
  start: string
  end: string
  location?: string
  attendees: MailAddress[]
  description?: string
  sourceUrl?: string
}

export interface CalendarEventInput {
  title: string
  start: string
  end: string
  location?: string
  attendees?: MailAddress[]
  description?: string
}

export type CalendarEventPatch = Partial<CalendarEventInput>

export interface DateRange {
  start: string
  end: string
}

// ── Task (Spec §8) ──────────────────────────────────────────────────────────
export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  dueAt?: string
  sourceType: TaskSourceType
  sourceId?: string
  routineRunId?: string
  createdAt: string
  updatedAt: string
}

export interface TaskCreateInput {
  title: string
  description?: string
  priority?: TaskPriority
  dueAt?: string
  sourceType: TaskSourceType
  sourceId?: string
  routineRunId?: string
}

export interface TaskUpdate {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  dueAt?: string
}

// ── Need to Know (Spec §8) ───────────────────────────────────────────────────
export interface SourceRef {
  type: 'email' | 'calendar' | 'task' | 'activity'
  id: string
  label?: string
}

export interface SuggestedAction {
  label: string
  toolName?: string
  args?: Record<string, unknown>
}

export interface NeedToKnow {
  id: string
  title: string
  summary: string
  reason: string
  priority: 'medium' | 'high' | 'urgent'
  sourceRefs: SourceRef[]
  suggestedActions: SuggestedAction[]
  readAt?: string
  dismissedAt?: string
  createdAt: string
}

// ── Routine (Spec §8, §12) ──────────────────────────────────────────────────
export type RoutineTrigger =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'email_poll'; intervalMinutes: number }
  | { type: 'calendar_before'; minutesBefore: number }

export interface BaseStep {
  id: string
}

export interface ToolStep extends BaseStep {
  type: 'tool'
  tool: string
  args?: Record<string, unknown>
  outputKey?: string
}

export interface AgentStep extends BaseStep {
  type: 'agent'
  action: string
  // Inputs reference previous step outputs by key, or static values.
  inputs?: Record<string, unknown>
  outputSchema?: string
  outputKey?: string
}

export interface ConditionStep extends BaseStep {
  type: 'condition'
  // Expression evaluated against accumulated step outputs. 'true' / 'false' literal
  // or a simple path expression like 'emails[0].unread'. MVP supports literal only.
  expression: string
  thenStepId?: string
  elseStepId?: string
}

export interface CreateTaskStep extends BaseStep {
  type: 'create_task'
  title: string
  description?: string
  priority?: TaskPriority
  dueAt?: string
  sourceId?: string
}

export interface NeedToKnowStep extends BaseStep {
  type: 'need_to_know'
  // If set, publish the referenced agent-output object wholesale as a Need to
  // Know (it must carry title/summary/reason/priority/sourceRefs/
  // suggestedActions). Otherwise title/summary/reason below are used directly.
  fromKey?: string
  // Title/summary reference an agent step output path, or are literal strings.
  title?: string
  summary?: string
  priority?: 'medium' | 'high' | 'urgent'
  reason?: string
}

export interface ApprovalStep extends BaseStep {
  type: 'approval'
  toolName: string
  args: Record<string, unknown>
  title: string
}

export interface NotifyStep extends BaseStep {
  type: 'notify'
  channel: 'desktop_robot' | 'system'
  message?: string
}

export type RoutineStep =
  | ToolStep
  | AgentStep
  | ConditionStep
  | CreateTaskStep
  | NeedToKnowStep
  | ApprovalStep
  | NotifyStep

export interface RoutineDefinition {
  id: string
  name: string
  description: string
  version: number
  enabled: boolean
  trigger: RoutineTrigger
  inputs: Record<string, unknown>
  steps: RoutineStep[]
  approvalPolicy: ApprovalPolicy
  output: RoutineOutput
  createdAt: string
  updatedAt: string
}

export interface RoutineRunStep {
  id: string
  runId: string
  stepId: string
  status: StepStatus
  output?: unknown
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface RoutineRun {
  id: string
  routineId: string
  status: RoutineRunStatus
  triggerType: string
  idempotencyKey: string
  currentStepId?: string
  inputs: Record<string, unknown>
  stepOutputs: Record<string, unknown>
  startedAt: string
  completedAt?: string
  error?: string
}

// ── Approval (Spec §8) ──────────────────────────────────────────────────────
export interface ApprovalRequest {
  id: string
  routineRunId?: string
  toolCallId: string
  toolName: string
  riskLevel: 'R1' | 'R2' | 'R3'
  title: string
  preview: Record<string, unknown>
  status: ApprovalStatus
  createdAt: string
  resolvedAt?: string
}

// ── Activity (Spec §8) ───────────────────────────────────────────────────────
export interface ActivityEvent {
  id: string
  runId?: string
  type: ActivityEventType
  summary: string
  metadata: Record<string, unknown>
  createdAt: string
}

// ── App info (safe to surface to renderer) ──────────────────────────────────
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

// ── IPC contract ─────────────────────────────────────────────────────────────
// The renderer never sees Node, tokens, auth codes or raw db access. It only
// sees the typed surface below, exposed by the preload via contextBridge.
export interface DaymateApi {
  ping(): Promise<string>
  getAppInfo(): Promise<AppInfo>
  getRobotState(): Promise<RobotState>
  setRobotState(state: RobotState): Promise<RobotState>
  openWindow(name: WindowName): Promise<void>

  // Routines (M1)
  listRoutines(): Promise<RoutineDefinition[]>
  runRoutine(routineId: string): Promise<RoutineRun>
  listRoutineRuns(routineId?: string): Promise<RoutineRun[]>
  getRoutineRun(runId: string): Promise<{ run: RoutineRun; steps: RoutineRunStep[] }>
  setRoutineEnabled(routineId: string, enabled: boolean): Promise<RoutineDefinition>

  // Tasks (M1)
  listTasks(): Promise<Task[]>
  updateTask(id: string, patch: TaskUpdate): Promise<Task>

  // Need to Know (M1)
  listNeedToKnow(): Promise<NeedToKnow[]>

  // Activity (M1)
  listActivity(runId?: string): Promise<ActivityEvent[]>
  onActivityChanged(cb: (events: ActivityEvent[]) => void): () => void
}

// Contract on the `window.daymate` global injected by preload.
// The renderer's `env.d.ts` augments the DOM `Window` interface directly with
// `daymate: DaymateApi`; kept out of shared types so the main/preload (node)
// tsconfig does not need the DOM lib.
