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
  ActivityEventType,
  EmailClassification,
  EmailTopic,
  LlmProvider,
  MemoryKey,
  ApplicationSource,
  ApplicationEventType,
  ApplicationPriority,
  InterviewNoteTag,
  InterviewNoteSource
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
  ActivityEventType,
  EmailClassification,
  EmailTopic,
  LlmProvider,
  MemoryKey,
  ApplicationSource,
  ApplicationEventType,
  ApplicationPriority,
  InterviewNoteTag,
  InterviewNoteSource
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

/**
 * Output of the `generate_draft_reply` agent step (Spec §13.5 tone-mirroring).
 * The body mirrors the user's own prior-reply voice (drawn from the sent-mail
 * corpus + the memory profile), NOT a generic canned string. The approval step
 * wraps `email.create_draft` with this body; `contentHash` is computed over the
 * resolved args so the LLM body is captured immutably at approval-request time
 * (Spec §15). Never drafted for an untrusted email (§17).
 */
export interface DraftReplyOutput {
  to: MailAddress[]
  subject: string
  body: string
  memoryProposals?: MemoryProposal[]
}

export interface EmailQuery {
  accountId?: string
  unreadOnly?: boolean
  sinceHours?: number
  limit?: number
  /** IMAP UID high-water-mark — fetch only messages with UID strictly greater
   * than this (mail163). Lets the email-sync poll run incrementally instead of
   * re-scanning the whole window each tick. */
  sinceUid?: number
  /** Gmail internalDate (ms epoch) high-water-mark — fetch only messages with
   * internalDate strictly greater (gmail). Same incremental-sync purpose. */
  sinceInternalDate?: number
}

/** Per-provider high-water-mark persisted in non-secret settings so the
 * email-sync poll only classifies NEW mail (no re-running the agent on
 * already-processed messages → token cost). The event-level `sourceRef`
 * idempotency (`email:<messageId>`) remains as the safety net for a cursor
 * reset/miss (re-processing is a no-op, never a duplicate). */
export interface EmailSyncCursor {
  mail163LastUid?: number
  gmailLastInternalDate?: number
}

// Query for the user's OWN sent mail — the prior-reply tone corpus (Spec §13.5
// tone-mirroring). `toAddress` filters to a specific recipient so the corpus
// mirrors the voice the user uses with THAT contact. Sent mail is the user's
// own voice — the opposite of §17-untrusted inbound mail — so it is framed
// distinctly (frameSentReply, not frameEmail) and never enters the untrusted
// set (Spec §17). It is only fetched as a tone reference, never sent anywhere
// without approval.
export interface SentMailQuery {
  accountId?: string
  toAddress?: string
  sinceHours?: number
  limit?: number
}

// Result of classifying a single email in Auto Inbox (Spec §13.2). The
// classifier dedupes by (provider, accountId, messageId), so a re-run never
// re-classifies the same message. Prompt-injection / SPAM-labeled mail is
// classified `ignore` and `untrusted: true` — it must never produce a task,
// draft, or send.
export interface EmailClassificationResult {
  provider: 'gmail' | 'mail163'
  accountId: string
  messageId: string
  classification: EmailClassification
  topic: EmailTopic
  untrusted: boolean
  reason: string
  suggestedAction?: SuggestedAction
}

/**
 * A passive memory proposal from an agent step (Spec §16 — "town"-style: agent
 * proposes, user confirms). Each proposal lands `confirmed: false` via the
 * `memory.save_proposals` tool; the user reviews it on the Memory page. The
 * agent may only propose a `(key, value)` drawn from data it actually handled —
 * never from untrusted email instructions, and `validateMemoryContent` rejects
 * secrets / full email bodies / forbidden inferred traits before persistence.
 */
export interface MemoryProposal {
  key: MemoryKey
  value: string
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
  | { type: 'application_status'; targetStatus: 'interview' }

export interface BaseStep {
  id: string
}

export interface ToolStep extends BaseStep {
  type: 'tool'
  tool: string
  args?: Record<string, unknown>
  outputKey?: string
  // When true, a tool error does NOT fail the run: the engine records a
  // `provider_unavailable` Activity event, stores `undefined` output, and
  // continues (Spec §21 M3: "unavailable provider is clearly reported").
  continueOnError?: boolean
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

// ── Approval (Spec §8, §15) ─────────────────────────────────────────────────
export interface ApprovalRequest {
  id: string
  routineRunId?: string
  toolCallId: string
  toolName: string
  riskLevel: 'R1' | 'R2' | 'R3'
  title: string
  preview: Record<string, unknown>
  // SHA-256 of canonical JSON of the action args at preview time. Recomputed
  // at execution; mismatch refuses the action (Spec §15 content immutability).
  contentHash: string
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

// ── Memory (Spec §16) ───────────────────────────────────────────────────────
// Memory is explicit, inspectable and deletable. Agent proposals land as
// `confirmed: false` and must be confirmed by the user before they are active
// (searchable) — "Agent proposals to save memory must be visible and require
// confirmation" (§16). Forbidden content (full email bodies, tokens, inferred
// sensitive traits, negative judgments, untrusted instructions, private company
// info) is rejected by MemoryService.save before anything is persisted.
export interface MemoryItem {
  id: string
  key: MemoryKey
  value: string
  /** Origin: `user` (authored in the UI) | `agent` (agent-step proposal) | `routine:<id>`. */
  source: string
  confirmed: boolean
  routineRunId?: string
  createdAt: string
  updatedAt: string
}

export interface MemorySaveInput {
  key: MemoryKey
  value: string
  source?: string
  routineRunId?: string
  /** User-authored saves are confirmed immediately; agent proposals land proposed. */
  confirmed?: boolean
}

export interface MemoryUpdate {
  value?: string
  confirmed?: boolean
}

// ── App info (safe to surface to renderer) ──────────────────────────────────
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

// ── LLM configuration (M3) ──────────────────────────────────────────────────
// Non-secret, persisted in plain settings.json. The API key itself is NEVER
// surfaced here (or anywhere to the renderer); only `keyConfigured` is.
export interface LlmConfig {
  provider: LlmProvider
  modelId: string
  /** True iff an encrypted key for `provider` exists in the SecretStore. */
  keyConfigured: boolean
}

export interface LlmConfigInput {
  provider: LlmProvider
  modelId: string
}

/** Result of a 1-token connectivity probe (LLM_TEST). Never includes the key. */
export interface LlmTestResult {
  ok: boolean
  /** Human-readable status; the error message on failure, never the key. */
  message: string
}

// ── Gmail integration (Spec §9) ─────────────────────────────────────────────
// client_id/secret + tokens are credentials stored in the SecretStore. The
// renderer only ever sees opaque status + the connected email address — never
// a token, auth code, or the client secret.
export interface GmailStatus {
  status: IntegrationStatus
  hasClient: boolean
  email?: string
}

/** Result of a Gmail connectivity probe (GMAIL_TEST) — lists one real message. */
export interface GmailTestResult {
  ok: boolean
  /** Human-readable status; never a token or auth code. */
  message: string
  /** One real message id, to prove the read path works (no message body). */
  sampleMessageId?: string
}

// ── 163 Mail (Spec §9) — IMAP read + SMTP send, 授权码 auth ──────────────────
// Same shape as Gmail: the renderer only ever sees opaque status + the
// connected email address — never the 授权码 (authorization code).
export interface Mail163Status {
  status: IntegrationStatus
  hasClient: boolean
  email?: string
}

/** Result of a 163 connectivity probe (MAIL163_TEST) — lists one real message. */
export interface Mail163TestResult {
  ok: boolean
  /** Human-readable status; never the 授权码. */
  message: string
  /** One real message id, to prove the IMAP read path works (no body). */
  sampleMessageId?: string
}

// ── Feishu Calendar (Spec §10) — user-OAuth read ─────────────────────────────
// The renderer only ever sees opaque status — never app_secret, never the user
// refresh/access token.
export interface FeishuStatus {
  status: IntegrationStatus
  hasClient: boolean
}

/** Result of a Feishu connectivity probe (FEISHU_TEST) — lists today's events. */
export interface FeishuTestResult {
  ok: boolean
  /** Human-readable status; never a token. */
  message: string
  /** Count of real events read today (proves the calendar read path). */
  eventCount?: number
  /** First event title, to prove a real read (no event body/attendees). */
  sampleEventTitle?: string
}

// ── BOSS 直聘 (boss-cli) — read-side DTOs ────────────────────────────────────
// boss-cli (jackwener/boss-cli) wraps BOSS 直聘's reverse-engineered API and
// returns a unified `{ok, schema_version, data}` envelope (see its SCHEMA.md).
// These DTOs are the normalized shape Daymate works with; the real provider
// maps the envelope's `data` into them. Boss data is UNTRUSTED external text
// (§17): it only ever enters agent prompts as a user message, never the
// host-set system prompt, and `enforceTrust` is applied after model output.
// The mock provider (credential-free default) returns canned fixtures.

export interface BossSearchQuery {
  keyword: string
  city?: string
  salary?: string
  experience?: string
  degree?: string
  industry?: string
  scale?: string
  stage?: string
  jobType?: string
  page?: number
  limit?: number
}

/** A job listing from `boss search` / `boss recommend`. */
export interface BossJob {
  provider: 'boss'
  accountId: string
  securityId: string
  jobName: string
  companyName: string
  salary?: string
  city?: string
  experience?: string
  degree?: string
  hrName?: string
  brandName?: string
  jobLabels?: string[]
  // Detail-only fields (populated by `boss detail`, NOT by `boss search`).
  // postDescription/jobDesc is the JD body — untrusted boss data; the renderer
  // MUST render it as text (React escapes) never as HTML (§17.12/§17.13).
  jobDescription?: string
  industry?: string
  scale?: string
  stage?: string
  hrTitle?: string
  areaDistrict?: string
  businessDistrict?: string
}

/** An applied job from `boss applied`. */
export interface BossApplication {
  provider: 'boss'
  accountId: string
  securityId: string
  jobName: string
  companyName: string
  salary?: string
  city?: string
  brandName?: string
  hrName?: string
  appliedAt?: string
}

/** An interview invitation from `boss interviews`. */
export interface BossInterview {
  provider: 'boss'
  accountId: string
  /** The job this interview is for, when boss-cli surfaces it. */
  securityId?: string
  interviewId: string
  jobName: string
  companyName: string
  interviewTime?: string
  address?: string
  contact?: string
  status?: string
}

/** A communicated recruiter from `boss chat`. */
export interface BossChat {
  provider: 'boss'
  accountId: string
  friendId: string
  hrName?: string
  companyName?: string
  jobName?: string
  /** When set, the HR replied (→ a `communicated` event). */
  lastMessage?: string
  lastTime?: string
  unread?: boolean
  /** Match key back to an applied job (securityId when boss-cli surfaces it). */
  securityId?: string
}

// ── Job applications — the cross-channel funnel (Spec §3, §4, §5) ─────────────
// An Application is ONE job the user has applied to, from any channel (BOSS via
// boss-cli, or a manual entry for 官网/内推/线下). Its progress is an ordered
// list of ApplicationEvents (applied → communicated → assessment → written_test
// → interview → offer/rejected). Manual entries + manual events coexist with
// boss-synced ones so the panel is the single source of truth across channels.

export interface Application {
  id: string
  company: string
  position: string
  source: ApplicationSource
  /** Present when `source === 'boss'` (the boss-cli securityId for upsert). */
  bossSecurityId?: string
  appliedAt: string
  /** Internal channel ref — recruiter name, 官网 link, 内推人, etc. */
  channelRef?: string
  notes?: string
  // ── Rich fields (Milestone A) ────────────────────────────────────────────
  city?: string
  /** Free-text salary, e.g. "25-40K·15薪". */
  salaryRange?: string
  /** Full JD body. Untrusted external text (§17) — never executed. */
  jdText?: string
  /** Process sub-state, e.g. "简历筛选"/"一面"/"HR面". User-maintained. */
  stage?: string
  /** ISO date — next-stage deadline (assessment due, interview time). */
  stageDeadline?: string
  /** Meeting link for an interview/assessment (may be filled from email). */
  interviewLink?: string
  /** Funnel priority; `back` = deprioritised or auto-stale-demoted. */
  priority?: ApplicationPriority
  /** messageId of the originating email (email→app link for refresh). */
  emailRefId?: string
  /** Soft-delete timestamp; null = active. Recycle-bin + 30-day auto-purge. */
  deletedAt?: string
  /** Archive timestamp; archived apps hide from the default funnel. */
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

/** A manual create input (renderer → main). `source` defaults to 'manual'. */
export interface ApplicationCreateInput {
  company: string
  position: string
  source?: ApplicationSource
  appliedAt?: string
  channelRef?: string
  notes?: string
  city?: string
  salaryRange?: string
  jdText?: string
  stage?: string
  stageDeadline?: string
  interviewLink?: string
}

/** Partial rich-field update (renderer → main, single-field refresh / edit). */
export interface ApplicationUpdateFields {
  company?: string
  position?: string
  city?: string
  salaryRange?: string
  jdText?: string
  stage?: string
  stageDeadline?: string
  interviewLink?: string
  notes?: string
  channelRef?: string
  priority?: ApplicationPriority
}

export interface ApplicationEvent {
  id: string
  applicationId: string
  type: ApplicationEventType
  /** Interview round (1, 2, 3 …) — only for `type === 'interview'`. */
  round?: number
  /** Interview role — only for `type === 'interview'`. */
  role?: 'hr' | 'tech' | 'business' | 'cross'
  /** Interview sub-state (derived from the calendar in P2). */
  subState?: 'scheduled' | 'done'
  /** Where the event was detected: boss sync, email inference, or the user. */
  source: 'boss' | 'email' | 'manual'
  /** Stable ref for idempotency (emailId / bossChatId / boss interviewId). */
  sourceRef?: string
  /** Short evidence snippet (e.g. an email subject line) for the timeline. */
  evidence?: string
  /** When true, auto-detection (P2) will not silently change status past it. */
  locked?: boolean
  eventAt: string
  createdAt: string
}

/** Manual event input (renderer → main). `source` is always 'manual'. */
export interface ApplicationEventInput {
  applicationId: string
  type: ApplicationEventType
  round?: number
  role?: 'hr' | 'tech' | 'business' | 'cross'
  subState?: 'scheduled' | 'done'
  eventAt?: string
  evidence?: string
  /** Default true for manual events — the user is the source of truth. */
  locked?: boolean
}

/** A view model for the funnel panel: an application + its computed state. */
export interface ApplicationView {
  application: Application
  events: ApplicationEvent[]
  /** Computed current stage (latest event; terminal wins). */
  currentStatus: ApplicationEventType
  currentRound?: number
  isTerminal: boolean
  lastEventAt?: string
  /** Days since the latest event (for follow-up timing). */
  daysSinceLastEvent?: number
}

/** boss-cli login/cookie health (never a cookie crosses to the renderer). */
export interface BossStatus {
  status: IntegrationStatus
  authenticated: boolean
  /** Human-readable message (e.g. "环境异常，请重新登录" when cookies expired). */
  message: string
}

// ── Resume versions (Milestone A §4.2) ───────────────────────────────────────
// Per-application versioned AI-tailored HTML resumes. The latest `version` is
// active. `promptHash` = SHA-256 of (baseResume + jdText) to short-circuit a
// re-request whose inputs are unchanged (skip the LLM call).
export interface ResumeVersion {
  id: string
  applicationId: string
  /** 1-based, monotonically increasing per application. */
  version: number
  /** Tailored HTML resume (untrusted-ish output; rendered sandboxed, never run). */
  html: string
  /** Which LLM produced it (traceability); undefined for the deterministic stub. */
  modelId?: string
  promptHash?: string
  createdAt: string
}

// ── Interview prep materials (Milestone A §4.3) ──────────────────────────────
// Per-application versioned interview-prep transcript (structured HTML). Same
// versioning shape as ResumeVersion.
export interface PrepMaterial {
  id: string
  applicationId: string
  version: number
  html: string
  modelId?: string
  promptHash?: string
  createdAt: string
}

// ── 面经库 (Milestone A §6) ───────────────────────────────────────────────────
// A post-interview experience note. Standalone (NOT tied to one application) so
// a 面经 for company X is reusable. `source` is 'manual' (user-authored) or
// 'agent' (AI-summarised post-interview) — both are the user's own knowledge,
// trusted under §17.
export interface InterviewNote {
  id: string
  company?: string
  position?: string
  /** Link back to the originating application (optional). */
  applicationId?: string
  tags: InterviewNoteTag[]
  content: string
  source: InterviewNoteSource
  createdAt: string
  updatedAt: string
}

/** Manual create input for a 面经 entry (renderer → main). */
export interface InterviewNoteInput {
  company?: string
  position?: string
  applicationId?: string
  tags: InterviewNoteTag[]
  content: string
}

// ── Email→application inference (Milestone A §3.3) ────────────────────────────
// A proposed match between a classified email and an existing application.
// `confidence: 'low'` (or unmatched) → lands in the manual-confirm queue.
export interface EmailMatchProposal {
  id: string
  messageId: string
  /** Email subject / key snippet shown in the queue. */
  subject: string
  from?: string
  /** Classified event type to append if confirmed. */
  eventType: ApplicationEventType
  company?: string
  position?: string
  confidence: 'high' | 'medium' | 'low'
  /** The matched application id, or undefined when unmatched. */
  applicationId?: string
  /** Existing application snapshot for the queue card (company/position). */
  applicationCompany?: string
  applicationPosition?: string
  evidence?: string
}

// ── Job-search config (Milestone A §G) ──────────────────────────────────────
// NON-SECRET absolute file paths only. The base resume is the user's OWN
// Notification categories the user can mute independently (Milestone D §D2).
// `routine` covers every routine `notify` step (per-routine overrides add
// finer control); `approval` covers the proactive approval-requested bubble;
// `info` is the fallback for ad-hoc notifies; `fortune` is the daily 运势
// bubble (Milestone E) so the user can mute just the horoscope. Wire
// identifiers — only the *display labels* translate (labels.ts).
export const NOTIFICATION_CATEGORIES = ['routine', 'approval', 'info', 'fortune'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/**
 * Non-secret notification preferences (Milestone D §D2), persisted in
 * settings.json. All fields optional — absent means the sensible default
 * (everything on, no quiet hours). Two layers:
 *  - quiet hours suppress the **native macOS notification** only (the in-app
 *    robot bubble stays — it is non-intrusive). `end` may be earlier than
 *    `start` for an overnight window (e.g. 22:00→07:00).
 *  - per-category toggles + per-routine overrides fully suppress a category
 *    (both native and robot bubble). A per-routine override, when present,
 *    wins over the category default.
 */
export interface NotificationPrefs {
  /** Master switch for macOS Notification Center popups (default true). */
  nativeEnabled?: boolean
  quietHours?: {
    enabled: boolean
    /** 24-hour "HH:MM" local time. */
    start: string
    /** 24-hour "HH:MM" local time; may precede `start` (overnight). */
    end: string
  }
  /** Category → enabled. Absent = default true. `false` mutes the category. */
  categories?: Partial<Record<NotificationCategory, boolean>>
  /** routineId → enabled. Present entry wins over the `routine` category. */
  routineOverrides?: Record<string, boolean>
}

// document (trusted §17); a transcript template is optional. Content is read
// at generation time via fs.readFile, never stored as a DB blob. Persisted in
// settings.json alongside the (non-secret) LLM config.
export interface JobSearchSettings {
  /** Absolute path to the user's base resume (HTML/txt). Trusted §17. */
  baseResumePath?: string
  /** Optional absolute path to a transcript template (HTML). */
  transcriptTemplatePath?: string
  /** Structured job-search intent (Milestone C) — the target criteria
   *  `score_job_matches` scores `boss.search` results against. Optional:
   *  absent → the job-recommendation routine is a no-op (skips with an
   *  Activity note), the manual 抓取 button shows an empty-state hint. */
  jobIntent?: JobIntent
}

/** The user's structured job-search intent (Milestone C). Matched
 *  deterministically + by the agent against `BossJob` metadata. salaryMin/Max
 *  are monthly figures in 千 (k), e.g. 25 / 35 = 25-35k. */
export interface JobIntent {
  /** Target role keyword(s) for `boss search`, e.g. "Go 后端". */
  keyword: string
  /** Preferred cities (matches against BossJob.city substring). */
  cities?: string[]
  /** Minimum monthly salary in k (e.g. 25). */
  salaryMin?: number
  /** Maximum monthly salary in k (e.g. 35). */
  salaryMax?: number
  /** Expected experience requirement string, e.g. "3-5年" (matched loosely
   *  against BossJob.experience). */
  experience?: string
  /** Expected degree, e.g. "本科" (matched against BossJob.degree). */
  degree?: string
}

// ── Smart funnel grouping (Milestone A §5) ──────────────────────────────────
// The active funnel is grouped into ordered buckets for the 投递 page. Stale
// apps (no event for ≥14d, non-terminal) are auto-demoted to `priority:'back'`
// and land in the "停滞" bucket. Archived apps are a separate folded group.
export type SmartFunnelGroup =
  | 'urgent' // has a near stage_deadline (≤3d) or an interview scheduled soon
  | 'active' // in progress, not urgent, not stale
  | 'stale' // no progress ≥14d (auto-demoted to priority 'back')
  | 'offered' // currentStatus === 'offer'
  | 'ended' // terminal rejected/withdrawn (not archived)
  | 'archived' // archived (folded)

export interface SmartFunnelBucket {
  group: SmartFunnelGroup
  views: ApplicationView[]
}

// ── Funnel review statistics (Milestone B) ─────────────────────────────────
// Aggregate derived from `ApplicationView[]` (active, non-soft-deleted/non-
// archived). Computed in-memory by `ApplicationService.stats()` — the store
// stays pure CRUD (data volume is tens-to-hundreds; no SQL aggregates needed,
// ADR 0002). `reachedStage` counts apps that have EVER reached a stage (an event
// of that type exists in the timeline) — the funnel chart's cumulative shape.
// `conversion.X` = round(reachedStage.X / reachedStage.applied * 100). Stats are
// DESCRIPTIVE only (§2/§13.4 forbid productivity/slacking framing).
export interface FunnelStageCounts {
  applied: number
  communicated: number
  assessment: number
  written_test: number
  interview: number
  offer: number
}

export interface ApplicationFunnelStats {
  /** Active (non-soft-deleted/non-archived) application count. */
  total: number
  /** Non-terminal applications still in progress. */
  active: number
  terminal: { offer: number; rejected: number; withdrawn: number }
  byStatus: Record<ApplicationEventType, number>
  bySource: Record<ApplicationSource, number>
  byFunnelGroup: Record<SmartFunnelGroup, number>
  /** Cumulative "ever reached this stage" counts for the funnel chart. */
  reachedStage: FunnelStageCounts
  /** Conversion % vs applied for the progressive stages. */
  conversion: { assessment: number; written_test: number; interview: number; offer: number }
  /** Non-terminal apps with no progress for ≥ STALE_DAYS (14). */
  stale: number
  /** Apps with a stage_deadline within 3 days (urgent bucket). */
  urgent: number
  /** Mean days since last event across non-terminal apps; null if none. */
  avgDaysSinceLastEvent: number | null
  /** Mean days since appliedAt across non-terminal apps; null if none. */
  avgDaysInProcess: number | null
}

/** A risk-flagged application surfaced by the funnel review. */
export interface FunnelReviewRiskApp {
  company: string
  position?: string
  issue: string
}

/** Input for `generate_funnel_review` (service-built; renderer never sends). */
export interface FunnelReviewInput {
  stats: ApplicationFunnelStats
  /** Compact per-app projection — company/position are short boss/email field
   *  values (§17: untrusted-adjacent), framed as DATA in the user message, never
   *  in the system prompt. No jd_text, no email bodies, no evidence prose. */
  apps: Array<{
    company: string
    position?: string
    currentStatus: ApplicationEventType
    daysSinceLastEvent?: number
    priority?: ApplicationPriority
    source: ApplicationSource
  }>
}

/** Output of `generate_funnel_review` — extends the PublishableBrief shape so a
 *  future daily routine can publish it to NTK via `need_to_know fromKey`. */
export interface FunnelReviewOutput {
  title: string
  summary: string
  reason: string
  priority: 'medium' | 'high' | 'urgent'
  sourceRefs: SourceRef[]
  suggestedActions: SuggestedAction[]
  highlights: string[]
  riskApps: FunnelReviewRiskApp[]
  memoryProposals?: MemoryProposal[]
}

// ── Milestone C: job recommendation (每日岗位抓取 + 推荐评分) ───────────────
// Scores `boss.search` results against the user's structured `JobIntent`.
// `BossJob` carries no JD text (boss-cli mapping limitation), so scoring is
// metadata-based: salary / city / experience / degree / jobLabels vs intent.

/** A single scored job. `tier` buckets the 0-100 `score` for display. */
export interface JobMatchResult {
  securityId: string
  jobName: string
  companyName: string
  /** 0-100 match score (higher = better). */
  score: number
  tier: 'high' | 'medium' | 'low' | 'skip'
  /** Human-readable match/miss reasons, e.g. "薪资 28-40k 命中你期望 25-35k". */
  reasons: string[]
  /** True = worth applying (tier high/medium). */
  recommend: boolean
  /** Echoed for the renderer (avoids a re-lookup by securityId). */
  salary?: string
  city?: string
}

/** Input for `score_job_matches` (service-built; renderer never sends). */
export interface JobMatchInput {
  intent: JobIntent
  jobs: BossJob[]
}

/** Output of `score_job_matches` — extends the PublishableBrief shape so a
 *  daily routine can publish it to NTK via `need_to_know fromKey`. The
 *  `results` array is the per-job detail the renderer lists. */
export interface JobMatchOutput {
  title: string
  summary: string
  reason: string
  priority: 'medium' | 'high' | 'urgent'
  sourceRefs: SourceRef[]
  suggestedActions: SuggestedAction[]
  results: JobMatchResult[]
  memoryProposals?: MemoryProposal[]
}

// ── Job recommendations, split into two buckets for the 校招生 dual-track
// (实习 + 秋招正职) ───────────────────────────────────────────────────────
// `bucket` is a DETERMINISTIC business rule (which boss filter to apply), not
// an agent decision (§12: keep Agent decisions separate from deterministic
// business rules). So `score_job_matches` stays bucket-unaware — the service
// runs one scoring call over both buckets' jobs and splits the results back by
// securityId. This type is the service→renderer IPC shape; the agent output
// (`JobMatchOutput`) is unchanged.
export type JobBucket = 'intern' | 'campus'

export interface JobRecommendations {
  title: string
  summary: string
  reason: string
  priority: 'medium' | 'high' | 'urgent'
  /** 实习桶 (`boss search --job-type 实习`). */
  intern: JobMatchResult[]
  /** 秋招正职桶 (`boss search --job-type 全职 --exp 在校/应届`). */
  campus: JobMatchResult[]
  /** Set when a boss search hit rate-limit / session-expiry mid-fetch; the
   *  already-fetched partial results are still returned. Empty string = ok. */
  error?: string
  /** Per-bucket "another page exists" flags, for the renderer's load-more. */
  internHasMore: boolean
  campusHasMore: boolean
  /** Per-bucket "has been fetched at least once" flags. The renderer fetches
   *  ONE bucket per click (anti-bot: N search calls not 2N), so a bucket the
   *  user hasn't opened yet shows "click 抓取 to fetch" rather than "empty". */
  internFetched: boolean
  campusFetched: boolean
}

/** `fetchJobRecommendations` options.
 *  `{bucket: B}` = refresh ONE bucket page 1 (reset that bucket only — anti-bot:
 *  N search calls, not 2N). `{bucket: B, append: true}` = next page for that
 *  bucket, appended. No args = refresh BOTH buckets (page 1, reset all). */
export interface FetchJobRecommendationsOpts {
  bucket?: JobBucket
  append?: boolean
}

/** A proactive bubble pushed to the robot surface (M4 §18). */
export interface RobotNotify {
  message: string
  /** Present when the bubble should offer a "Review" deep-link to an approval. */
  approvalId?: string
  /** Which workbench page to open when the user taps the bubble, if any. */
  navigateTo?: WorkbenchPage
}

// ── Milestone E: daily 运势 / 八字 每日贴士 ──────────────────────────────────
// A decorative daily fortune + practical tip, surfaced as a transient robot
// bubble (NOT a Need-to-Know, NOT a routine preset — the user opted for the
// lightest surface). Birth data is the user's OWN trusted config (like the
// base resume path §17), persisted as NON-SECRET settings.json. The agent
// step is key-gated (deterministic stub without an LLM key). Full rigorous
// 八字 pillar computation is out of scope (the stub derives the zodiac 生肖
// from the birth year — honest, not over-engineered); the real LLM produces
// a personalized-sounding narrative from the raw birth fields.

/** The user's birth data for the daily fortune (NON-SECRET settings). */
export interface BirthData {
  /** Birth year (Gregorian, e.g. 1999). */
  year: number
  /** Birth month 1-12 (Gregorian). */
  month: number
  /** Birth day of month 1-31. */
  day: number
  /** Birth hour 0-23 (two-hour 生肖时辰 boundary handled by the model). Optional —
   *  a missing hour degrades to a date-only fortune. */
  hour?: number
  /** Biological sex (some 八字 schools read differently by gender). Optional. */
  gender?: 'male' | 'female'
}

export interface DailyFortuneInput {
  /** The user's birth data (trusted §17 — own config). Absent → generic fortune. */
  birth?: BirthData
  /** ISO date the fortune is for (determinism anchor for the stub). */
  date: string
}

/** Daily fortune output — a short narrative + one practical tip. Deliberately
 *  NOT a PublishableBrief: it never publishes to Need-to-Know (no sourceRefs /
 *  suggestedActions fit a horoscope). */
export interface DailyFortuneOutput {
  /** One-line title, e.g. "今日运势 · 属龙". */
  title: string
  /** 1-2 sentence fortune narrative (encouraging, never a productivity score). */
  summary: string
  /** One concrete, actionable tip for the day. */
  tip: string
  /** 0-100 mood index (purely decorative; never a productivity/slacking score §13.4). */
  mood: number
}


/**
 * Which layout the ambient robot window renders (M4 §18). The window resizes
 * around a fixed screen anchor so the orb never jumps:
 *   orb    — ambient orb only (idle/working/…)
 *   bubble — transient proactive bubble (+ Review deep-link), auto-dismisses
 *   panel  — quick panel: state, NTK summary, approvals, run/workbench actions
 */
export const ROBOT_VIEWS = ['orb', 'bubble', 'panel'] as const
export type RobotView = (typeof ROBOT_VIEWS)[number]

/** The pages the workbench can deep-link to via `onNavigate` (M4). */
export const WORKBENCH_PAGES = [
  'Home',
  'Assistant',
  'Need to Know',
  'Tasks',
  'Applications',
  'InterviewNotes',
  'Routines',
  'Approvals',
  'Activity',
  'Memory',
  'Integrations'
] as const
export type WorkbenchPage = (typeof WORKBENCH_PAGES)[number]

/** Patch a Routine's mutable config (M4) — trigger + enabled only; steps are M5. */
export interface RoutineUpdate {
  trigger?: RoutineTrigger
  enabled?: boolean
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
  /** Open the workbench and switch it to a page (M4 deep-link from the robot). */
  openWorkbenchAt(page: WorkbenchPage): Promise<void>
  /** Quit the app (M4 context menu). */
  quitApp(): Promise<void>
  /** Resize the ambient robot window to a view (M4 §18). */
  setRobotView(view: RobotView): Promise<void>

  // Robot surface (M4) — main pushes live state + proactive bubbles to the robot.
  onRobotStateChanged(cb: (state: RobotState) => void): () => void
  onRobotNotify(cb: (msg: RobotNotify) => void): () => void
  /** Workbench deep-link: main tells the workbench which page to show (M4). */
  onNavigate(cb: (page: WorkbenchPage) => void): () => void

  // Routines (M1)
  listRoutines(): Promise<RoutineDefinition[]>
  runRoutine(routineId: string): Promise<RoutineRun>
  listRoutineRuns(routineId?: string): Promise<RoutineRun[]>
  getRoutineRun(runId: string): Promise<{ run: RoutineRun; steps: RoutineRunStep[] }>
  setRoutineEnabled(routineId: string, enabled: boolean): Promise<RoutineDefinition>
  /** Patch a routine's trigger/enabled config (M4); steps stay M5. */
  updateRoutine(routineId: string, patch: RoutineUpdate): Promise<RoutineDefinition>
  /** Pause/resume all scheduled routine triggers (M4 context menu). */
  pauseRoutines(): Promise<boolean>
  resumeRoutines(): Promise<boolean>
  /** Create a custom routine from validated builder JSON (M5 §14). */
  createRoutine(def: Omit<RoutineDefinition, 'createdAt' | 'updatedAt'>): Promise<RoutineDefinition>
  /** Delete a custom routine (M5 §14). Preset routines cannot be deleted. */
  deleteRoutine(routineId: string): Promise<void>

  // Tasks (M1)
  listTasks(): Promise<Task[]>
  updateTask(id: string, patch: TaskUpdate): Promise<Task>

  // Need to Know (M1)
  listNeedToKnow(): Promise<NeedToKnow[]>

  // Activity (M1)
  listActivity(runId?: string): Promise<ActivityEvent[]>
  onActivityChanged(cb: (events: ActivityEvent[]) => void): () => void

  // Approvals (M2 — Spec §8, §15, §18)
  listApprovals(): Promise<ApprovalRequest[]>
  getApproval(id: string): Promise<ApprovalRequest | null>
  approveRequest(id: string): Promise<ApprovalRequest>
  rejectRequest(id: string): Promise<ApprovalRequest>
  onApprovalChanged(cb: (approvals: ApprovalRequest[]) => void): () => void

  // Memory (M5 — Spec §16). Agent proposals land as `confirmed:false`; the user
  // confirms them here. Only confirmed items are active (searchable).
  listMemory(): Promise<MemoryItem[]>
  saveMemory(input: MemorySaveInput): Promise<MemoryItem>
  updateMemory(id: string, patch: MemoryUpdate): Promise<MemoryItem>
  deleteMemory(id: string): Promise<void>
  onMemoryChanged(cb: (items: MemoryItem[]) => void): () => void

  // LLM configuration (M3) — key is write-only; getLlmConfig never returns it.
  getLlmConfig(): Promise<LlmConfig>
  setLlmConfig(config: LlmConfigInput): Promise<LlmConfig>
  setLlmKey(key: string): Promise<LlmConfig>
  deleteLlmKey(): Promise<LlmConfig>
  testLlm(): Promise<LlmTestResult>

  // Gmail integration (Spec §9). client_id/secret + tokens are credentials in
  // the SecretStore; these methods never return a secret to the renderer.
  setGmailClient(input: { clientId: string; clientSecret: string }): Promise<GmailStatus>
  getGmailStatus(): Promise<GmailStatus>
  connectGmail(): Promise<GmailStatus>
  disconnectGmail(): Promise<GmailStatus>
  testGmail(): Promise<GmailTestResult>

  // 163 Mail (Spec §9). email + 授权码 are credentials in the SecretStore; these
  // methods never return the 授权码 to the renderer.
  setMail163Client(input: { email: string; authCode: string }): Promise<Mail163Status>
  getMail163Status(): Promise<Mail163Status>
  connectMail163(): Promise<Mail163Status>
  disconnectMail163(): Promise<Mail163Status>
  testMail163(): Promise<Mail163TestResult>

  // Feishu Calendar (Spec §10). app_id/app_secret + user refresh token are
  // credentials in the SecretStore; these never return a secret to the renderer.
  setFeishuClient(input: { appId: string; appSecret: string }): Promise<FeishuStatus>
  getFeishuStatus(): Promise<FeishuStatus>
  connectFeishu(): Promise<FeishuStatus>
  disconnectFeishu(): Promise<FeishuStatus>
  testFeishu(): Promise<FeishuTestResult>

  // Job applications (boss-cli integration) — the cross-channel funnel panel.
  // Manual entries + manual events are local R1 writes (no approval); boss sync
  // pulls `boss applied/interviews/chat` into the funnel. boss:get-status reports
  // cookie/login health (never a cookie).
  listApplications(): Promise<ApplicationView[]>
  createApplication(input: ApplicationCreateInput): Promise<ApplicationView>
  addApplicationEvent(input: ApplicationEventInput): Promise<ApplicationView>
  /** Update editable rich fields on an application (city, salary, JD, stage,
   *  deadline, interview link, notes, channel, priority). Local DB write (R1,
   *  no approval needed — §15 only gates external writes). */
  updateApplicationFields(id: string, patch: ApplicationUpdateFields): Promise<ApplicationView | undefined>
  fetchJobJd(applicationId: string): Promise<{ jdText: string | null; error: string | null }>
  syncBossApplications(): Promise<{ synced: number; message: string }>
  getBossStatus(): Promise<BossStatus>
  /** Spawn `boss login --qrcode` — QR opens in system viewer; user scans. */
  loginBoss(): Promise<BossStatus>
  /** `boss logout` — clears boss-cli's saved credential. */
  logoutBoss(): Promise<BossStatus>
  onApplicationChanged(cb: (views: ApplicationView[]) => void): () => void
  // ── Milestone A: email inference, AI generation, recycle bin, config ──
  syncEmailApplications(): Promise<{
    synced: number
    created: number
    pending: number
    message: string
  }>
  generateResume(applicationId: string): Promise<ResumeVersion>
  generatePrepMaterial(applicationId: string): Promise<PrepMaterial>
  listResumeVersions(applicationId: string): Promise<ResumeVersion[]>
  listPrepMaterials(applicationId: string): Promise<PrepMaterial[]>
  listInterviewNotes(query?: string): Promise<InterviewNote[]>
  createInterviewNote(input: InterviewNoteInput): Promise<InterviewNote>
  softDeleteApplication(id: string): Promise<void>
  restoreApplication(id: string): Promise<ApplicationView | undefined>
  purgeApplication(id: string): Promise<void>
  listDeletedApplications(): Promise<ApplicationView[]>
  archiveApplication(id: string): Promise<ApplicationView | undefined>
  unarchiveApplication(id: string): Promise<ApplicationView | undefined>
  listPendingEmailMatches(): Promise<EmailMatchProposal[]>
  confirmEmailMatch(messageId: string, applicationId?: string): Promise<void>
  ignoreEmailMatch(messageId: string): Promise<void>
  onEmailMatchesChanged(cb: (matches: EmailMatchProposal[]) => void): () => void
  getJobSearchConfig(): Promise<JobSearchSettings>
  setJobSearchConfig(config: JobSearchSettings): Promise<JobSearchSettings>
  // ── Milestone B: funnel review (stats + AI 复盘) ──
  getApplicationStats(): Promise<ApplicationFunnelStats>
  generateFunnelReview(): Promise<FunnelReviewOutput>
  // ── Milestone C: job recommendation (抓取 + 评分 + 转投递) ──
  fetchJobRecommendations(opts?: FetchJobRecommendationsOpts): Promise<JobRecommendations>
  convertJobToApplication(securityId: string): Promise<ApplicationView>
  /** Fetch the full detail (JD body, company industry/scale/stage, HR title)
   *  for a recommended job by securityId. JD body is untrusted boss data — the
   *  renderer renders it as text, never HTML (§17.12/§17.13). */
  getJobDetail(securityId: string): Promise<BossJob>
  // ── Milestone D: notification prefs + 投递数据导出 ──
  getNotificationPrefs(): Promise<NotificationPrefs>
  setNotificationPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs>
  /** Export the 投递 module (applications + events + 面经 + 简历 + 逐字稿) as a
   *  ZIP to a user-chosen path. Resolves to the saved file path, or `null` if
   *  the user cancelled the save dialog. */
  exportApplicationsZip(): Promise<string | null>
  // ── Milestone E: birth data for the daily 运势 (non-secret settings.json) ──
  getBirthData(): Promise<BirthData | undefined>
  setBirthData(birth: BirthData): Promise<BirthData>
  clearBirthData(): Promise<void>
}

// Contract on the `window.daymate` global injected by preload.
// The renderer's `env.d.ts` augments the DOM `Window` interface directly with
// `daymate: DaymateApi`; kept out of shared types so the main/preload (node)
// tsconfig does not need the DOM lib.
