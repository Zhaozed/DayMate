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
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}
