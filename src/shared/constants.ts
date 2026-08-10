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
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number]
export type EmailTopic = (typeof EMAIL_TOPICS)[number]
export type MemoryKey = (typeof MEMORY_KEYS)[number]
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number]
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number]

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

export const ACCOUNT_PROVIDERS = ['gmail', 'mail163', 'feishu', 'boss'] as const

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
  'agent_completed',
  'agent_failed',
  'tool_requested',
  'tool_completed',
  'tool_failed',
  'approval_requested',
  'approval_resolved',
  'provider_unavailable'
] as const

// Auto Inbox classification buckets (Spec §13.2).
export const EMAIL_CLASSIFICATIONS = [
  'reply',
  'follow_up',
  'information',
  'ignore'
] as const

// Topic dimension for Auto Inbox (orthogonal to the action buckets above).
// Ads are forced to `ignore`; fees/recruiting/meeting surface in the grouped
// NTK summary so the user sees "what kind of mail" landed, not just counts.
export const EMAIL_TOPICS = [
  'fees_billing',
  'recruiting',
  'ads',
  'meeting',
  'general'
] as const

// ── Memory (Spec §16) ───────────────────────────────────────────────────────
// Memory is explicit, inspectable, deletable. Only the categories below may be
// stored. `other` is the escape hatch for user-authored entries; agent proposals
// must use a named category. Forbidden content (full email bodies, tokens,
// inferred sensitive traits, negative judgments, untrusted instructions, private
// company info not approved) is rejected by MemoryService.save (§16).
export const MEMORY_KEYS = [
  'email_tone',
  'writing_style',
  'persona',
  'working_hours',
  'meeting_duration',
  'contact',
  'project',
  'notification_prefs',
  'job_search_profile',
  'other'
] as const

// ── Job applications (boss-cli integration) ─────────────────────────────────
// An Application is a single job the user has applied to, from any channel.
// `source` records where the application record came from — boss-cli sync
// (BOSS 直聘), a manual entry (官网/内推/线下), or other platforms. Wire
// identifier; the UI maps it to a Chinese label.
export const APPLICATION_SOURCES = [
  'boss',
  'manual',
  'web',
  'referral',
  'other'
] as const

// The event vocabulary for an application's progress timeline (Spec §4.1).
// Events are detected, not a fixed ladder — different companies have different
// flows, so we record what we observe (boss sync, email inference, or a manual
// entry) and the latest event is the current stage. `offer`/`rejected`/
// `withdrawn` are terminal (sticky). `communicated` = an HR replied on BOSS.
export const APPLICATION_EVENT_TYPES = [
  'applied',
  'communicated',
  'assessment',
  'written_test',
  'interview',
  'offer',
  'rejected',
  'withdrawn'
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
  OPEN_WORKBENCH_AT: 'daymate:open-workbench-at',
  // Robot surface (M4) — main pushes state + proactive bubbles to the robot.
  ROBOT_STATE_CHANGED: 'daymate:robot:state-changed',
  ROBOT_NOTIFY: 'daymate:robot:notify',
  // Renderer asks main to resize the ambient robot window for the orb / bubble /
  // quick-panel view (M4 §18). The window is transparent; the renderer can't
  // resize it directly, so it goes through this typed channel.
  SET_ROBOT_VIEW: 'daymate:robot:set-view',
  // Workbench deep-link (M4) — main tells workbench which page to show.
  WORKBENCH_NAV: 'daymate:workbench:navigate',
  // App lifecycle (M4)
  APP_QUIT: 'daymate:app:quit',
  // Routines (M1)
  ROUTINE_LIST: 'daymate:routine:list',
  ROUTINE_RUN: 'daymate:routine:run',
  ROUTINE_LIST_RUNS: 'daymate:routine:list-runs',
  ROUTINE_GET_RUN: 'daymate:routine:get-run',
  ROUTINE_SET_ENABLED: 'daymate:routine:set-enabled',
  ROUTINE_UPDATE: 'daymate:routine:update',
  ROUTINE_PAUSE_ALL: 'daymate:routine:pause-all',
  ROUTINE_RESUME_ALL: 'daymate:routine:resume-all',
  ROUTINE_CREATE: 'daymate:routine:create',
  ROUTINE_DELETE: 'daymate:routine:delete',
  // Tasks (M1)
  TASK_LIST: 'daymate:task:list',
  TASK_UPDATE: 'daymate:task:update',
  // Need to Know (M1)
  NEED_TO_KNOW_LIST: 'daymate:need-to-know:list',
  // Activity (M1)
  ACTIVITY_LIST: 'daymate:activity:list',
  ACTIVITY_CHANGED: 'daymate:activity:changed',
  // Approvals (M2)
  APPROVAL_LIST: 'daymate:approval:list',
  APPROVAL_GET: 'daymate:approval:get',
  APPROVAL_APPROVE: 'daymate:approval:approve',
  APPROVAL_REJECT: 'daymate:approval:reject',
  APPROVAL_CHANGED: 'daymate:approval:changed',
  // Memory (M5 — Spec §16)
  MEMORY_LIST: 'daymate:memory:list',
  MEMORY_SAVE: 'daymate:memory:save',
  MEMORY_UPDATE: 'daymate:memory:update',
  MEMORY_DELETE: 'daymate:memory:delete',
  MEMORY_CHANGED: 'daymate:memory:changed',
  // LLM configuration (M3) — the key is write-only; GET never returns it.
  LLM_GET_CONFIG: 'daymate:llm:get-config',
  LLM_SET_CONFIG: 'daymate:llm:set-config',
  LLM_SET_KEY: 'daymate:llm:set-key',
  LLM_DELETE_KEY: 'daymate:llm:delete-key',
  LLM_TEST: 'daymate:llm:test',
  // Gmail integration (Spec §9). client_id/secret + tokens are credentials —
  // stored in SecretStore, never returned to the renderer. Connect opens the
  // OAuth browser flow on a loopback callback; only status crosses to renderer.
  GMAIL_SET_CLIENT: 'daymate:gmail:set-client',
  GMAIL_HAS_CLIENT: 'daymate:gmail:has-client',
  GMAIL_CONNECT: 'daymate:gmail:connect',
  GMAIL_DISCONNECT: 'daymate:gmail:disconnect',
  GMAIL_GET_STATUS: 'daymate:gmail:get-status',
  GMAIL_TEST: 'daymate:gmail:test',
  // 163 Mail integration (Spec §9). IMAP/SMTP authorized by the mailbox's 授权码
  // (authorization code) — email + code are credentials stored in SecretStore,
  // never returned to the renderer. Only status + connected address cross over.
  MAIL163_SET_CLIENT: 'daymate:mail163:set-client',
  MAIL163_HAS_CLIENT: 'daymate:mail163:has-client',
  MAIL163_CONNECT: 'daymate:mail163:connect',
  MAIL163_DISCONNECT: 'daymate:mail163:disconnect',
  MAIL163_GET_STATUS: 'daymate:mail163:get-status',
  MAIL163_TEST: 'daymate:mail163:test',
  // Feishu Calendar integration (Spec §10). User-OAuth; app_id/app_secret +
  // user refresh token are credentials in the SecretStore, never returned to
  // the renderer. Only status crosses over.
  FEISHU_SET_CLIENT: 'daymate:feishu:set-client',
  FEISHU_HAS_CLIENT: 'daymate:feishu:has-client',
  FEISHU_CONNECT: 'daymate:feishu:connect',
  FEISHU_DISCONNECT: 'daymate:feishu:disconnect',
  FEISHU_GET_STATUS: 'daymate:feishu:get-status',
  FEISHU_TEST: 'daymate:feishu:test',
  // Job applications (boss-cli integration). applications:* manage the
  // cross-channel funnel panel (manual entries + boss sync + status events).
  // boss:get-status reports the boss-cli login/cookie health (never a cookie).
  APPLICATION_LIST: 'daymate:application:list',
  APPLICATION_CREATE: 'daymate:application:create',
  APPLICATION_ADD_EVENT: 'daymate:application:add-event',
  APPLICATION_SYNC_BOSS: 'daymate:application:sync-boss',
  APPLICATION_CHANGED: 'daymate:application:changed',
  BOSS_GET_STATUS: 'daymate:boss:get-status'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// Hard ceiling on Routine step execution to prevent runaway loops. (Spec §12.7)
export const ROUTINE_MAX_STEPS = 100

// Built-in preset Routine ids. They are seeded on first launch and cannot be
// created-over or deleted (Spec §14). Shared so the renderer can hide the
// Delete control on preset rows.
export const PRESET_ROUTINE_IDS = [
  'morning_brief',
  'auto_inbox',
  'draft_review',
  'meeting_prep',
  'daily_work_summary'
] as const
export type PresetRoutineId = (typeof PRESET_ROUTINE_IDS)[number]

// An approval request older than this is expired and cannot be executed
// (Spec §20: approval expired).
export const APPROVAL_TTL_HOURS = 24

// ── LLM (M3) ───────────────────────────────────────────────────────────────
// Providers the model gateway can talk to. The agent runtime loads the
// matching pi-ai provider only when a key for it is configured. `deepseek` is
// a domestic OpenAI-compatible provider (api.deepseek.com, China-direct, no
// proxy) — added so the agent can run on a real model without an
// Anthropic/OpenAI key or overseas network.
export const LLM_PROVIDERS = ['anthropic', 'openai', 'deepseek'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

// Default model ids per provider (overridable in settings). The gateway falls
// back to the provider's first available catalog model if an id is unknown.
export const DEFAULT_LLM_MODEL_IDS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
  deepseek: 'deepseek-v4-flash'
}

// Hard cap on email body length forwarded into a model prompt (Spec §17.14:
// limit model input length). Bodies are truncated with a marker when exceeded.
export const MAX_MODEL_INPUT_CHARS = 12000
