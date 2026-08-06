# ADR 0002 — Milestone 1: store seam, native rebuild, mock agent, idempotency

Date: 2026-08-06
Status: Accepted
Milestone: 1

## Context

M1 introduces SQLite persistence, the schema-driven Routine Engine, the Tool
Registry, mock providers, and a mock Morning Brief that must run end-to-end and
survive restarts (spec §21 M1 exit criteria). Three decisions shaped the design.

## Decision 1 — Persistence behind a `RoutineStore` interface

**Problem:** better-sqlite3 is a native addon. It must be rebuilt for Electron's
NODE_MODULE_VERSION, but the same binary must match Node's ABI to load under
vitest. A single binary cannot satisfy both, so tests that load better-sqlite3
break depending on which ABI is currently built.

**Decision:** The Routine Engine and all services depend on a `RoutineStore`
**interface**, never on Drizzle or better-sqlite3. Production wires a
`SqliteStore` (drizzle-orm over better-sqlite3); tests wire an `InMemoryStore`
(pure TS). No test imports better-sqlite3, so the engine idempotency/resume
tests run under plain vitest regardless of rebuild state. This also enforces
clean architecture: domain logic has no persistence-mechanism coupling.

A `SqliteStore` smoke test is the only test that would touch the native addon;
it is deferred to avoid the ABI dance. Persistence in the real app is verified
by booting the app (DB file appears in userData) and by the engine tests that
exercise the same code paths through the interface.

**Rejected:** inject a drizzle instance into services and test with `:memory:`
better-sqlite3. Rejected because those tests still load the native addon and
break under the Electron-rebuilt binary.

## Decision 2 — better-sqlite3 native rebuild strategy

**Problem:** Forgetting to rebuild for Electron produces a confusing
`NODE_MODULE_VERSION mismatch` crash at runtime.

**Decision:** Add `@electron/rebuild` and a `rebuild:native` script
(`electron-rebuild -f -w better-sqlite3`). `predev` and `prebuild` invoke it so
the app always gets the Electron ABI automatically. It is NOT a `postinstall`:
keeping the default install = node build means `pnpm test` stays green out of
the box (no test loads the addon). After `pnpm dev` the binary is
Electron-built, but tests are unaffected (InMemoryStore).

The DB file lives at `app.getPath('userData')/daymate.db` with WAL journaling,
so it survives restarts (M1 exit criterion).

## Decision 3 — Hand-written idempotent migrations (no drizzle-kit)

**Problem:** drizzle-orm table objects do not create tables; that requires
drizzle-kit migrations or raw SQL.

**Decision:** Hand-written `CREATE TABLE IF NOT EXISTS` SQL in
`src/main/db/migration.ts`, run at startup. Avoids adding `drizzle-kit` as a
dependency (spec rule 2: don't add deps without reason). Drizzle schema objects
in `schema.ts` are still used by `SqliteStore` for typed queries.

**Known limitation:** the SQL and the Drizzle schema are kept in sync by hand;
drift is possible. If schema churn grows, adopt `drizzle-kit` migrations then.

## Decision 4 — Mock agent step (no LLM in M1)

**Problem:** The Morning Brief agent step needs structured output, but the real
model runtime (`pi-agent-core` + `pi-ai`) is an M3 concern.

**Decision:** `runAgentStep(action, input)` in `src/main/agent/agent-runtime.ts`
is a deterministic stub. `generate_morning_brief` reads the tool outputs
(emails/events/tasks) and returns a canned brief + suggested task. The contract
(action in, structured object out) is stable, so the engine does not change
when the stub is replaced by the real agent in M3.

The mock classifies SPAM-labeled / injection-marker mail as untrusted and never
acts on it — the structure for the M5 prompt-injection tests.

## Decision 5 — Idempotency at two levels

- **Run level:** every run carries an `idempotencyKey`. Scheduled/poll triggers
  derive it from a time bucket (`sched:<minute>` / `poll:<bucket>`); manual
  triggers get a unique key (always fresh). A second run with the same key
  returns the existing run and does not re-execute — prevents duplicate
  external writes on a duplicated trigger or retry (spec §12.6, §19 release
  gate "no duplicate email sending in retry test").
- **Task level:** `TaskService.create` deduplicates by
  `(sourceType, sourceId)` so a re-run or a retry never creates a second Task
  for the same source email.

## Decision 6 — Pause/resume shape (approval lands in M2)

The Tool Registry gates R2/R3 tools: calling one without an approval context
returns `{ status: 'needs_approval' }` and does NOT execute. The Routine Engine
then persists `currentStepId`, sets the run to `waiting_approval`, and stops.
`engine.resume(runId, { approval })` re-executes from the current step with the
approval context so the gated action proceeds. The full approval-resolution UI
(creating approval requests, user approve/reject, content-immutability check
between preview and execution) is M2; the engine shape is in place and tested
via the pause/resume integration test.
