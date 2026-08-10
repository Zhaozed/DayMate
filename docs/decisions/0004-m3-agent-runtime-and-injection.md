# ADR 0004 — Milestone 3: agent runtime, key-gated model gateway, injection hardening

Date: 2026-08-06
Status: Accepted
Milestone: 3

## Context

M3 wires the two agent steps (`generate_morning_brief`, `classify_inbox`)
behind a **key-gated model adapter**: with an LLM key configured through a
secure, renderer-write-only, `safeStorage`-encrypted flow, the steps produce
structured output via a real model (`@earendil-works/pi-agent-core` +
`@earendil-works/pi-ai`); with **no key**, the existing deterministic stubs run
unchanged. Partial-failure is reported clearly (a down email provider does not
kill a routine; an unavailable LLM fails the run, never silently stubs). The
§17 prompt-injection suite is formalized. A Feishu calendar provider skeleton
lands (real Feishu deferred until creds). Memory Service stays deferred to M5
(spec §21).

## Decision 1 — ESM-only deps loaded via dynamic `import()`, key-gated

**Problem:** `pi-agent-core` and `pi-ai` are `"type":"module"` and declare
`engines: node>=22.19`. Daymate's main is CommonJS (ADR 0001) and
`externalizeDepsPlugin()` externalizes `dependencies`, so a static `import`
becomes a runtime `require()` → `ERR_REQUIRE_ESM`. Electron 33 = Node 20.18.

**Decision:** `src/main/agent/model-gateway.ts` loads both packages via
**dynamic `import()`**, cached in module-local promises, and **only when an
LLM path is actually needed**. Types come from `import type` (erased at
build). The no-key production path never loads the heavy provider modules —
the deterministic stub runs straight through — so the Node-22 engine
requirement is sidestepped entirely for the credential-free default. If a
real-provider call ever fails to load/run on Electron 33's Node 20, it is
caught and surfaced as "LLM runtime unavailable" (partial-failure); bumping
Electron to ≥35 (Node 22) is a tracked fallback, not a blocker.

`ModelGateway.available()` is true iff a key exists for the configured
provider. `AgentRuntime.runAgentStep`:
- `!available` → deterministic stub (unchanged behavior, every existing test).
- `available` → real `Agent` path.
- real path fails (import error, auth/network error, no tool call, schema
  mismatch) → throw `AgentStepError`; the run fails clearly. **No silent stub
  fallback when a key is present** — the user opted into the LLM.

## Decision 2 — Structured output via an output tool (TypeBox), not JSON parsing

**Problem:** the model must return a structured object matching
`MorningBriefOutput` / `ClassifyInboxOutput`. Parsing free-form JSON text is
fragile and un-validated.

**Decision:** the SDK-idiomatic pattern — a single **output tool**
(`submit_brief` / `submit_classifications`) whose TypeBox `parameters` schema
mirrors the authoritative Zod output schema; the model calls it as its terminal
action (`terminate: true`), the runtime captures the args, re-validates with
Zod (defence in depth), then returns. `createCaptureTool` in
`structured-output.ts` builds the tool. Two small parallel TypeBox schemas sit
alongside the Zod ones — accepted duplication, since no Zod↔TypeBox converter
exists and writing one is out of scope.

The model does **not** call Tool Registry tools in M3 — the agent steps reason
over data pre-fetched by prior `tool` steps. The Tool Registry is untouched and
remains the only path to external systems (§11).

## Decision 3 — Low-level `Agent`, not `AgentHarness`

The harness requires a persistent `Session` (transcript tree) + skills/compaction
— infrastructure for Memory (M5), not needed for stateless one-shot steps. M3
uses `new Agent({ streamFn, getApiKey, initialState: { systemPrompt, model,
tools }, })` + `prompt()` + `waitForIdle()`. `streamFn` = `models.streamSimple`;
`getApiKey` reads from the `SecretStore` at call time.

## Decision 4 — Secure key flow (§17.6/§17.8): write-only, encrypted at rest

`SecretStore` (`src/main/util/secrets.ts`) encrypts the key with Electron
`safeStorage` (macOS Keychain) to a file under `userData`; in-memory fallback
for tests/non-Electron (warns; never persisted to disk in fallback). It
implements pi-ai's `CredentialStore` (`read`/`list`/`modify`/`delete`) so
`builtinModels({ credentials: secrets })` resolves auth at call time, and
supplies `AgentOptions.getApiKey`.

IPC is **write-only for the key**: `LLM_SET_KEY`, `LLM_DELETE_KEY`, and
`LLM_GET_CONFIG` returns only `{ provider, modelId, keyConfigured: boolean }`.
The key string never crosses to the renderer, never enters model context (the
SDK resolves it into `StreamOptions.apiKey`), and is never logged. Non-secret
`{ provider, modelId }` lives in a plain `settings.json`.

## Decision 5 — §17 injection hardening, formalized

`prompt-injection.ts` is the single source of truth for the untrusted gate used
by BOTH the stub and the LLM path:
- `isUntrusted(email)` — SPAM label OR injection markers.
- `capInput(text)` — length-cap at `MAX_MODEL_INPUT_CHARS` (§17.14).
- `frameEmail(email)` — wraps the body in an inert `<email>` DATA block inside
  a USER message; untrusted items flagged `<trusted>false</trusted>`.
- `buildSystemPrompt(action)` — host-set, constant system prompt; the model
  cannot change it. Email content arrives only as user messages, so it can
  never become an instruction (§17.1/§17.2).

`enforceTrust` is a **deterministic overlay applied AFTER the model returns**
(§12: agent decisions separate from deterministic business rules): it forces
any untrusted email to `ignore`+`untrusted` and strips tasks/suggested-actions
referencing untrusted mail — regardless of what the model said. So §17
guarantees hold for both paths. The §17 test suite (`prompt-injection.test.ts`)
asserts: injection fixtures → `untrusted`/`ignore`, no task/draft/send;
untrusted text only in user messages, never in the system prompt; unknown
action fails clearly.

## Decision 6 — Partial-failure: `continueOnError` + `provider_unavailable`

New `continueOnError?: boolean` on `ToolStep`. When set, a tool `error`
outcome records a `provider_unavailable` Activity event and stores `undefined`
instead of failing the run (§12.8/§12.9 still apply otherwise). Auto Inbox
sets it on its two `email.list` steps, so 163-down → Gmail still triaged, and
the outage is visible in the Activity page. LLM unavailability surfaces via
`AgentStepError` (decision 1). `agent_completed`/`agent_failed` Activity
events now bracket every agent step (previously only `agent_started`).

## Decision 7 — Feishu skeleton (real API deferred)

`FeishuCalendarProvider` implements `CalendarProvider`, reports `disconnected`,
and throws a clear "not configured" error on every data operation — it never
makes a real Feishu call and never fakes data. The mock calendar remains the
default until creds arrive. Surfaced on the Integrations page as a skeleton.

## Verification (spec §23 rule 14)

- `pnpm rebuild better-sqlite3` → `pnpm test` → `pnpm rebuild:native`: **75
  tests pass** (was 45; +30 across 4 new files: secret-store, agent-runtime,
  prompt-injection, partial-failure; existing helpers updated for
  `agentRuntime`).
- `pnpm typecheck` · `pnpm lint` · `pnpm build`: all green (dynamic-import
  types via `import type`; `Model<Api>` instead of `any`).
- Real-path LLM seam covered without a key via a fake `ModelGateway` + fake
  `Agent` (scripted terminal tool call) — covers capture → Zod validation →
  `enforceTrust` → `AgentStepError` on every failure mode.

## Deferred (out of this pass)

- Real Feishu Calendar API (P1) — skeleton only; activates when creds supplied.
- Exposing the Tool Registry to the model as callable tools (agent-driven tool
  selection) — later milestone; M3 agent steps reason over pre-fetched data.
- Memory Service — M5 (spec §21).
- Bumping Electron to ≥35 for Node 22 — only if a real-provider runtime
  incompatibility is observed.

## Changed files

- shared: `types.ts` (LlmConfig*, DaymateApi LLM methods, ToolStep.continueOnError),
  `schemas.ts` (llmConfigSchema, morningBrief/classifyInbox output schemas,
  toolStepSchema.continueOnError), `constants.ts` (LLM_* channels, LLM_PROVIDERS,
  defaults, MAX_MODEL_INPUT_CHARS, agent_completed/agent_failed/provider_unavailable).
- agent: `agent-runtime.ts` (refactored to AgentRuntime + key-gated real path +
  AgentStepError + enforceTrust), `model-gateway.ts` (new), `structured-output.ts`
  (new), `prompt-injection.ts` (new).
- util: `secrets.ts` (new), `settings.ts` (new).
- routines: `engine.ts` (agentRuntime dep, agent_completed/failed,
  continueOnError), `templates/auto-inbox.ts` (continueOnError on email.list).
- providers/calendar: `feishu-calendar-provider.ts` (new skeleton).
- app/container.ts, ipc/handlers.ts, ipc/contracts.ts, preload/index.ts (LLM wiring).
- renderer: `workbench/src/pages/Integrations.tsx` (LLM card + Feishu note).
- tests: 4 new files; 4 existing helpers updated for `agentRuntime`.
