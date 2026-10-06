// Drizzle ORM schema for SQLite. (Spec §5, §8)
//
// Tables are created at startup by the idempotent migration SQL in
// `migration.ts`. This file defines the Drizzle table objects so the
// SqliteStore can build typed queries. Keep the two in sync — drift is a known
// limitation (drizzle-kit migrations not adopted in M1; see ADR 0002).
//
// All timestamps are ISO-8601 TEXT. All JSON-valued columns store stringified
// JSON. IDs are client-generated strings (crypto.randomUUID).

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ── Integration accounts (M2/M3 fill rows; table ready now) ──────────────────
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  status: text('status').notNull(),
  scopes: text('scopes').notNull(), // JSON string[]
  lastSyncAt: text('last_sync_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ── Tasks ────────────────────────────────────────────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  dueAt: text('due_at'),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id'),
  routineRunId: text('routine_run_id'),
  // ADR 0026 — which mail provider an auto-generated mail ToDo came from
  // (badges the Home ToDo list with 163 / Gmail). Nullable for legacy/manual.
  sourceProvider: text('source_provider'),
  // ADR 0027 — coarse domain tag (学校/求职/账单/会议/其他) + deep link back
  // to the source mail (Gmail only; 163 has no web deep link).
  category: text('category'),
  sourceLink: text('source_link'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ── Need to Know ─────────────────────────────────────────────────────────────
export const needToKnow = sqliteTable('need_to_know', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  reason: text('reason').notNull(),
  priority: text('priority').notNull(),
  sourceRefs: text('source_refs').notNull(), // JSON SourceRef[]
  suggestedActions: text('suggested_actions').notNull(), // JSON SuggestedAction[]
  readAt: text('read_at'),
  dismissedAt: text('dismissed_at'),
  // ADR 0026 — distinguishes morning-brief NTKs (Home 晨报 carousel, ~7d) from
  // email-driven NTKs (the 必读 page). null = legacy / email-driven.
  kind: text('kind'),
  // ADR 0029 — thread key (Gmail threadId / 163 synthesized from References).
  // Emails in the same thread collapse into ONE 必读 item.
  threadId: text('thread_id'),
  // ADR 0029 — 必读 top-level section tag (学校/求职/日常/其他).
  briefingCategory: text('briefing_category'),
  // ADR 0029 — email source provider + deep link + account id (for getEmailThread).
  sourceProvider: text('source_provider'),
  sourceAccountId: text('source_account_id'),
  sourceLink: text('source_link'),
  updatedAt: text('updated_at'),
  createdAt: text('created_at').notNull()
})

// ── Routine definitions ─────────────────────────────────────────────────────
export const routines = sqliteTable('routines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  version: text('version').notNull(),
  enabled: text('enabled').notNull(), // '0' | '1'
  trigger: text('trigger').notNull(), // JSON RoutineTrigger
  inputs: text('inputs').notNull(), // JSON
  steps: text('steps').notNull(), // JSON RoutineStep[]
  approvalPolicy: text('approval_policy').notNull(),
  output: text('output').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ── Routine runs ────────────────────────────────────────────────────────────
export const routineRuns = sqliteTable('routine_runs', {
  id: text('id').primaryKey(),
  routineId: text('routine_id').notNull(),
  status: text('status').notNull(),
  triggerType: text('trigger_type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  currentStepId: text('current_step_id'),
  inputs: text('inputs').notNull(), // JSON
  stepOutputs: text('step_outputs').notNull(), // JSON Record<string, unknown>
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error')
})

// ── Per-step execution state (enables resume after approval) ────────────────
export const routineRunSteps = sqliteTable('routine_run_steps', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  stepId: text('step_id').notNull(),
  status: text('status').notNull(),
  output: text('output'), // JSON
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at')
})

// ── Activity events ─────────────────────────────────────────────────────────
export const activityEvents = sqliteTable('activity_events', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  type: text('type').notNull(),
  summary: text('summary').notNull(),
  metadata: text('metadata').notNull(), // JSON (redacted)
  createdAt: text('created_at').notNull()
})

// ── Approval requests (Spec §8, §15) ─────────────────────────────────────────
// `contentHash` = SHA-256 of canonical JSON of the action args at preview time.
// Recomputed at execution; mismatch refuses the action (§15 content immutability).
export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  routineRunId: text('routine_run_id'),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  riskLevel: text('risk_level').notNull(),
  title: text('title').notNull(),
  preview: text('preview').notNull(), // JSON
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at')
})

// ── Memory items (Spec §16; M5) ─────────────────────────────────────────────
// Agent proposals land `confirmed:'0'`; the user confirms them in the Memory
// page, flipping to `'1'`. Only confirmed items are active (searchable).
export const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source').notNull(),
  confirmed: text('confirmed').notNull(), // '0' | '1'
  routineRunId: text('routine_run_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ── Job applications (boss-cli integration) ──────────────────────────────────
// An Application = one job the user applied to (boss-cli sync or manual).
// `boss_security_id` is the upsert key for boss-synced rows (NULL for manual).
// `source` ∈ boss|manual|web|referral|other.
export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  company: text('company').notNull(),
  position: text('position').notNull(),
  source: text('source').notNull(),
  bossSecurityId: text('boss_security_id'),
  appliedAt: text('applied_at').notNull(),
  channelRef: text('channel_ref'),
  notes: text('notes'),
  // Milestone A rich fields:
  city: text('city'),
  jobCode: text('job_code'),
  salaryRange: text('salary_range'),
  jdText: text('jd_text'),
  stage: text('stage'),
  stageDeadline: text('stage_deadline'),
  interviewLink: text('interview_link'),
  priority: text('priority').notNull(), // 'normal' | 'back'
  emailRefId: text('email_ref_id'),
  deletedAt: text('deleted_at'),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ── Application progress events (Spec §4.1 event timeline) ──────────────────
// Each row is one detected stage (applied/communicated/assessment/written_test
// /interview/offer/rejected/withdrawn). The latest event is the current stage;
// offer/rejected/withdrawn are terminal. `locked` = user-pinned, auto-detection
// (P2) will not silently move status past it. `source_ref` is the idempotency
// key for boss-synced / email-detected events (emailId / bossChatId).
export const applicationEvents = sqliteTable('application_events', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull(),
  type: text('type').notNull(),
  round: text('round'), // int as TEXT
  role: text('role'),
  subState: text('sub_state'),
  source: text('source').notNull(), // boss|email|manual
  sourceRef: text('source_ref'),
  evidence: text('evidence'),
  locked: text('locked').notNull(), // '0' | '1'
  eventAt: text('event_at').notNull(),
  createdAt: text('created_at').notNull()
})

// ── Resume versions (Milestone A §4.2) ───────────────────────────────────────
// Per-application versioned AI-tailored HTML resumes. Latest `version` is
// active. `promptHash` = SHA-256 of (baseResume + jdText) to short-circuit a
// re-request whose inputs are unchanged.
export const resumeVersions = sqliteTable('resume_versions', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull(),
  version: text('version').notNull(), // int as TEXT
  html: text('html').notNull(),
  modelId: text('model_id'),
  promptHash: text('prompt_hash'),
  createdAt: text('created_at').notNull()
})

// ── Interview prep materials (Milestone A §4.3) ──────────────────────────────
// Per-application versioned interview-prep transcript (structured HTML).
export const prepMaterials = sqliteTable('prep_materials', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull(),
  version: text('version').notNull(),
  html: text('html').notNull(),
  modelId: text('model_id'),
  promptHash: text('prompt_hash'),
  createdAt: text('created_at').notNull()
})

// ── 面经库 (Milestone A §6) ───────────────────────────────────────────────────
// Standalone post-interview experience note (not tied to one application).
// `tags` is a JSON string[]. `source` is 'manual' | 'agent'.
export const interviewNotes = sqliteTable('interview_notes', {
  id: text('id').primaryKey(),
  company: text('company'),
  position: text('position'),
  applicationId: text('application_id'),
  tags: text('tags').notNull(), // JSON string[]
  content: text('content').notNull(),
  source: text('source').notNull(), // manual|agent
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})
