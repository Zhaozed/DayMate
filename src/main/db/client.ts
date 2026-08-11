// SQLite database client. better-sqlite3 (synchronous, native) under Drizzle.
// The DB file lives in the user's userData dir so it survives restarts (Spec
// §21 M1 exit criterion: "restarting app preserves Tasks and Routine runs").
//
// The native addon must be rebuilt for Electron's ABI — see `rebuild:native`
// script and ADR 0002. In tests we never load this module (InMemoryStore only).

import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { MIGRATION_SQL } from './migration'

export type AppDb = BetterSQLite3Database<typeof schema>

export interface DbHandle {
  sqlite: Database.Database
  db: AppDb
}

export function createDb(dbPath: string): DbHandle {
  const sqlite = new Database(dbPath)
  // WAL is better for a desktop app with a single writer + concurrent readers.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  // Idempotent — safe on every launch.
  sqlite.exec(MIGRATION_SQL)
  // Guarded column additions for pre-existing dev DBs created before M2.
  // `CREATE TABLE IF NOT EXISTS` won't add columns to an existing table, so we
  // ALTER and swallow the "duplicate column" error on fresh DBs that already
  // have it from the CREATE above.
  applyGuardedAlters(sqlite)
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}

// Add a column that may already exist (older DB). SQLite throws on duplicate
// column name; we treat that as success. (Spec §15 content_hash lands in M2.)
function addColumnIfMissing(sqlite: Database.Database, table: string, column: string, def: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`)
  } catch (err) {
    // "duplicate column name" → already present; anything else rethrows.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/duplicate column/i.test(msg)) throw err
  }
}

function applyGuardedAlters(sqlite: Database.Database) {
  addColumnIfMissing(sqlite, 'approval_requests', 'content_hash', 'TEXT NOT NULL DEFAULT \'\'')
  // M5: traceability column on memory_items (older dev DBs created in M1 lack it).
  addColumnIfMissing(sqlite, 'memory_items', 'routine_run_id', 'TEXT')
  // Milestone A: rich fields on applications for pre-existing dev DBs.
  addColumnIfMissing(sqlite, 'applications', 'city', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'salary_range', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'jd_text', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'stage', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'stage_deadline', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'interview_link', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'priority', "TEXT NOT NULL DEFAULT 'normal'")
  addColumnIfMissing(sqlite, 'applications', 'email_ref_id', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'deleted_at', 'TEXT')
  addColumnIfMissing(sqlite, 'applications', 'archived_at', 'TEXT')
  // Indexes that reference guarded columns must be created AFTER the ALTERs
  // add those columns to pre-Milestone-A dev DBs (else "no such column").
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_applications_deleted ON applications(deleted_at);')
}

