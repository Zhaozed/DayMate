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

// ── Memory items (M5; table ready now) ───────────────────────────────────────
export const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source').notNull(),
  confirmed: text('confirmed').notNull(), // '0' | '1'
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})
