# Daymate — Claude Code Guide

> Living document. Update at the end of every milestone. Spec §23 rule 2.

## What this is

Daymate is a persistent macOS-first desktop personal work agent. It connects
Gmail, 163 Mail and Feishu Calendar, proactively executes configurable
Routines, converts important information into Tasks and Need to Know items, and
requires explicit approval before any external write action.

Authoritative product spec: `DEVELOPMENT_SPEC.md`. Read it fully before editing.

## Architecture constraints (do not violate)

- **Main process owns everything sensitive.** All credentials, Provider calls,
  Pi Agent execution, Routine scheduling and database writes run in the Electron
  main process. The renderer communicates through typed IPC only.
- **Renderer is sandboxed.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. Never expose Node.js, tokens, authorization codes, or raw
  database access to the renderer.
- **Typed IPC.** Canonical contracts live in `src/shared`. The preload is the
  only module that touches `ipcRenderer`; it exposes a typed `window.daymate`
  API via `contextBridge`.
- **Email Provider abstraction.** Business logic and Routines must not contain
  Gmail- or 163-specific branches (Spec §9).
- **Tool Registry is the only Agent path to external systems.** Pi Agent may
  select tools but cannot bypass the Tool Registry or Approval Service (§11).
- **Approval gates every external write.** R0/R1 auto, R2 approval, R3 preview +
  approval, R4 forbidden in MVP. Content cannot change between approval preview
  and execution (§15).
- **Keep Agent decisions separate from deterministic business rules.** Agent
  reasoning only inside explicit agent steps (§12).

## Scope exclusions (out of scope for MVP — Spec §2)

Do not implement without explicit approval: multiple agents; voice wake word;
continuous screenshots; keyboard/mouse capture; autonomous desktop control;
mobile/Windows; Slack/WeChat/Notion/Drive; public multi-user SaaS; arbitrary
NL Routine generation; automatic email sending without approval; deletion of
external data; 3D robot; productivity/slacking score.

## Tech stack

Electron · electron-vite · React + TypeScript · Tailwind CSS v4 ·
`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` · Zod ·
SQLite + Drizzle ORM · node-cron · Gmail API · IMAP/SMTP (163) · Feishu OpenAPI.

## Commands

```bash
pnpm install
pnpm dev          # electron-vite dev — launches robot + workbench
pnpm typecheck    # tsc --noEmit for node + web projects
pnpm lint
pnpm test         # vitest run
pnpm test:e2e     # Playwright — wired in Milestone 4
pnpm build        # electron-vite build
```

Do not claim a command passes unless it was actually run (Spec §23 rule 14).

## Repo layout (Spec §7)

```
src/main/        windows · agent · routines · providers · services · db · ipc
src/preload/     contextBridge bridge (only ipcRenderer surface)
src/renderer/    robot/ · workbench/  (separate HTML entries)
src/shared/      types.ts · schemas.ts · constants.ts  (IPC contracts)
tests/           unit/ · integration/ · e2e/
docs/            decisions/ · evaluation/ · screenshots/
```

## Current milestone

**Milestone 0 — repository and guardrails** ✅ complete

Verified: app launches; main + renderer compile; robot + workbench windows
open and render content; no Node API exposed to renderer (contextIsolation +
sandbox + typed IPC); typecheck + lint + unit tests + build all pass.

Key build/security decisions in `docs/decisions/0001-m0-security-and-build.md`:
main + preload are CommonJS (no `"type": "module"`) so the sandboxed preload
loads; CSP is set via session header (dev-permissive for Vite HMR, prod-strict);
renderer windows load `/robot/index.html` and `/workbench/index.html`.

**Milestone 1 — domain and Routine foundation** ✅ complete

Verified: mock Morning Brief Routine runs end-to-end (engine integration test);
Activity page shows every step; SQLite DB persists across restart (DB file in
userData, WAL mode); typecheck + lint + 28 tests + build all pass; app boots
cleanly with DB init + preset seeding + scheduler start.

Key decisions in `docs/decisions/0002-m1-routine-engine-and-store.md`:
- persistence behind a `RoutineStore` interface (`SqliteStore` for prod via
  drizzle + better-sqlite3, `InMemoryStore` for tests) so the engine is
  testable without loading the native addon;
- `better-sqlite3` rebuilt for Electron via `predev`/`prebuild` (`rebuild:native`);
- hand-written idempotent `CREATE TABLE` migrations (no `drizzle-kit` yet);
- deterministic mock `generate_morning_brief` agent step (real LLM in M3);
- run-level + task-level idempotency; Tool Registry gates R2/R3 tools
  (`needs_approval` → run pauses → `engine.resume()`).

**Next: Milestone 2 — email integrations.** Email Provider interface, Gmail
OAuth + Provider, 163 IMAP/SMTP Provider, normalized email feed, Auto Inbox
classification, draft creation, Approval Service (execute the paused/resume
path), approved send, duplicate-send protection.

## Working rules (Spec §23)

1. Implement one milestone at a time. 2. Do not add dependencies without
explaining why. 3. Do not expand scope. 4. Never hardcode credentials or expose
secrets through IPC. 5. Use typed schemas for external and model outputs.
6. Use mock providers before real integrations. 7. Add tests for approval and
idempotency before email sending. 8. Record architecture decisions under
`docs/decisions/`. 9. After each milestone run typecheck, tests and the critical
flow; report changed files, tests, known limitations and next milestone.
