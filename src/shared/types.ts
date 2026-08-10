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
  ApplicationEventType
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
  ApplicationEventType
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

/** A proactive bubble pushed to the robot surface (M4 §18). */
export interface RobotNotify {
  message: string
  /** Present when the bubble should offer a "Review" deep-link to an approval. */
  approvalId?: string
  /** Which workbench page to open when the user taps the bubble, if any. */
  navigateTo?: WorkbenchPage
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
  syncBossApplications(): Promise<{ synced: number; message: string }>
  getBossStatus(): Promise<BossStatus>
  onApplicationChanged(cb: (views: ApplicationView[]) => void): () => void
}

// Contract on the `window.daymate` global injected by preload.
// The renderer's `env.d.ts` augments the DOM `Window` interface directly with
// `daymate: DaymateApi`; kept out of shared types so the main/preload (node)
// tsconfig does not need the DOM lib.
