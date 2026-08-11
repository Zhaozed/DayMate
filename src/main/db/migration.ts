// Idempotent migration SQL. Run at startup via better-sqlite3 `exec`.
// CREATE TABLE IF NOT EXISTS keeps this safe to run on every launch. Kept in
// sync with `schema.ts` by hand (drizzle-kit not adopted in M1; see ADR 0002).

export const MIGRATION_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  due_at TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  routine_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS need_to_know (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  suggested_actions TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled TEXT NOT NULL,
  trigger TEXT NOT NULL,
  inputs TEXT NOT NULL,
  steps TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  current_step_id TEXT,
  inputs TEXT NOT NULL,
  step_outputs TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_routine ON routine_runs(routine_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idem ON routine_runs(idempotency_key);

CREATE TABLE IF NOT EXISTS routine_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON routine_run_steps(run_id);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity_events(run_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events(created_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  routine_run_id TEXT,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confirmed TEXT NOT NULL,
  routine_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_items(key);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  position TEXT NOT NULL,
  source TEXT NOT NULL,
  boss_security_id TEXT,
  applied_at TEXT NOT NULL,
  channel_ref TEXT,
  notes TEXT,
  -- Milestone A rich fields:
  city TEXT,
  salary_range TEXT,
  jd_text TEXT,
  stage TEXT,
  stage_deadline TEXT,
  interview_link TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  email_ref_id TEXT,
  deleted_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_boss_sid ON applications(boss_security_id);
-- NOTE: idx_applications_deleted is created in applyGuardedAlters (client.ts),
-- AFTER the guarded ALTERs add deleted_at/archived_at to pre-Milestone-A
-- dev DBs. Creating it here would fail on those DBs: CREATE TABLE IF NOT EXISTS
-- is a no-op on the existing table (column not added), so the index references
-- a non-existent column.

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL,
  round TEXT,
  role TEXT,
  sub_state TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  evidence TEXT,
  locked TEXT NOT NULL,
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_events_app ON application_events(application_id);
CREATE INDEX IF NOT EXISTS idx_app_events_ref ON application_events(source_ref);

-- Milestone A: per-application versioned AI artefacts. The latest version
-- is active; no separate active flag. prompt_hash short-circuits a re-request
-- whose inputs are unchanged (skip the LLM call).
CREATE TABLE IF NOT EXISTS resume_versions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  html TEXT NOT NULL,
  model_id TEXT,
  prompt_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resume_versions_app ON resume_versions(application_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_versions_app_ver ON resume_versions(application_id, version);

CREATE TABLE IF NOT EXISTS prep_materials (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  html TEXT NOT NULL,
  model_id TEXT,
  prompt_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prep_materials_app ON prep_materials(application_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_materials_app_ver ON prep_materials(application_id, version);

-- 面经库 (Spec §6). Standalone (not tied to one application) so a note for
-- company X is reusable across applications. tags is a JSON string[].
CREATE TABLE IF NOT EXISTS interview_notes (
  id TEXT PRIMARY KEY,
  company TEXT,
  position TEXT,
  application_id TEXT,
  tags TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_notes_company ON interview_notes(company);
CREATE INDEX IF NOT EXISTS idx_interview_notes_app ON interview_notes(application_id);
`
