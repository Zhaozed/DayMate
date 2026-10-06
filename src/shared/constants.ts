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
export type TaskCategory = (typeof TASK_CATEGORIES)[number]
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
export type ApplicationPriority = (typeof APPLICATION_PRIORITIES)[number]
export type InterviewNoteTag = (typeof INTERVIEW_NOTE_TAGS)[number]
export type InterviewNoteSource = (typeof INTERVIEW_NOTE_SOURCES)[number]

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

// ToDo categories (ADR 0027 — ToDo 重构). A coarse domain tag surfaced on
// each Home ToDo so the user can tell 学校 / 求职 / 账单 / 会议 / 其他 apart at
// a glance. Wire identifiers stay English; the UI maps them to Chinese
// labels (学校/求职/账单/会议/其他). The model fills `category` in the
// classify output when it sees the mail; the deterministic stub falls back to
// a topic-derived value.
export const TASK_CATEGORIES = ['school', 'job', 'bill', 'meeting', 'other'] as const

// 邮件动态聚合 (NeedToKnow) 顶层分类：组织为 学校 / 求职 / 日常 3 分类
export const BRIEFING_CATEGORIES = ['school', 'job', 'daily'] as const
export type BriefingCategory = (typeof BRIEFING_CATEGORIES)[number]

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
  'email',
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

// Priority of an application in the funnel (Spec §4.4). `back` = deprioritised
// (the user pushed it back, or the auto-stale rule demoted it after 14 days of
// no progress). Wire identifier; the UI maps it to a Chinese label.
export const APPLICATION_PRIORITIES = ['normal', 'back'] as const

// ── Resume versions / interview prep (Milestone A) ──────────────────────────
// Per-application versioned AI artefacts. The latest `version` is active; no
// separate active flag. `promptHash` = SHA-256 of the generation inputs, used to
// short-circuit a re-request whose inputs are unchanged (skip the LLM call).

// 面经库 tags (Spec §6). Wire identifiers stay English; the UI maps them to
// 算法 / 八股 / 项目 / 行为 / 系统设计.
export const INTERVIEW_NOTE_TAGS = [
  'algorithm',
  'fundamentals',
  'project',
  'behavior',
  'system_design'
] as const

// Where a 面经 entry came from. `agent` = AI-summarised post-interview (still
// the user's own knowledge, trusted under §17); `manual` = user-authored.
export const INTERVIEW_NOTE_SOURCES = ['manual', 'agent'] as const

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
  // Tasks (M1). CREATE/DELETE added in ADR 0026 so the user can manage ToDos
  // on the Home page (auto-generated mail ToDos + manual ones share the table).
  // TASKS_CHANGED pushes on any task mutation so Home refreshes live.
  TASK_LIST: 'daymate:task:list',
  TASK_CREATE: 'daymate:task:create',
  TASK_UPDATE: 'daymate:task:update',
  TASK_DELETE: 'daymate:task:delete',
  TASKS_CHANGED: 'daymate:task:changed',
  // Need to Know (M1)
  NEED_TO_KNOW_LIST: 'daymate:need-to-know:list',
  NEED_TO_KNOW_DISMISS: 'daymate:need-to-know:dismiss',
  NEED_TO_KNOW_CLEAR_ALL: 'daymate:need-to-know:clear-all',
  /** ADR 0029 — user edits a 必读 item's headline/summary inline. */
  NEED_TO_KNOW_UPDATE: 'daymate:need-to-know:update',
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
  MEMORY_CONFIRM: 'daymate:memory:confirm',
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
  // Job applications. applications:* manage the cross-channel funnel panel.
  APPLICATION_LIST: 'daymate:application:list',
  APPLICATION_CREATE: 'daymate:application:create',
  APPLICATION_ADD_EVENT: 'daymate:application:add-event',
  APPLICATION_CHANGED: 'daymate:application:changed',
  APPLICATION_SYNC_EMAIL: 'daymate:application:sync-email',
  APPLICATION_UPLOAD_RESUME: 'daymate:application:upload-resume',
  APPLICATION_OPEN_PDF: 'daymate:application:open-pdf',
  APPLICATION_SELECT_BASE_RESUME: 'daymate:application:select-base-resume',
  APPLICATION_GENERATE_PREP: 'daymate:application:generate-prep',
  APPLICATION_LIST_RESUMES: 'daymate:application:list-resumes',
  APPLICATION_LIST_PREP: 'daymate:application:list-prep',
  APPLICATION_LIST_INTERVIEW_NOTES: 'daymate:application:list-interview-notes',
  APPLICATION_CREATE_INTERVIEW_NOTE: 'daymate:application:create-interview-note',
  APPLICATION_SOFT_DELETE: 'daymate:application:soft-delete',
  APPLICATION_RESTORE: 'daymate:application:restore',
  APPLICATION_PURGE: 'daymate:application:purge',
  APPLICATION_LIST_DELETED: 'daymate:application:list-deleted',
  APPLICATION_ARCHIVE: 'daymate:application:archive',
  APPLICATION_UNARCHIVE: 'daymate:application:unarchive',
  APPLICATION_STATS: 'daymate:application:stats',
  APPLICATION_GENERATE_FUNNEL_REVIEW: 'daymate:application:generate-funnel-review',
  APPLICATION_UPDATE_FIELDS: 'daymate:application:update-fields',
  APPLICATION_FETCH_JD: 'daymate:application:fetch-jd',
  APPLICATION_UNDO_EVENT: 'daymate:application:undo-event',
  APPLICATION_REBIND_EVENT: 'daymate:application:rebind-event',
  APPLICATION_DELETE_EVENT: 'daymate:application:delete-event',
  APPLICATION_UPDATE_STATUS: 'daymate:application:update-status',
  APPLICATION_UPDATE_JD: 'daymate:application:update-jd',
  EMAIL_MATCHES_LIST: 'daymate:email-match:list',
  EMAIL_MATCH_CONFIRM: 'daymate:email-match:confirm',
  EMAIL_MATCH_IGNORE: 'daymate:email-match:ignore',
  EMAIL_MATCHES_CHANGED: 'daymate:email-match:changed',
  JOB_SEARCH_GET_CONFIG: 'daymate:job-search:get-config',
  JOB_SEARCH_SET_CONFIG: 'daymate:job-search:set-config',
  // Milestone D — notification prefs + 投递 data export.
  NOTIFICATION_GET_PREFS: 'daymate:notifications:get-prefs',
  NOTIFICATION_SET_PREFS: 'daymate:notifications:set-prefs',
  APPLICATION_EXPORT_ZIP: 'daymate:application:export-zip',
  // Milestone E — birth data for the daily 运势 (non-secret settings.json).
  BIRTH_DATA_GET: 'daymate:birth-data:get',
  BIRTH_DATA_SET: 'daymate:birth-data:set',
  BIRTH_DATA_CLEAR: 'daymate:birth-data:clear',
  // ADR 0026 — Home 天气卡
  WEATHER_GET: 'daymate:weather:get',
  WEATHER_REFRESH: 'daymate:weather:refresh',
  WEATHER_CITY_GET: 'daymate:weather:city-get',
  WEATHER_CITY_SET: 'daymate:weather:city-set',
  // ADR 0027 — ToDo overhaul: school-spam skip-token editor + cold-start
  // toggle + manual re-scan. All R1 local reads/writes (§15 — settings.json is
  // local config, no external side-effect). COLD_START clears one account's
  // `coldStartDone` entry and fires the backfill (fire-and-forget in the handler).
  TODO_GET_SETTINGS: 'daymate:todo:get-settings',
  TODO_SET_SETTINGS: 'daymate:todo:set-settings',
  TODO_COLD_START: 'daymate:todo:cold-start',
  // ADR 0029 — 必读 thread context. Lazy R0 read-only fetch of ALL emails in a
  // conversation (Gmail threads.get / 163 IMAP header search, best-effort). Used
  // by the 必读 page to expand a thread Item; never persisted (§17).
  EMAIL_THREAD_GET: 'daymate:email:thread:get'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// Hard ceiling on Routine step execution to prevent runaway loops. (Spec §12.7)
export const ROUTINE_MAX_STEPS = 100

// Built-in preset Routine ids. They are seeded on first launch and cannot be
// created-over or deleted (Spec §14). Shared so the renderer can hide the
// Delete control on preset rows.
export const PRESET_ROUTINE_IDS = [
  'interview_prep'
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
