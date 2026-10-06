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
  TaskCategory,
  BriefingCategory,
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
  TaskCategory,
  BriefingCategory,
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
  /** True if routing headers mark this as bulk / list / system mail (ADR 0023).
   *  Determined at normalize time; only the boolean persists (raw headers stay
   *  provider-local — §17). Drives pre-LLM filtering so mass mail never burns
   *  a classify pass. */
  bulk?: boolean
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

// ── Weather (ADR 0026 — Home 今日天气 card) ─────────────────────────────────
// Real weather is fetched from wttr.in (no key, proxy-aware via Electron
// net.fetch) for the user's configured city. The LLM-polished briefing
// (穿衣 + 宜忌) is generated daily and cached in non-secret settings.json so
// the Home card renders without a re-fetch. None of this is a secret.
export interface WeatherData {
  city: string
  /** Celsius. */
  tempC: number
  feelsLikeC: number
  /** English condition desc from wttr.in (e.g. "Partly cloudy") — the LLM
   *  translates to Chinese in the briefing. */
  desc: string
  humidity: number
  windSpeedKmph: number
  /** Today's forecast high/low (Celsius). */
  maxTempC: number
  minTempC: number
  /** wttr weather code (e.g. 113=sunny, 116=cloudy, 200-series=rain). */
  weatherCode: number
}

export interface WeatherBriefing {
  /** ISO date (YYYY-MM-DD) the briefing was generated for; used to detect a
   *  stale cache ("today's weather"). */
  date: string
  city: string
  /** One-line "23°C 多云 · 体感21°" style header. */
  tempText: string
  /** One-line natural-language summary ("今日多云转晴，午后有阵风"). */
  summary: string
  /** Concrete clothing advice ("薄外套 + 长裤，午后可脱外套"). */
  clothing: string
  /** Practical dos (宜带伞/宜防晒/宜添衣 — NOT mystical; mystical 宜忌 stays
   *  in the daily 运势 bubble). 1-3 short clauses. */
  yi: string[]
  /** Practical don'ts. 1-3 short clauses. */
  ji: string[]
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
  /** A concrete, actionable next-step phrased as a human-readable ToDo title
   *  (ADR 0026). The model fills this ONLY when there is a genuinely useful
   *  action to take — absence = "nothing worth a ToDo" (the "没用的别生产"
   *  filter lives in the model's own judgment, no separate LLM call). */
  todoTitle?: string
  /** ISO date/time when the mail mentions a deadline / interview / follow-up
   *  date. Relative words ("下周五") are resolved to a concrete ISO date by
   *  the model. Absent = no date mentioned. */
  dueDate?: string
  /** Coarse domain tag for the ToDo (ADR 0027). The model fills this from the
   *  mail content; the deterministic stub falls back to a topic-derived value. */
  category?: TaskCategory
  /** 必读 top-level section tag (ADR 0029): 学校/求职/日常/其他. Filled on
   *  every surfaced email so the 必读 page can group into 4 sections. Distinct
   *  from `category` (5-value, tags the ToDo). Stub falls back to a topic value. */
  briefingCategory?: BriefingCategory
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
  /** Which mail provider an auto-generated mail ToDo came from (ADR 0026).
   *  Only set when sourceType='email'; lets the Home ToDo list badge the
   *  origin (163 / Gmail). */
  sourceProvider?: 'gmail' | 'mail163'
  /** Coarse domain tag (ADR 0027) — 学校/求职/账单/会议/其他. */
  category?: TaskCategory
  /** Deep link back to the source mail (ADR 0027). Gmail only — 163 has no
   *  web deep link so this stays undefined and the UI shows the provider badge
   *  alone. */
  sourceLink?: string
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
  sourceProvider?: 'gmail' | 'mail163'
  category?: TaskCategory
  sourceLink?: string
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
  /** Distinguishes morning-brief NTKs (shown on the Home 晨报 carousel, kept
   *  ~7 days) from email-driven NTKs (the 必读 page). null/undefined =
   *  legacy / email-driven (filtered INTO 必读). 'morning_brief' is filtered
   *  OUT of 必读 and INTO the Home carousel (ADR 0026). */
  kind?: 'morning_brief' | 'email' | null
  /** RFC822 / Gmail conversation key. Emails in the same thread collapse into
   *  ONE 必读 item (ADR 0029). Gmail = native threadId; 163 = synthesized from
   *  References/In-Reply-To/Message-ID headers. The full thread is fetched
   *  lazily on expand (getEmailThread) — never persisted here. */
  threadId?: string
  /** Top-level 必读 section tag (ADR 0029): 学校/求职/日常/其他. Distinct from
   *  the 5-value TaskCategory (which tags Home ToDos). Filled on every surfaced
   *  email by the model / stub. */
  briefingCategory?: BriefingCategory
  /** Email source provider badge + deep link (ADR 0029). Gmail = real per-msg
   *  deep link; 163 = generic webmail root (no per-msg deep link exists). */
  sourceProvider?: 'gmail' | 'mail163'
  sourceAccountId?: string
  sourceLink?: string
  /** Bumped on thread-merge so the renderer can sort a thread's latest update
   *  to the top. Falls back to createdAt. */
  updatedAt?: string
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
  /** ADR 0026 — 'morning_brief' tags the published NTK so it routes to the
   *  Home 晨报 carousel (and out of 必读). Omitted/null → 必读 page. */
  kind?: 'morning_brief' | 'email' | null
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

// ── Job applications — the cross-channel funnel (Spec §3, §4, §5) ─────────────
// An Application is ONE job the user has applied to. Its progress is an ordered
// list of ApplicationEvents (applied → assessment → written_test → interview → offer/rejected).

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
  /** 岗位/职位编号 (ATS Requisition ID / Job Code) */
  jobCode?: string
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
  /** Interview preparation status: suspended when JD is missing, ready when generated. */
  prepStatus?: 'ready' | 'generating' | 'suspended_missing_jd' | 'none'
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
  jobCode?: string
  salaryRange?: string
  jdText?: string
  stage?: string
  stageDeadline?: string
  interviewLink?: string
  prepStatus?: 'ready' | 'generating' | 'suspended_missing_jd' | 'none'
}

/** Partial rich-field update (renderer → main, single-field refresh / edit). */
export interface ApplicationUpdateFields {
  company?: string
  position?: string
  jobCode?: string
  city?: string
  salaryRange?: string
  jdText?: string
  stage?: string
  stageDeadline?: string
  interviewLink?: string
  prepStatus?: 'ready' | 'generating' | 'suspended_missing_jd' | 'none'
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
  source?: 'boss' | 'email' | 'manual'
  sourceRef?: string
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
  /** 邮件中提取到的职位/岗位编号 */
  jobCode?: string
  confidence: 'high' | 'medium' | 'low'
  /** The matched application id, or undefined when unmatched. */
  applicationId?: string
  /** Existing application snapshot for the queue card (company/position/jobCode). */
  applicationCompany?: string
  applicationPosition?: string
  applicationJobCode?: string
  evidence?: string
  /** Ambiguous candidates when multiple applications exist for the same company (防串线). */
  candidateApplications?: Array<{ id: string; company: string; position: string; jobCode?: string }>
  meetingInfo?: string
  isReschedule?: boolean
  isCancelled?: boolean
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
}

/** Non-secret ToDo settings (ADR 0027 — ToDo 重构). Controls the mail-driven
 *  ToDo pipeline: a one-time 60-day cold-start backfill per account, a
 *  configurable list of school-spam subject tokens to skip, and a kill switch. */
export interface TodoSettings {
  /** One-time purge of legacy email-origin ToDos already done (boot guard). */
  purgeDone?: boolean
  /** Versioned purge guard: the boot purge re-runs whenever this is below the
   *  container's `PURGE_VERSION`. Bump the version after each filtering fix
   *  that needs to re-clear stale email-origin items (NTKs / ToDos / 投递)
   *  and re-backfill with the fixed filters. Idempotent — a higher persisted
   *  version means the purge is a no-op on the next boot. */
  purgeVersion?: number
  /** Connected account ids that have already run the 60-day cold-start
   *  backfill. Keyed by accountId (not provider type) so re-connecting an
   *  account can re-trigger via the manual 重新冷启动 button. */
  coldStartDone?: string[]
  /** Subject-substring tokens treated as school-wide broadcast spam (e.g.
   *  `[student_ips]`). Such mail never reaches an LLM and never produces a
   *  ToDo. Defaults to `['[student_ips]']` downstream. */
  skipTokens?: string[]
  /** Master switch for the cold-start backfill (default on). */
  coldStartEnabled?: boolean
  /** Emails per LLM batch during the cold-start backfill (default 20). */
  backfillBatchSize?: number
  /** One-time guard: `seedDemoData()` has already seeded its AI产品经理 demo
   *  funnel. Set after the first (and only) seed so demo 投递 rows are never
   *  re-created — the purge can clear them (they are source:'email') without
   *  seedDemoData re-seeding them on the next boot. Demo data is for a fresh
   *  empty install; a real user with connected providers must not see fake
   *  投递 ("我啥时候投递过" — ADR 0027 fix). */
  demoSeeded?: boolean
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

/** Daily weather briefing input (ADR 0026). The raw wttr.in figures are fed to
 *  the LLM (or the deterministic stub when no key) which polishes them into a
 *  Chinese summary + clothing advice + practical 宜/忌. No untrusted text enters
 *  this step — wttr.in output is treated as inert DATA (§17). */
export interface DailyWeatherInput {
  /** Real weather figures (trusted DATA — wttr.in, not user/external prose). */
  weather: WeatherData
}

/** Daily weather briefing output — the polished, cacheable briefing shape. This
 *  is what `generate_daily_weather` returns (minus the date/city the service
 *  stamps on afterwards when assembling the cached WeatherBriefing). */
export interface DailyWeatherOutput {
  tempText: string
  summary: string
  clothing: string
  yi: string[]
  ji: string[]
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
  'Tasks',
  'Need to Know',
  'Applications',
  'Routines',
  'Approvals',
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

  // Tasks (M1). create/delete/onTasksChanged added ADR 0026 (Home ToDo mgmt).
  listTasks(): Promise<Task[]>
  createTask(input: TaskCreateInput): Promise<Task>
  updateTask(id: string, patch: TaskUpdate): Promise<Task>
  deleteTask(id: string): Promise<void>
  onTasksChanged(cb: () => void): () => void

  // Need to Know (M1). listMorningBriefs added ADR 0026 (Home 晨报 carousel).
  listNeedToKnow(): Promise<NeedToKnow[]>
  dismissNeedToKnow(id: string): Promise<void>
  clearAllNeedToKnow(): Promise<void>
  /** ADR 0029 — edit a 必读 item's headline (title) / summary inline. */
  updateNeedToKnow(id: string, patch: { title?: string; summary?: string }): Promise<void>
  /**
   * ADR 0029 — lazy R0 fetch of ALL emails in a conversation for the 必读
   * thread-Item expand. Gmail uses threads.get; 163 does a best-effort IMAP
   * header search. Returns [] on any failure (renderer falls back to the
   * surfaced sourceRefs). Never persisted (§17).
   */
  getEmailThread(input: {
    threadId: string
    provider: 'gmail' | 'mail163'
    accountId: string
  }): Promise<NormalizedEmail[]>

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
  /** Confirm a proposed item via the service path (one-per-key demote). */
  confirmMemory(id: string): Promise<MemoryItem>
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

  // Job applications — the cross-channel funnel panel.
  // Manual entries + manual events are local R1 writes (no approval).
  listApplications(): Promise<ApplicationView[]>
  createApplication(input: ApplicationCreateInput): Promise<ApplicationView>
  addApplicationEvent(input: ApplicationEventInput): Promise<ApplicationView>
  /** Update editable rich fields on an application (city, salary, JD, stage,
   *  deadline, interview link, notes, channel, priority). Local DB write (R1,
   *  no approval needed — §15 only gates external writes). */
  updateApplicationFields(id: string, patch: ApplicationUpdateFields): Promise<ApplicationView | undefined>
  fetchJobJd(
    applicationId: string,
    overrides?: { company?: string; position?: string; jobCode?: string }
  ): Promise<{ jdText: string | null; error: string | null }>
  onApplicationChanged(cb: (views: ApplicationView[]) => void): () => void
  // ── Milestone A: email inference, AI generation, recycle bin, config ──
  syncEmailApplications(): Promise<{
    synced: number
    created: number
    pending: number
    message: string
  }>
  uploadResume(applicationId: string): Promise<ResumeVersion | null>
  openPdfInSystem(dataUrl: string): Promise<boolean>
  selectBaseResume(): Promise<{ path: string; fileName: string; text?: string } | null>
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
  confirmEmailMatch(
    messageId: string,
    applicationId?: string,
    options?: { company?: string; position?: string; jobCode?: string; eventType?: ApplicationEventType }
  ): Promise<void>
  ignoreEmailMatch(messageId: string): Promise<void>
  undoEmailEvent(applicationId: string, eventId: string): Promise<boolean>
  rebindEmailEvent(fromAppId: string, eventId: string, toAppId: string): Promise<boolean>
  deleteApplicationEvent(applicationId: string, eventId: string): Promise<ApplicationView>
  updateApplicationStatus(
    applicationId: string,
    status: ApplicationEventType,
    options?: { round?: number; evidence?: string; eventAt?: string }
  ): Promise<ApplicationView>
  updateApplicationJd(applicationId: string, jdText: string): Promise<Application | undefined>
  onEmailMatchesChanged(cb: (matches: EmailMatchProposal[]) => void): () => void
  getJobSearchConfig(): Promise<JobSearchSettings>
  setJobSearchConfig(config: JobSearchSettings): Promise<JobSearchSettings>
  // ── Milestone B: funnel review (stats + AI 复盘) ──
  getApplicationStats(): Promise<ApplicationFunnelStats>
  generateFunnelReview(): Promise<FunnelReviewOutput>
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
  // ── ADR 0026: Home 今日天气 + 天气城市 ──
  /** Today's cached weather briefing (null when not generated / stale). */
  getWeather(): Promise<WeatherBriefing | null>
  /** Force a fresh fetch + generate + cache. Returns the new briefing or null. */
  refreshWeather(): Promise<WeatherBriefing | null>
  getWeatherCity(): Promise<string>
  setWeatherCity(city: string): Promise<string>
  // ── ADR 0027: ToDo overhaul settings + manual cold-start re-scan ──
  /** ToDo pipeline settings (skip-tokens, cold-start toggle, done accounts). */
  getTodoSettings(): Promise<TodoSettings>
  setTodoSettings(todo: TodoSettings): Promise<TodoSettings>
  /** Re-run the 60-day cold-start backfill for one account (accountId =
   *  'gmail-real' / 'mail163-real'). Fire-and-forget on the main side. */
  triggerTodoColdStart(accountId: string): Promise<{ ok: boolean; message?: string }>
}

// Contract on the `window.daymate` global injected by preload.
// The renderer's `env.d.ts` augments the DOM `Window` interface directly with
// `daymate: DaymateApi`; kept out of shared types so the main/preload (node)
// tsconfig does not need the DOM lib.
