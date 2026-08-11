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

**Milestone 2 — email integrations (credential-free core)** ✅ complete

Verified: Approval Service + content-immutability hashing (SHA-256 of canonical
JSON) gate every external write; Auto Inbox routine classifies a unified feed
across mock Gmail + mock 163, dedupes by messageId, ignores SPAM/injection
fixtures, creates Tasks + Need to Know; approval flow tested end-to-end (pause →
approve → execute + markExecuted; reject → cancelled, sends nothing; content
tamper → execution refused; duplicate run → no-op); approvals + content_hash +
runs persist across a real-SQLite restart; typecheck + lint + 45 tests (incl.
real better-sqlite3) + build all pass.

Key decisions in `docs/decisions/0003-m2-approval-immutability-and-providers.md`:
- content immutability: `content_hash` on `approval_requests`, recomputed at
  resume, mismatch refuses execution (Spec §15);
- engine creates the ApprovalRequest from the resolved step args (registry is a
  pure gate); `cancelPausedRun` for reject (action never executes);
- multi-provider `emailProviders[]` selected by `accountId` (Spec §9) — mock
  Gmail + mock 163 unified feed;
- deterministic `classify_inbox` + `inbox.create_tasks` (real LLM in M3);
- duplicate-send protection at run + approval level (Spec §19).

**Deferred (out of this pass — spec rule 6/7, credential-free):** real Gmail OAuth
(loopback callback) and real 163 IMAP/SMTP are skeletons only; activate when the
user supplies credentials through the secure flow. Feishu create/update (P1) and
real LLM classification land in M3.

**Milestone 3 — credential-free agent runtime + injection hardening** ✅ complete

Verified: the two agent steps (`generate_morning_brief`, `classify_inbox`) are
key-gated — with an LLM key they run on a real model (`pi-agent-core` + `pi-ai`),
without one the deterministic stubs run unchanged; the key is write-only from the
renderer, `safeStorage`-encrypted at rest, and never enters model context or the
renderer (Spec §17.6/§17.8); §17 prompt-injection suite formalized (injection
fixtures → `untrusted`/`ignore`, no task/draft/send; untrusted text only in user
messages, never in the host-set system prompt; length-capped); partial-failure
handled (one email provider down → `provider_unavailable` Activity, the other
still triaged, run completes; an unavailable LLM with a key → `AgentStepError`,
no silent stub fallback); Feishu calendar provider skeleton (real API deferred);
typecheck + lint + 75 tests + build all pass.

Key decisions in `docs/decisions/0004-m3-agent-runtime-and-injection.md`:
- `pi-agent-core`/`pi-ai` are ESM-only (`engines: node>=22.19`); loaded via
  dynamic `import()` (cached), types via `import type` (erased). The no-key path
  never loads the heavy modules, sidestepping the Node-22 requirement;
- structured output via an output tool (`submit_brief`/`submit_classifications`,
  TypeBox `parameters` mirroring the authoritative Zod schema) + capture +
  Zod re-validation — the model never calls Tool Registry tools in M3;
- `ModelGateway.available()` (key exists) gates stub-vs-real; real-path failure
  → `AgentStepError` (fail clearly, never silently stub when a key is present);
- `enforceTrust` deterministic overlay applied AFTER model output (§12) so §17
  holds regardless of what the model returns;
- `ToolStep.continueOnError` → `provider_unavailable` + continue (Auto Inbox);
- `SecretStore` implements pi-ai `CredentialStore`; IPC key is write-only;
  `settings.json` holds only non-secret `{ provider, modelId }`.

**Deferred (out of this pass):** real Feishu Calendar API (skeleton only —
activates when creds supplied); exposing the Tool Registry to the model as
callable tools (later milestone); Memory Service — M5 (spec §21); bumping
Electron to ≥35 for Node 22 — only if a real-provider runtime incompatibility
is observed.

**Milestone 4 — robot surface, notifications, packaging, e2e** ✅ complete

Verified: a `RobotStateController` derives robot state from Activity events
(working→thinking→need_approval→done, sticky approval, 6s done→idle reset)
and pushes it live to the robot window; the robot surfaces proactive bubbles
(`onRobotNotify`) + a quick panel (state, NTK, approvals, Run Morning Brief,
Open Workbench) with a fixed-anchor view resize (`orb`/`bubble`/`panel` via
`SET_ROBOT_VIEW`) and a native right-click context menu (pause/resume/open
workbench/quit); approval is reachable from the robot (Review deep-link opens
the workbench at Approvals); workbench pages render a loading/error/empty triad
(`useAsync` + `Loading`/`EmptyState`/`ErrorState`, no silent IPC-error
swallowing) and the Routines page shows next-run + run history + inline trigger
editing; a new **Draft Review** preset produces a real pausing flow (R3
`email.create_draft` approval step with field-templated args
`{{gmailEmails[0].…}}`); macOS packaging via electron-builder produces a local
unsigned `Daymate.app` (+ dmg); a real Playwright Electron e2e suite (3 specs —
boot, Morning Brief robot-state reflection, approval-from-robot) runs green
over the credential-free mock path with per-test userData isolation; two latent
bugs fixed along the way — `resolveTemplate` now supports array-index
(`[N]`) tokens, and `engine.resolveStepArgs` now resolves against
`run.stepOutputs` so templated approval args hash-match at resume (was empty
outputs → spurious "content changed" refusal); typecheck + lint + 93 tests +
build + dist + e2e all pass.

Key decisions in `docs/decisions/0005-m4-robot-and-e2e.md`:
- robot state owned by a pure, framework-agnostic `RobotStateController`
  (`onChange` + injectable timer) driven by `ActivityService.subscribe`;
  `notify` no longer hard-codes `setRobotState('done')` — it only emits the
  bubble;
- view-driven window resize around a fixed screen anchor (orb never jumps); no
  click-through hackery; click/double-click/drag discriminated by a 220ms
  timer + `app-region: drag`;
- context-menu installer takes injected actions so `robot-window.ts` stays
  cycle-free; `RoutineScheduler.pause()`/`resume()` toggle a flag suppressing
  `fire` (manual runs unaffected), distinct from `stop()`;
- Draft Review preset required array-index template support + a
  content-immutability fix (`resolveStepArgs` now uses `run.stepOutputs`);
  regression test added;
- `useAsync`/`states` triad applied across Home/Tasks/Activity/NeedToKnow/
  Approvals/Routines/Integrations; Routines gains next-run + history + inline
  trigger edit (`updateRoutine`); step editing stays M5;
- electron-builder (`dir`+`dmg`, host-arch only, `asarUnpack` for
  better-sqlite3, no signing/notarization); `test:e2e` =
  `pnpm build && playwright test`, `DAYMATE_USER_DATA` env honored before
  bootstrap for per-test isolation.

**Deferred (out of this pass):** full conversational Assistant (model-callable
tool surface + stop action) — M5; Memory Service — M5 (§21); real Feishu /
Gmail / 163 — activate when credentials supplied; code signing + notarization
(needs paid Developer ID); universal / arm64+x64 packaging + cron next-fire
computation; custom Routine builder (step editing) — M5.

**Milestone 5 — memory, meeting prep, work summary, routine builder,
evaluation** ✅ complete

Verified: **Memory Service** (§16) — agent proposals land `confirmed:false`
and require user confirmation; a `validateMemoryContent` guard rejects
secrets/tokens, full email bodies (injection carrier), and forbidden inferred
traits before persistence; only confirmed items are searchable; items are
inspectable + deletable from a Memory page;
**Meeting Prep** (§13.3) — a `calendar_before` trigger (`minutesBefore`)
fires the scheduler's `fireCalendarBefore`, which picks the target event and
passes `targetEventId` into `run.inputs` so the agent step is deterministic
(not "next event"); idempotency key `calbefore:<rid>:<eventId>:<date>`;
**Daily Work Summary** (§13.4) — built ONLY from handled data (processed
emails, tasks created/completed, meetings attended, waiting items, tomorrow
highlights); NO productivity/slacking inference (regression test guards the
vocabulary); **custom Routine builder** (§14) — a constrained catalog of 8
validated step templates (no arbitrary code); `engine.createRoutine`
defense-in-depth validates every tool name against the registry and every
agent action against a `KNOWN_AGENT_ACTIONS` allow-list; preset ids are
protected (renderer hides Delete; engine refuses overwrite); delete refused
during in-flight runs; **evaluation** (§19) — 62-case dataset across the 7
required categories with spec-correct expected outputs (so genuine Bad Cases
surface), one optimization iteration (51→62, 11 Bad Cases resolved —
injection marker anchor, `please confirm` body cue, tightened `isFollowUp`,
new `isActionableEmail`), baseline + regression + latency/cost + Bad-Cases
artifacts; all 7 release gates pass; **demo** (§22) — an automated e2e spec
runs the 10-step critical flow 3 consecutive times (fresh isolated app each)
satisfying the "critical demo passes three consecutive times" gate, plus a
manual `demo-script.md`; typecheck + lint + 124 tests + build + 6 e2e
tests all pass.

Key decisions in `docs/decisions/0006-m5-memory-prep-summary-builder-eval.md`:
- `PublishableBrief` shared structural subset (title/summary/reason/priority/
  sourceRefs/suggestedActions) — MorningBrief/MeetingPrep/WorkSummary all
  extend it, so `need_to_know fromKey` publishes any agent brief with no
  per-brief branches;
- Meeting Prep determinism: scheduler picks the event → `targetEventId`
  input → `calendar.get({eventId:'{{targetEventId}}'}})` step; agent receives
  one event, not a "find next" prompt; `enforceTrust` strips suggestedActions
  referencing untrusted threads;
- Work Summary counts facts only; no focus/slacking score (§13.4 forbids it);
- Routine builder: users compose pre-validated step templates, never write
  code/tool names; engine re-validates tool names + agent actions
  defense-in-depth (§14 "users cannot insert arbitrary code");
- evaluation dataset carries spec-correct expected outputs (not
  stub-mirroring), so the optimization iteration surfaces real stub bugs;
  approval category is dataset-manifest entries gated by
  `approval-flow.test.ts` (re-running the full pause→approve→execute flow per
  case would be redundant);
- Memory persistence added to the existing `RoutineStore` interface
  (`InMemoryStore` for tests, `SqliteStore` for prod) — same store/engine
  split as M1, no new store module.

**Deferred (out of this pass):** full conversational Assistant
(model-callable tool surface + stop action) — carried from M3/M4, not in
spec §21 M5; real Feishu / Gmail / 163 — activate when credentials supplied
(skeletons exist; credential-free mock path is the default); real video demo
recording — documented manual step (`demo-script.md`); the automated 3× e2e
is the release gate; code signing + notarization — needs a paid Apple
Developer ID.

**Next: post-MVP — real provider activation (on credentials), the full
conversational Assistant, code signing/notarization, universal packaging.**

## Post-MVP — real provider activation

**Gmail (Spec §9)** ✅ real-activated.

Verified: real OAuth 2.0 desktop/installed-app flow on a loopback callback
(OS-assigned port, CSRF `state`, `prompt:consent` → refresh token) → tokens +
client creds in `SecretStore` (Keychain), never in source/settings/log/renderer;
real `messages.list/get` + `drafts.create/send` over hand-rolled REST (no
`googleapis` dep) with safe MIME extraction (text/plain preferred, HTML
stripped, never executed §17.12/§17.13); `Test` reads one real message; Draft
Review run → real `email.list` → R3 approval pause → approve → real
`drafts.create` → draft appears in Gmail Drafts; Draft Review now
account-agnostic (`email.list` no accountId → picks `emailProviders[0]`).
typecheck + lint + 152 tests + build all pass.

Key decisions in `docs/decisions/0007-gmail-real-oauth-and-proxy.md`:
- **proxy-aware fetch via DI**: Node's `fetch` (undici) ignores the system
  proxy/VPN → `exchangeCode` timed out behind a proxy even when the browser
  consent succeeded. The Gmail provider + OAuth module take an injectable
  `GmailFetch`; `container` passes Electron's `net.fetch` (Chromium network
  stack → respects system proxy) in prod, Node global `fetch` in tests. The
  `GmailFetch` type is `string`-input-only so both satisfy it; defined via
  type queries to avoid bare `RequestInit`/`Response` globals (eslint
  no-undef);
- **mutable `emailProviders` swap**: `refreshEmailProviders()` moves the real
  `GmailProvider` to index 0 on connect (and at boot, so a restart reconnects
  from stored tokens), removes it on disconnect (mocks take over);
- **`seedPresets` re-syncs**: was insert-only (`if (existing) continue`), so a
  template fix to Draft Review (dropping hardcoded `accountId:'mock-gmail-001'`)
  never reached the seeded DB row → the routine kept hitting the mock. Now
  re-syncs the canonical step graph each boot, preserving `enabled`/`trigger`;
- OAuth loopback server awaits `listening` before `.address()` (async) and
  closes via `then(close, close)` not `finally` (finally propagates rejection
  to the chained promise → unhandled).

**Deferred (this pass):** real `sendDraft` (sending a real email — draft write
already proves the path and is approval-gated); real 163 IMAP/SMTP and Feishu
Calendar (next, on credentials); code signing + notarization.

**163 Mail (Spec §9)** ✅ real-activated.

Verified: real IMAP (imap.163.com:993 SSL) + SMTP (smtp.163.com:465 SSL),
authorized by the mailbox's 授权码 (authorization code — not the login
password); email + 授权码 in `SecretStore` (Keychain), never in source/
settings/log/renderer; `connect()` validates by a real IMAP login; `Test`
reads one real message (sample id was a real IMAP UID, not a mock fixture),
proving login + fetch + mailparser MIME extraction; drafts via IMAP APPEND to
the `\\Drafts` special-use mailbox (locale-independent), `sendDraft` SMTP-sends
the exact RFC822 built at create time (content immutability §15); 163 is
domestic → direct TCP, no proxy-aware fetch needed (unlike Gmail). typecheck +
lint + 166 tests + build all pass.

Key decisions in `docs/decisions/0008-mail163-real-imap-smtp.md`:
- `imapflow` + `mailparser` + `nodemailer` (pure-JS, no native build) — 163
  has no REST API, so IMAP/SMTP is the standard path (Spec §9);
- shared `mail-mime.ts` (`buildRfc822Raw` + `normalizeRfc822ViaParser` via
  mailparser `simpleParser`, text/plain preferred, HTML never executed
  §17.12/§17.13);
- `refreshEmailProviders` extended to reconcile BOTH Gmail (index 0) and 163
  (after Gmail) — same mutable-array swap pattern as Gmail;
- fixed two pre-existing **time-of-day-flaky** `daily-work-summary` tests
  (attended meeting seeded at `now − 2h`; `RelativeCalendar.listEvents`
  returns all events — its job is summary logic, not range filtering).

**Deferred (this pass):** real 163 draft-write (IMAP APPEND) + real SMTP send
— implemented and approval-gated (R3), not exercised in the self-test (the
read path proves IMAP login/fetch/parse; the write path shares the same
plumbing); `auto_inbox` still hardcodes `mock-gmail-001`/`mock-163-001`
accountIds — made account-agnostic in the real-Routine-e2e step; real Feishu
Calendar (next, on credentials); code signing + notarization.

## Post-MVP — personal profile + tone-mirrored drafts + topic inbox

The agent's drafts were a canned string and inbox classification was four coarse
buckets. This pass adds a passive personal profile, tone-mirrored drafts, and
topic-based inbox classification. Verified: typecheck + lint + 182 tests (1
skipped) + build + 6 e2e (incl. 3× critical demo) all pass.

Three pieces, all done:

- **Passive personal profile (§16 "town"-style).** Agent outputs carry an
  optional `memoryProposals: { key, value }[]` field. Each routine template
  adds a `memory.save_proposals` tool step (R0, `continueOnError`) after the
  agent step; the tool loops `memoryService.save` per item, each landing
  `confirmed:false` (user confirms on the Memory page). `createAgentRuntime`
  stays pure — proposals are declarative, NOT runtime-injected. `MEMORY_KEYS`
  gained `writing_style` + `persona` (kept `email_tone`).
- **Tone-mirrored drafts (§13.5).** A new `generate_draft_reply` agent action.
  The user's OWN prior replies ride in a separate `priorReplies` input field,
  framed by NEW `frameSentReply` (a `<your_reply>` block, NOT `frameEmail` —
  `frameEmail` calls `isUntrusted`, which would mis-flag a reply quoting an
  injection email). Sent mail is the user's own voice — the opposite of
  §17-untrusted — never enters `collectEmails`/`enforceTrust`. Draft Review is
  restructured: `email.list` → `email.list_sent` (filtered to the inbound
  sender) → `memory.search` → `generate_draft_reply` → `memory.save_proposals`
  → `approval` (`email.create_draft`, `body: '{{draftReply.body}}'`) → `notify`.
  The approval `contentHash` is over resolved args → the LLM body is captured
  immutably (§15). Stub fallback mirrors greeting/sign-off/formality from
  `prior[0]` and proposes a `writing_style` memory.
- **Topic inbox classification + grouped summary.** `EMAIL_TOPICS` =
  `['fees_billing','recruiting','ads','meeting','general']`. `topic` is
  orthogonal to the action bucket; `ads → classification:'ignore'` is a
  cross-dimension rule. The classify output carries `topicCounts` (mirroring
  `counts`) because `resolveTemplate` can't iterate/group. The auto_inbox
  Need-to-Know summary groups by topic. Untrusted mail is forced `topic:'general'`
  computed AFTER the untrusted check.

Key decisions in `docs/decisions/0009-profile-tone-topic.md`:
- **Sent mail framing:** `frameSentReply` is distinct from `frameEmail`; the
  `<your_reply>` block is labeled unconditionally as the user's own past reply
  to mirror. Feeding real sent mail to a third-party LLM is a user-consented
  data flow separate from §17 (injection); the LLM-key opt-in covers it.
- **Declarative proposals, not runtime injection:** the `memory.save_proposals`
  tool step + `{{brief.memoryProposals}}` whole-array token keeps
  `createAgentRuntime` pure (no `MemoryService` injection, no signature change)
  and a rejected proposal (full email body / token / forbidden inferred trait)
  becomes a logged Activity, never fails the run.
- **Topic is a pre-computed output field** (`topicCounts`) because templates
  can't iterate; the summary reads `{{classified.topicCounts.fees_billing}}`
  etc.
- **163 Sent mailbox is locale-dependent:** `findSentMailbox` (`\\Sent`
  special-use + name fallback `['已发送','Sent','Sent Items','发件箱']` via
  `mailboxExists`); Gmail `in:sent` (+`to:` filter). 163 is domestic → direct
  TCP, no proxy-aware fetch.
- **Schema lockstep (6 touchpoints per change):** Zod (`schemas.ts`), TypeBox
  mirror (`structured-output.ts`), TS interface (`agent-runtime.ts`), stub
  producer, system-prompt task string (`prompt-injection.ts`), and the
  `createAgentRuntime` real-path branch. The `memory.save` tool's inline key
  union is a hand-maintained duplicate of `MEMORY_KEYS`.
- **Localization:** wire identifiers (`topic` values, tool names, `MemoryKey`
  values) stay English; only display labels translate. §17 system prompt stays
  English (only a Chinese output directive appended). Classify stub REGEX
  matchers stay English (match the English eval dataset); the eval is
  structural so localizing stub display strings is eval-safe.

**Deferred (out of this pass):** `getThread` full-thread fetch; topic taxonomy
beyond the 4 chosen; auto-proposing per-contact relationship memory (`contact`
key — mechanism supports it, wiring is a follow-up); real Feishu Calendar
activation (pending admin approval).

## Post-MVP — UI localization (zh-CN)

The entire user-visible surface is now Simplified Chinese. Verified:
typecheck + lint + 179 tests (1 skipped) + build + 6 e2e all pass.

Scope split (two layers, both done):
- **Renderer chrome** — every static label across the workbench (nav, page
  titles, buttons, empty/loading/error states, enum→label maps for task status
  / priority / approval / run / integration status, Routine builder catalog)
  and the robot (state labels, quick panel, bubble, context menu, window
  `<title>`). Shared `src/renderer/workbench/src/labels.ts` holds the enum
  → Chinese maps with a `statusLabel(map, value)` fallback.
- **Agent-generated content** — deterministic stub output (Morning Brief /
  Classify / Meeting Prep / Work Summary titles, summaries, reasons,
  suggestedAction labels, draft bodies, questions, objective, context), all
  Routine template `name`/`description`/`title`/`summary`/`message` strings,
  every Activity summary in the engine, tool-registry approval titles +
  summaries, and all service/IPC/provider error messages that surface to the
  renderer. The real-LLM path is Chinese via a directive appended to the
  host-set system prompt.

Key decisions:
- **Wire identifiers stay English.** Enum values (`need_to_know`, `R3`,
  `follow_up`…), tool names (`email.create_draft`), account ids, cron
  expressions, and `WorkbenchPage` nav identifiers are IPC/DB wire data — only
  their *display labels* translate. Translating identifiers would corrupt the
  DB and break the Tool Registry gate.
- **The §17 system prompt stays English.** It is the proven prompt-injection
  security surface (role + DATA/inert framing + per-action task). Only a
  Chinese *output-language* directive is appended; the model follows English
  instructions to produce Chinese user-facing fields. `buildUserMessage` data
  payloads stay English (model-internal, not user-visible).
- **Classify stub REGEX matchers stay English** (`/reply|following up|…/`) —
  they match the English evaluation dataset fixtures. Translating them would
  break the 62-case eval. The eval itself is structural (counts/refs/
  hasAction), not string-based, so localizing stub *display* strings is
  eval-safe.
- **e2e window-title matchers updated**, not the titles: the robot `<title>`
  is now `Daymate 机器人` (HTML overrides the BrowserWindow `title:`), so
  `helpers.ts` matches `t.includes('机器人')` and `boot.spec` asserts the
  Chinese title. BrowserWindow `title:` options left English only because the
  loaded HTML overrides them anyway.
- **§13.4 regression guard** now also forbids Chinese productivity vocabulary
  (`效率|摸鱼|闲置|工作时长`) alongside the English terms.

## Post-MVP — 秋招投递管理集成 P1（BOSS 直聘漏斗）

秋招海投期间，投递渠道分散（BOSS 直聘 + 官网 + 内推 + 线下），状态信息散落
在 BOSS App、邮件、口头沟通中。集成 `jackwener/boss-cli`（本地子进程 + 浏览器
cookies）让 Daymate 成为一个跨渠道投递漏斗秘书。P1 只做**读取 + 本地写入**（零
外部写风险、不经审批、不碰 agent）。设计文档：
`~/Desktop/Daymate-秋招投递管理集成设计.md`。Verified: typecheck + lint + 193
tests (1 skipped) + build all pass.

- **BossProvider 抽象**（`src/main/providers/boss/`）：`BossProvider` 接口 +
  `MockBossProvider`（canned fixtures，无凭证默认）+ `BossCliProvider`
  （promisified `execFile('boss', …, '--json')`，60s 超时，统一 envelope 解析，
  `BossCliError` 带 code）+ `SwappableBossProvider` 委托（镜像
  `SwappableCalendarProvider`，mock↔real 热切换，`refreshBossProvider` 在
  `boss status` 通过时切换）。
- **事件时间线模型**（非线性状态机）：`Application` 有一有序 `ApplicationEvent`
  流；`computeStatus` = 最新事件胜出，但 `offer`/`rejected`/`withdrawn` 终态优先
  （不可"撤销拒信"）。手动事件默认 `locked`（用户真相），boss 检测的事件
  `locked:false`。各公司校招流程不同（测评+笔试 vs 直接约面试），线性状态机会误
  报，事件模型只记录观察、不假设固定阶梯。
- **跨渠道统一漏斗。** `ApplicationSource`（`boss`/`manual`/`web`/`referral`/
  `other`）让非 BOSS 投递与 boss 同步记录共存。boss-cli 无 apply 命令（greet=投递），
  故非 BOSS 渠道只能手动录入。
- **DB schema**：`applications`（`boss_security_id` 唯一索引，boss 同步去重键）+
  `application_events`（`application_id`/`source_ref` 索引，事件幂等键）。8 个
  store 方法横跨 `SqliteStore`/`InMemoryStore`。
- **5 个 R0 只读工具**：`boss.applied`/`boss.interviews`/`boss.chat`/
  `boss.detail`/`boss.search`，全委托 `ctx.bossProvider`。boss 同步按
  `bossSecurityId` upsert 应用、按 `sourceRef` 幂等追加事件；boss-cli 失败 →
  `provider_unavailable` Activity，优雅返回（镜像邮件 provider 宕机处理）。
- **投递渲染页**（`Applications.tsx`）：漏斗按 currentStatus 分组，每卡显示公司/
  职位/来源徽标/投递日期/事件时间线 chips + locked 锁标；"同步 BOSS"/"新增投递"
  （手动录入官网/内推）/"追加进展"内联表单；`onApplicationChanged` 实时推送。

Key decisions in `docs/decisions/0010-秋招投递管理-p1-boss-funnel.md`:
- **事件时间线 > 线性状态机**——记录观察而非假设阶梯；终态优先防覆盖。
- **locked 标志 + P2 精度**——P1 仅 latest-wins + terminal-wins；"自动事件不覆盖
  用户 locked 事件"优先级逻辑留给 P2（邮件推断产生自动事件时才有意义），P1 先存
  标志、先展示，是诚实的非过度设计选择。
- **boss-cli 字段映射以 mock 为准**——`mapJob`/`mapApplication` 用 `pick`/`str`
  helper 尝试多种 key 变体；用户安装真实 boss-cli 后需对照调整（已在代码注释标注）。
- **MockBossProvider 是无凭证默认路径**——与 Gmail/163 mock 同构，面板可端到端跑。

**Deferred (out of this pass):** 邮件→投递状态推断（P2，多策略匹配：域名/公司名
出现在正文/牛客·北森·赛码等第三方平台，此时 locked 优先级才生效）；投递状态推断
Routine builder step 模板（P3）+ agent action（P4）；greet 批量打招呼=投递（P5，
R3 审批）；真实 boss-cli 字段映射对照调整（待用户安装）。

## Post-MVP — 投递模块重构 Milestone A（富数据 + CRUD v2 + 邮件推断 + AI 简历/面经）

用户对 P1 投递模块不满意（数据太薄、缺邮件推断、无 AI 简历/面试准备、面经散落），
给了完整求职管理 spec。经澄清：Boss 接入保留 boss-cli 子进程（不做 MCP 化）；
重构方式演进式（保留事件时间线模型，在其上扩展）；首阶段四块全选——富数据模型 +
CRUD v2 ＋ 邮件→投递状态推断 ＋ AI 简历定制 ＋ AI 面试逐字稿/面经库。设计文档：
`~/Desktop/Daymate-秋招投递管理集成设计.md`；决策：
`docs/decisions/0011-投递模块重构-milestone-a.md`。Verified: typecheck + lint + 251
tests (1 skipped) + build all pass.

- **Schema 富字段 + 3 新表。** `applications` 加 9 列（`city, salary_range, jd_text,
  stage_deadline, interview_link, priority(normal|back), email_ref_id, deleted_at,
  archived_at`，经 `addColumnIfMissing` 注入存量库）。新表 `resume_versions` /
  `prep_materials`（versioned HTML，激活版 = `max(version)`，无 active 布尔）+
  `interview_notes`（面经库，独立不绑单投递，tags JSON）。软删/归档：`listApplications`
  默认 `deleted_at IS NULL AND archived_at IS NULL`；回收站/归档区显式查询；
  `deleted_at` 优先于 `archived_at`。
- **`computeStatus` locked 优先级生效（§17 风险 #3 防线）。** anchor pool = 所有
  locked 事件（无 locked 则全部）；pool 内 latest-wins。即 auto（`locked:false`）
  事件照常记入时间线（影响停滞检测），但**无法把 status 钉离 locked 锚点**。邮件
  推断产生的事件恒 `locked:false`，即便误造 offer 也会被 locked 的 rejected 钉住，
  直到用户手动确认。
- **邮件→投递推断（`syncFromEmails`）。** 对每个 connected email provider `listMessages`
  （unreadOnly, 72h, limit 50）→ 跑 `classify_application_email` agent step →
  **service 内三策略确定性匹配**（发件域平台/公司名+岗位双向子串/`email_ref_id` 直连，
  非模型决定）→ high/medium 追加 `source:'email'` locked:false 事件（`sourceRef:
  'email:<messageId>'` 幂等），low/unmatched 进 in-memory 待确认队列（broadcast →
  `EMAIL_MATCHES_CHANGED` IPC，renderer 弹「邮件待确认」子区 Confirm/Ignore）；
  **untrusted 邮件 → `untrusted:true` + confidence:low + service 跳过**（绝不造事件）。
- **3 新 agent actions（6-touchpoint lockstep ×3）。** `generate_resume` /
  `generate_interview_transcript` / `classify_application_email`（新 action，不扩展
  `classify_inbox`——schema 结构不同）。JD 经新 `frameJd`（`<jd>` 块）进 **user message**
  （绝不进 host-set system prompt）；基础简历经新 `frameTrustedDoc`（trusted，用户自己的，
  不调 `isUntrusted`）；面经经 `<your_notes>` 块（trusted）。输出 HTML 存为数据，renderer
  在 `sandbox=""` iframe 渲染（§17——即使被注入 `<script>` 也被沙箱中和）。`enforceTrust`
  在模型输出后确定性覆盖（untrusted 邮件跳过、strip 引用 JD 的 proposals、`capInput` 限长）。
- **8 新工具 + `ToolContext.applicationService`。** `application.search/create/
  update_field/add_event/get_latest_resume/save_resume/save_prep_material` +
  `interview_notes.search/create`。R0 只读 / R1 本地写（§15 仅 gate 外部写，本地 DB 写不需审批）。
- **事件驱动触发 `application_status`。** 用轮询（60s 共享 poll loop，镜像 `calendar_before`），
  不用 service emit——避免 service→engine→service 循环。`listInterviewStatusApps`
  （interview 状态 + 尚无 prep_materials）→ 每个触发，传 `targetApplicationId` 进 run inputs
  （确定性）；prep 存了即脱离候选列表，天然幂等。
- **`interview_prep` preset（6 步）+ 手动 AI 生成。** preset：`application.search` →
  `interview_notes.search` → `application.get_latest_resume` →
  `generate_interview_transcript` → `application.save_prep_material` → `notify`。手动重新
  生成简历/逐字稿**不经 routine engine**——IPC handler 直接 `runAgentStep` →
  `saveResume/savePrepMaterial`（简历生成是建投递的副作用，单步、无编排需求）。
- **jobSearch config + 维护 cron。** `settings.json`（非密）加 `jobSearch:
  { baseResumePath?, transcriptTemplatePath? }`；`readBaseResumeContent` 软降级（缺失返回
  undefined，不抛）。维护（purge 30d 软删行 / auto-archive 30d rejected / demote 14d stale）
  走 **daily cron `0 3 * * *`**（非 60s poll——30d 窗口用秒级轮询是浪费），是内部
  housekeeping job，**非用户可见 Routine**，routines 被 pause 时仍运行。
- **Renderer。** 投递详情页（`ApplicationDetail`，富字段只读 + 简历/逐字稿 sandboxed iframe
  预览 + 重新生成 + 事件时间线带 locked/source 标签 + 软删）；面经库页（`InterviewNotes`，
  列表 + debounced 搜索 + 5-tag 多选创建）；投递页重写为 6-bucket 智能漏斗（紧急→进行中→
  停滞→已录用→已结束→已归档，client-side 分组镜像后端 `smartSortedViews`）；邮件待确认队列 +
  回收站（恢复/永久删除）；`labels.ts` 加 `APPLICATION_PRIORITY_LABEL` +
  `INTERVIEW_NOTE_TAG_LABEL` + `SMART_FUNNEL_GROUP_LABEL`。

Key decisions in `docs/decisions/0011-投递模块重构-milestone-a.md`:
- **事件时间线 > 线性状态机**——延续 `0010`；终态优先 + locked 优先防覆盖。
- **locked 优先级是 §17 防线，非"高级功能"**——P1 存了标志未生效；本里程碑让 auto 事件无法
  钉离 locked 锚点，邮件推断的误造事件才真正无害。
- **匹配是 service 确定性逻辑，非模型**——模型只分类+提取；service 用三策略决定 high/
  medium/low + 是否进队列。避免模型"自信地"绑错投递。
- **待确认队列 in-memory + broadcast**——`Map<messageId, EmailMatchProposal>` +
  `setEmailMatchesListener` → container `broadcastEmailMatches` → IPC。轻量，无新表；
  进程重启队列清空（下次 sync 重建，可接受）。
- **application_status 用轮询不用 service emit**——避免循环依赖；镜像 `calendar_before`。
- **手动 AI 生成不经 routine engine**——简历生成是建投递的副作用，单步、无编排。
- **激活版 = max(version)，无 active 布尔**——避免 active-flag 与 max(version) 双真相。
- **daily cron 不进 60s poll，非 user-visible Routine**——30d/14d 窗口秒级轮询是浪费。
- **`classify_application_email` 是新 action 不是 `classify_inbox` 扩展**——schema 结构不同。
- **`JobSearchSettings` 放 `src/shared/types.ts`**——DaymateApi 需要；避免主进程→shared 反向依赖。
- **InterviewNoteTag 'fundamentals'（非 'theory'）**——shared 常量是 `fundamentals`，labels 对齐。

**Deferred (out of this pass):** 投递详情页内联富字段编辑 IPC（无 `updateApplication` 整体
IPC，富字段只读展示，内联编辑为 follow-up）；邮件推断第三方平台域名清单（牛客/北森/赛码）为
初版，按实际邮件补充；面经外导入（论坛爬取）→ untrusted 包装；配置页 chrome（本里程碑只做
最小文件路径，精致配置页 → Milestone D）；真实 boss-cli 字段映射对照调整（待用户安装，延续
`0010`）。Roadmap: **B** Dashboard + 复盘统计；**C** 每日岗位抓取 + 推荐评分；**D** 通知升级 +
配置页 + 数据导出 ZIP；**E** 运势/八字每日贴士 + polish。

## Post-MVP — 投递复盘看板（Milestone B：投递页内 复盘 + AI 复盘建议）

Milestone A 的投递模块只有逐条漏斗卡片，缺聚合视图。本里程碑在**投递页内**加一个可折叠
「复盘」子区（不新增 nav）：KPI 磁贴 + 漏斗转化条 + 来源 SVG donut + AI 复盘面板。
Verified: typecheck + lint + 260 tests (1 skipped) + build + 6 e2e（含 3× critical demo）全绿。

四块，全做：

- **`stats()` 服务方法（确定性，无 LLM）。** `ApplicationFunnelStats` =
  total/active/terminal{offer,rejected,withdrawn}/byStatus/bySource/byFunnelGroup/
  reachedStage（累计到达过某阶段）/conversion（4 阶段 % vs applied）/stale/urgent/
  avgDaysSinceLastEvent/avgDaysInProcess。`stats()` reduce `this.list()` +
  `this.smartSortedViews()`（内存内，镜像 `runMaintenance()` counts-returning 先例）。
  **不改 store**（数据量级几十到几百条，内存 reduce 足够；ADR 0002 store 保持纯 CRUD）。
- **IPC：2 channel。** `APPLICATION_STATS`（只读 pull，复用 `onApplicationChanged` 触发
  renderer refetch，不开新 push channel）+ `APPLICATION_GENERATE_FUNNEL_REVIEW`（手动 AI，
  不经 routine engine，镜像 `generateResume`/`generatePrepMaterial`）。
- **新 agent action `generate_funnel_review`（6-touchpoint lockstep）。** 输入 `FunnelReviewInput`
  = stats + 精简 per-app 投影（company/position/currentStatus/daysSinceLastEvent/priority/
  source —— **不含 jd_text/邮件正文/events.evidence**）；输出 `FunnelReviewOutput` =
  `PublishableBrief` 形状 + `highlights[]` + `riskApps[{company,position?,issue}]` +
  `memoryProposals?`。§17：`<funnel_data>` DATA 块进 **user message**（company/position 是
  boss/email 短字段值，当 untrusted，绝不进 host-set system prompt）；`enforceTrust` 在输出后
  确定性覆盖（strip 带 forbidden toolName 的 suggestedActions —— `email.create_draft`/
  `email.send`/`boss.greet`/`boss.apply`，描述性 label 存活）；`capInput` 限长。§13.4：纯描述、
  不打效率分（回归测试守 `效率|摸鱼|闲置|工作时长|productivity|slacking` 词汇）。stub：
  riskApps = stale（≥14d 非终态，前 6），priority = urgent>0||stale>0?'high':'medium'。
- **Renderer `<ReviewSection />`（collapsible，投递页内）。** KPI 磁贴行（divs，语义色）+
  漏斗转化条（divs + width%）+ 来源 SVG donut（stroke-dasharray 分段 + rotate -90°，手写无新依赖）+
  AI 复盘面板（`useAsync`+`getApplicationStats()`；「生成复盘」→ `generateFunnelReview()` →
  展示 title/summary/reason/highlights/riskApps/suggestedActions 纯描述文本无跟进按钮；
  `onApplicationChanged`→refetch stats + drop stale 复盘）。

Key decisions in `docs/decisions/0012-投递复盘看板-milestone-b.md`:
- **复盘放投递页内不新增 nav** —— 用户要 Dashboard 效果但不要新导航项；可折叠 section 镜像
  `EmailQueueSection`/`RecycleBinSection` pattern。
- **手写 SVG/div 不引 recharts** —— §23 rule 2；donut 用 stroke-dasharray，漏斗条用 div width%。
- **stats() 不改 store** —— 内存 reduce；ADR 0002 store 保持纯 CRUD。
- **手动 AI 不经 routine engine，不持久化 memoryProposals** —— 镜像 resume/prep 先例
  （"declarative proposals, not runtime injection"）；复盘是 on-demand 快照不持久化。
- **generate_funnel_review 是新 action 非 work_summary 扩展** —— 输出结构不同
  （highlights/riskApps vs processedEmails/tasksCreated）；沿用 6-touchpoint lockstep。
- **prompt 与 enforceTrust 对齐** —— buildSystemPrompt 告知模型「never set toolName」
  （本里程碑无外部写），enforceTrust 兜底 strip 任何 write/send toolName。

**Deferred (out of this pass):** 复盘文本持久化 + daily `funnel_review` routine 发 NTK
（`need_to_know fromKey`）；AI 复盘 suggestedActions 的「一键跟进」按钮（跟进发送 = R3 审批 +
`follow_up_suggest` routine，属 Roadmap D）；donut/漏斗条 tooltip 交互（recharts 级 → 延后）；
复盘历史趋势（需 stats 快照持久化 + 时序存储）。Roadmap: **C** 每日岗位抓取 + 推荐评分；
**D** 通知升级 + 配置页 + 数据导出 ZIP；**E** 运势/八字每日贴士 + polish。

## Post-MVP — 岗位推荐（Milestone C：每日岗位抓取 + 推荐评分 + 一键转投递）

投递模块此前只覆盖**已投递**记录；投递**之前**的「今天有哪些岗位值得投」仍要用户自己去 BOSS
搜。本里程碑在投递页内加可折叠「岗位推荐」子区（不新增 nav，镜像复盘 section）：结构化
`jobIntent` 配置 + 元数据评分 + 每日 cron routine + 手动「抓取」按钮 + 「一键转投递」。
Verified: typecheck + lint + 269 tests (1 skipped) + build + 6 e2e（含 3× critical demo）全绿。

四块，全做：

- **`jobIntent` 配置 + `JobMatch` 类型（shared）。** `JobSearchSettings.jobIntent?: JobIntent`
  （keyword/cities/salaryMin/Max（K）/experience/degree）。`JobMatchResult`（securityId/jobName/
  company/score 0-100/tier high≥70|medium≥50|low≥30|skip/reasons/recommend/salary/city）、
  `JobMatchOutput`（extends PublishableBrief + `results`，可经 `need_to_know fromKey` 发 NTK）。
  BossJob 无 JD 文本（boss-cli 映射限制），故评分是元数据维度。
- **`settings?` 进 `ToolContext` + 新 R0 工具 `job_search.get_intent`。** routine step graph 需
  jobIntent（来自 settings.json），但调度器不为 `schedule` 触发器注入 run inputs。把只读
  `settings?: Settings` 加进 `ToolContext`（tool-registry.ts）+ `EngineDeps` + `buildContext`
  （engine.ts）+ container 接线。`settings?` 可选——既有 8 个集成测试的最小 EngineDeps 字面量
  无需改动即编译。新 R0 工具 `job_search.get_intent` 读 `ctx.settings.readJobSearch().jobIntent`，
  作为 `{{intent}}` 暴露给模板；无 settings → null（routine 优雅降级）。
- **`score_job_matches` agent action（6-touchpoint lockstep）。** 输入 `JobMatchInput`
  （intent + jobs）；`<job_data>` DATA 块进 **user message**（company/position/jobName/salary 是 boss
  短结构化字段值，当 untrusted，绝不进 host-set system prompt §17）。确定性 stub：`salaryK` 解析
  BossJob.salary，四维评分（薪资重叠/城市子串/经验 loose/学历），tier 分桶 + recommend-first 排序。
  `enforceTrust` strip 带 forbidden toolName 的 suggestedActions（转投递是 renderer-side 本地写，
  非 agent 工具）。§13.4 词汇守卫。
- **`fetchJobRecommendations` + `convertJobToApplication` service + IPC。** 手动「抓取」不经 routine
  engine（镜像 `generateFunnelReview`）：IPC handler 读 jobIntent（服务端）→ bossProvider.searchJobs
  → 缓存 jobs by securityId → `runAgentStep('score_job_matches')`。boss-cli 失败 →
  `provider_unavailable` + 空结果。「一键转投递」：`convertJobToApplication(securityId)` **幂等**
  （bossSecurityId 已有则返回现有 view），创建 `source:'boss'` + bossSecurityId 的 Application +
  `locked:true` applied 事件（sourceRef `boss:applied:<sid>` 与 boss 同步 seed 一致 → 未来同步幂等
  跳过）。本地 DB 写（R1，无需审批 §15 仅 gate 外部写）。2 个 IPC channel（5 文件 wiring）。
- **`job_recommendation` routine preset（每日 cron）。** `job_search.get_intent` → `boss.search` →
  `score_job_matches` → `need_to_know fromKey` → `notify`。trigger `schedule` cron `3 8 * * *`
  （08:03，避开舰队碰撞 :00）。**默认 `enabled: false`**——需用户先配置 jobIntent，opt-in。加入
  `PRESETS` + `PRESET_ROUTINE_IDS` + `KNOWN_AGENT_ACTIONS`（顺手补 `generate_funnel_review`）。
- **Renderer `<JobRecommendationSection />`。** 可折叠 header（显示意向 keyword/cities）+ 内联
  jobIntent 配置表单（getJobSearchConfig/setJobSearchConfig）+「抓取岗位」按钮 → 评分列表
  （company/position/salary/tier/score/reasons）+ 每条「转投递」按钮。useAsync + loading/error/empty
  triad；`JOB_TIER_LABEL`/`JOB_TIER_COLOR` 加 labels.ts。

Key decisions in `docs/decisions/0013-岗位推荐-milestone-c.md`:
- **`settings?` 进 ToolContext（可选）而非调度器特殊注入**——调度器只为
  `calendar_before`/`application_status` 注入 run inputs；给 `schedule` routine 注入 id-specific
  inputs 是丑陋的 id 分支。只读 `settings` + `job_search.get_intent` R0 工具是通用、可复用、镜像
  `memory.search`/`application.search` 从 ctx 读 service 的先例。`settings?` 可选让既有 8 个集成测试
  的最小 EngineDeps 字面量无需改动即编译。
- **routine preset 而非隐藏调度器 cron**——Daymate 的主动调度工作（morning_brief/auto_inbox/
  daily_work_summary）全是 preset；preset 给 Activity 历史 + 次运行可见性 + Routines 页条目，与架构
  一致。隐藏 cron 是 housekeeping，非用户可见 proactive 工作。
- **默认 `enabled: false`（opt-in）**——job_recommendation 需先配置 jobIntent；默认禁用避免每日空
  NTK 噪音。手动「抓取」按钮不依赖 routine 启用状态。
- **转投递 `locked:true` + sourceRef `boss:applied:<sid>`**——用户决定投递=用户真相（locked）；
  sourceRef 与 boss 同步 seed 一致 → 未来同步按 sourceRef 幂等跳过，不重复创建。
- **评分 stub 元数据维度，无 JD 文本**——BossJob 无 JD 文本（boss-cli 映射限制）；四维评分是诚实的
  非过度设计；真实 LLM 路径做同样任务（输出工具 + Zod + enforceTrust）。
- **6-touchpoint lockstep 一致**——score_job_matches 是新 action 非 funnel_review 扩展
  （输出结构 results vs highlights/riskApps）；沿用既有 lockstep 无新机制。

**Deferred (out of this pass):** 真实 boss-cli 字段映射对照调整（延续 0010/0011，待用户安装）；
jobIntent 富字段（行业/规模/技术栈偏好/排除公司清单）；评分加权可配置（当前权重硬编码）；转投递后
「去 BOSS 打招呼」R3 审批流程（greet=投递属 Roadmap D / 原 spec P5）；岗位推荐历史趋势
（需 brief 持久化时序存储，同 Milestone B 复盘历史延后）。Roadmap: **D** 通知升级 + 配置页 + 数据
导出 ZIP；**E** 运势/八字每日贴士 + polish。

## Post-MVP — 通知升级 + 配置页 + 数据导出 ZIP（Milestone D）

Roadmap D 三块全做（用户确认「全部三块」）：macOS 原生通知 + 免打扰 + 按例程/类别开关 + 聚合；
扩展现有「集成」页为「集成与设置」（不新增 nav）；投递模块数据导出 ZIP。Verified: typecheck + lint +
291 tests (1 skipped) + build + 6 e2e（含 3× critical demo）全绿。

三块，全做：

- **通知偏好（非密 settings）+ `NotificationService`（中心化 notify 路径）。**
  `NotificationPrefs`（`nativeEnabled?`/`quietHours?{enabled,start,end}`/`categories?`/`routineOverrides?`）
  在 settings.json（非 SecretStore），`Settings` 加 `readNotifications()`/`writeNotifications()` +
  `normalizeNotifications()`（坏时间/非布尔丢弃）。`NotificationService.notify(input)` 同步（prefs 缓存，
  `refreshPrefs()` boot + 写后刷新）经四道闸：① 类别/例程开关（`routineOverrides[routineId]` 胜过
  `categories[category]`，`false` 完全静音）② 聚合（同 `category+message` 30s 折叠防刷屏）③ 机器人气泡
  （in-app 非侵入，免打扰仍推）④ 原生弹窗（`nativeEnabled` 且不在免打扰时 fire 注入的 notifier）。
  `pushBubble`/`notifier`/`now` 注入（测试不需 Electron）——镜像 GmailFetch DI。
- **`notifyRich` 可选进 `EngineDeps`**——`execNotifyStep` 优先用 `notifyRich({message,routineId,category:'routine'})`
  （带例程 id + 类别让 prefs 生效），否则 fallback `ctx.notify`（既有 8 个集成测试字面量无需改即编译）。
  容器：构造 `NotificationService`（boot `refreshPrefs` fire-and-forget）+ `notifyRich` 闭包 +
  把审批气泡（`activityService.subscribe` 的 `approval_requested`）从直推 `pushRobotNotify` 改走
  `notificationService.notify({category:'approval',navigateTo:'Approvals'})`——审批也有自己的开关 + 免打扰。
- **手写 ZIP writer（STORED，无新依赖）+ 投递导出。** `src/main/util/zip-writer.ts` 最小 STORED-only
  ZIP（local header + 中央目录 + EOCD + CRC32 表），§23 rule 2 不引依赖（镜像 Milestone B 手写 SVG、
  Gmail 手写 REST 文化）。`ApplicationService.exportApplicationsZip(): Uint8Array` 纯 + 框架无关
  （无 Electron import，可单测）：`listApplications` + `listDeletedApplications` + `listArchivedApplications`
  （全量 active + 软删 + 归档）→ 每条 events/resumes/preps + `listInterviewNotes` → 每表一 JSON dump +
  README.txt → `writeZip()`。IPC `APPLICATION_EXPORT_ZIP`：`dialog.showSaveDialog` → `writeFile` → 返回路径
  或 null（取消）。本地写 R1 无需审批。3 个 IPC channel，5 文件 wiring。
- **Renderer：扩展「集成」页为「集成与设置」。** 保留 Gmail/163/Feishu/LLM 卡片；新增 3 section
  （不新增 nav）：`JobSearchCard`（基础简历路径 + 逐字稿模板 + jobIntent，复用 `getJobSearchConfig`/
  `setJobSearchConfig`，与投递页内联编辑器读写同一 settings 双向同步）、`NotificationPrefsCard`
  （系统总开关 + 免打扰时段 + 3 类别开关）、`DataExportCard`（导出按钮）。`App.tsx` `PAGE_LABELS['Integrations']`→「集成与设置」。

Key decisions in `docs/decisions/0014-通知升级-配置页-导出-milestone-d.md`:
- **`notifyRich` 可选 + engine fallback**——不破坏既有 `notify` 契约；可选 `notifyRich` 让容器注入
  NotificationService，engine 优先用它带 routineId/category，否则 fallback 旧路径。镜像 `settings?` 先例。
- **免打扰只抑制原生弹窗，不抑制机器人气泡**——机器人气泡是应用内非侵入表面；免打扰语义是
  「不打扰 OS」非「隐藏应用内提示」；per-category/per-routine `false` 才完全静音（含气泡）。语义清晰。
- **聚合 30s 折叠同一 category+message**——机器人气泡一次一条，连发会闪烁；折叠突发防刷屏；不同消息不折叠（信息不丢）。
- **手写 ZIP STORED-only 无新依赖**——§23 rule 2；数据量级小压缩收益小；STORED 通用兼容；自验证（结构 round-trip + 系统 unzip 列名）。
- **导出 service 纯 + 框架无关**——返回 Uint8Array，dialog/writeFile 在 IPC handler，可单测；镜像 `stats()` 纯 reduce。
- **审批气泡走 NotificationService**——`approval_requested` 从直推改走 `notificationService.notify({category:'approval'})`，统一所有 notify 路径。

**Deferred (out of this pass):** 每例程细粒度开关 UI（后端 `routineOverrides` 已支持任意 routineId，
配置页只暴露类别开关 + 总开关 + 免打扰）；导出含非投递模块（任务/NTK/记忆/例程配置——用户选「仅投递模块」）；
ZIP 压缩（STORED-only；DEFLATE follow-up）；导入（解 zip → upsert 投递，需幂等 + 冲突策略）；
通知排队/错过回放（免打扰期间抑制的原生弹窗不排队，机器人气泡保留可见性）。Roadmap: **E** 运势/八字每日贴士 + polish。

## Post-MVP — 运势/八字每日贴士 + polish（Milestone E）

Roadmap E：加一个轻量、非任务、纯氛围的「每日运势」贴士 + 两项 polish。用户经
AskUserQuestion 确认：运势=八字每日运势（LLM 个性化，新 `generate_daily_fortune`
agent action）；生辰存非密 settings.json；展示=机器人每日气泡（NOT NTK，NOT
routine preset — 隐藏 cron，用户接受「与主动调度架构不一致」取舍）；polish=投递
详情页内联富字段编辑 + 配置页每例程通知开关 UI。Verified: typecheck + lint + 301
tests (1 skipped) + build + 6 e2e（含 3× critical demo）全绿。

三块，全做：

- **每日运势 agent action（6-touchpoint lockstep + 确定性 stub）。** 新 action
  `generate_daily_fortune`，输出 `DailyFortuneOutput = {title, summary, tip, mood}`
  （**故意 NOT PublishableBrief** — 不发 NTK、不持久化）。§17：生辰是用户自己的
  可信配置（像基础简历），`<birth_data>` DATA 块进 **user message**（绝不进
  host-set system prompt）；`enforceTrust` clamp mood 到 [0,100]（§12 兜底，Zod
  已先约束）。§13.4：`mood`（0-100）是装饰性氛围数字，**绝非效率/摸鱼分**（stub +
  prompt + 回归测试三方守 `效率|摸鱼|闲置|工作时长|productivity|slacking`）。
  确定性 stub：`hashSeed(date+birth)` 无 Math.random → 同日同生辰同运势；生肖从
  生辰年派生；无生辰退通用版。
- **生辰 IPC + 每日 cron + 机器人气泡。** `BIRTH_DATA_GET/SET/CLEAR` IPC（非密
  settings.json，`normalizeBirthData` 越界整块丢弃）；每日隐藏 cron `17 8 * * *`
  （08:17 避开舰队 :00）放 **container**（容器已有 `agentRuntime`+`settings`+
  `notificationService`，不污染 scheduler 构造函数加 3 个新 deps）→ 读生辰 →
  `runAgentStep` → `notificationService.notify({category:'fortune'})`。新
  `'fortune'` NotificationCategory（四道闸生效，可在配置页关掉）。`BirthDataCard`
  配置卡（生辰输入 + 生肖预览 + 保存/清除）让运势可配置。
- **polish 1 — 投递详情页内联富字段编辑。** `APPLICATION_UPDATE_FIELDS` IPC +
  `DaymateApi.updateApplicationFields`（直调既有 `applicationService.updateFields`
  + `broadcastApplications`）；`ApplicationDetail.RichFields` 从只读 `<dl>` 重写为
  内联编辑表单（input/select/textarea），「保存」只写**变了**的字段（minimal patch，
  R1 本地 DB 写无需审批 §15）；`onApplicationChanged` → refetch。§17：JD 编辑只是存
  本地，JD 喂 agent 时仍经既有 `frameJd` 路径，不引入新注入面。
- **polish 2 — 配置页每例程通知开关 UI。** 后端 `routineOverrides` 早支持（Milestone
  D `categoryEnabled` 先查 routineOverrides），E3 只补 `RoutineNotifyToggles` 子区：
  `listRoutines` 列全部例程 + 每例程 toggle 写 `routineOverrides[id]`（`false` = 完全
  静音该例程）。零后端改动。

Key decisions in `docs/decisions/0015-运势每日贴士-milestone-e.md`:
- **运势是隐藏 cron 非 routine preset**——用户选「机器人每日气泡」=最轻表面；Daymate
  的主动调度工作全是 preset（给 Activity 历史 + Routines 页条目），运势是氛围贴士不是
  主动调度工作，隐藏 cron（镜像 maintenance cron）是诚实的非过度设计。代价：Routines
  页无运势条目、Activity 无运势历史——用户已接受。
- **生辰非密 settings.json**——生辰不是凭证（不像 LLM key/OAuth token），与 jobIntent/
  notificationPrefs 同类。`normalizeBirthData` 越界丢弃，坏生辰退回通用运势不抛错。
- **`DailyFortuneOutput` 故意 NOT PublishableBrief**——运势不发 NTK、不持久化、不复盘；
  是 on-demand 快照（每日重新生成）。持久化运势历史 → 后续。
- **mood 装饰非效率分**——§2/§13.4 明禁；mood 0-100 是日运氛围数字，stub + prompt +
  回归测试三方守。`enforceTrust` clamp 是 §12 兜底（Zod 已先约束，clamp 当前两路径
  不可达越界值，是防御纵深）。
- **cron 放 container 非 scheduler**——容器已有全部 deps；放 scheduler 要加 3 个构造
  参数污染其职责（它管 Routine 调度，运势不是 Routine）。
- **内联编辑 minimal patch**——只写变了的字段，避免空表单值覆盖 boss 同步刚写入的字段。

**Deferred (out of this pass):** 运势历史持久化 + 趋势（需时序存储，同 Milestone B
复盘历史延后）；真实八字四柱推算（full BaZi pillar — 当前仅生肖 + stub，真实 LLM
路径做同样任务，full 四柱是过度设计）；运势发 NTK / routine preset 化（若日后要进
Activity 历史）；导入 ZIP（延续 Milestone D deferred）；真实 boss-cli 字段映射对照
调整（延续 0010/0011/0013，待用户安装）；per-routine 免打扰细粒度 UI（后端已支持任意
routineId，UI 只暴露开关）。

## Post-MVP — Universal packaging + cron next-fire（Milestone F）

M4 延后的两件打包/调度可见性收尾。用户在 Milestone E 后经评估**主动跳过对话式
Assistant**（用户曾质问「这个产品真的需要对话式窗口吗」：Daymate 是**主动式** agent
—Routines 主动调度 + 审批闸，不是被动 chatbot；对话面板扩大 §17 注入面、审批闸让
chat 失去即时性、spec §1046 暗示命令栏非 chat），选了 universal packaging（含 cron
next-fire）。Verified: typecheck + lint + 324 tests (1 skipped) + build + universal
`pnpm dist`（`lipo` 验证真 universal）+ 6 e2e（含 3× critical demo）全绿。

两块，全做：

- **F1 — Universal（arm64+x64）打包。** `electron-builder.yml` 两 target（dir + dmg）
  都带 `arch: [universal]`。electron-builder 分别打包 arm64 + x64 临时 .app →
  `@electron/rebuild` 为每 arch 重建 better-sqlite3 → lipo 合并成
  `dist/mac-universal/Daymate.app` + `Daymate-0.0.1-universal.dmg`（189 MB，unsigned）。
  **关键阻塞 + 修复**：better-sqlite3 有 arm64 N-API prebuilt（electron 33 arm64 直
  接加载无需源码编译），但**无 electron 33 x64 prebuilt** → x64 走 node-gyp 9.x →
  `from distutils.version import StrictVersion` → **Python 3.14（macOS 26）已移除
  distutils** → `ModuleNotFoundError`。修复 = `pip3 install setuptools`（恢复
  `_distutils_hack` shim）——环境层非代码层，标准安全可逆。实跑 `pnpm dist` exit 0，
  `lipo -archs` 验证：`Daymate` 二进制 + `better_sqlite3.node` 原生模块 + `Electron
  Framework` 三者均 `x86_64 arm64`（原生模块双 arch 合并是 setuptools 修复的直接证据）。
  build 慢在 8 分钟下载 electron x64 二进制（retry 1 次），非原生编译——两 arch 的
  @electron/rebuild 都几秒内 finished。
- **F2 — Cron next-fire 计算（手写，无新依赖）。** `src/shared/cron.ts` 手写 5-field
  cron next-fire（§23 rule 2，~150 行，项目手写文化：ZIP/SVG/REST）。字段语法全覆盖
  （`*`/`*/N`/`N`/`N-M`/`N-M/S`/`N/S`/逗号列表）；dom/dow OR-rule（Vixie cron：两字段
  都 restricted→OR；单 restricted→必须匹配）；dow 归一（7→0 Sunday）；按日推进（月不
  匹配跳下月 1 号，`setDate(1)` 在 `setMonth` 前防 Jan 31→Mar 3 滚动）；严格大于 `from`；
  4 年 look-ahead（1461 天，日级 ≤1461 次迭代廉价，覆盖常见 Feb-29 四年一遇，8 年世纪
  缺口回退 null）。放 `src/shared/`（renderer 必须能 import，sandbox 不能 import main；
  双 tsconfig 编译 + vitest `@shared` 别名——文件头标注「NOT an IPC contract」）。
  Routines 页 `nextRun()` 的 `schedule` 分支从硬编码 `'见计划'` 改为
  `nextFireHint(t.cron) ?? \`cron：${t.cron}\``。23 测试覆盖 app 全部 cron + 字段语法 +
  OR-rule 四象限 + 闰年 + malformed。

Key decisions in `docs/decisions/0016-universal-packaging-milestone-f.md`:
- **跳过对话式 Assistant**——Daymate 是主动式 agent（Routines 主动调度 + 审批闸）非
  被动 chatbot；对话面板扩大 §17 注入面、审批闸让 chat 失去即时性、spec §1046 暗示
  命令栏非 chat。优先做能实跑验证的 universal 打包；对话式 Assistant 继续延后。
- **手写 cron next-fire 无新依赖**——§23 rule 2；node-cron 无 next-fire API，加
  cron-parser 违规；dom/dow OR-rule + 闰年算术 bug 高发区用 23 测试覆盖。
- **cron.ts 放 src/shared（非 IPC contract）**——renderer 必须能 import（sandbox 不能
  import main）；shared 是唯一双 tsconfig 编译 + vitest 别名位置；文件头标注 NOT IPC。
- **4 年 look-ahead 非 366 天**——Feb-29 是合法但四年一遇 cron；366 天 cap 误判无 fire；
  4 年覆盖常见情况，世纪缺口回退 null（不声称精度）。
- **setuptools 修复 node-gyp/distutils 是环境层非代码层**——Python 3.14 移除 distutils；
  `pip3 install setuptools` 恢复 shim；记入决策供复现 universal 构建。
- **universal 用 `arch: [universal]` 自动两 arch + lipo**——better-sqlite3 `asarUnpack`
  既有配置正确处理双 arch 原生模块。

**Deferred (out of this pass):** 代码签名 + notarization（需付费 Apple Developer ID；
当前 `identity: null`，Gatekeeper 警告，本地 unsigned app 可开）；对话式 Assistant
（model-callable tool surface + stop action，延续 M3/M4/M5 延后，本里程碑主动跳过）；
真实 Feishu Calendar API（待凭证）；cron `timezone` 字段（`nextCronFire` 只算本地时间）；
8 年世纪缺口的 Feb-29 cron（回退 null 显示原始 cron）；electron-builder 提示移除
devDeps 冗余 @electron/rebuild（纯清理 housekeeping）。

## Post-MVP — 真实 boss-cli 接入 + 字段映射对照（接续 0010 P1 deferred）

用户把 `jackwener/boss-cli` 源码 clone 到 `boss-cli/` 目录，要求取消 mock、真实接入。
`0010` P1 时 `boss` 二进制未装、mappers「以 mock 为准」——CLAUDE.md 在 0010/0011/0013/
C/D/E 反复 deferred「真实 boss-cli 字段映射对照调整（待用户安装）」。本里程碑完成：安装
boss-cli + 对照命令源码修正 mappers + 单测锚定真实形状。Verified: typecheck + lint + 342
tests 全绿；真实 `boss applied`/`interviews`/`chat` envelope 形状与 mappers 匹配。

- **安装 boss-cli（系统层可逆）**：`cd boss-cli && uv tool install .`（入口
  `boss = boss_cli.cli:cli`）+ `uv tool update-shell` 把 `~/.local/bin` 加进 `~/.zshenv`。
  从本地源码装（便于改 boss-cli 后重装）；boss-cli 子目录保持 untracked（独立 git）。
  `BossCliProvider` 的 `BOSS_BIN = DAYMATE_BOSS_BIN ?? 'boss'` 无需改——`boss` 上 PATH 即生效。
- **对照命令源码修正 mappers（4 类 bug）**：读了 `boss_cli/commands/{personal,social,
  search,auth}.py` 的 `_render` 代码确认真实 envelope 形状。① `asArray` 容器键缺失——
  原 `['list','applications','jobs','zpData','results']` 不含真实键 `cardList`/`interviewList`/
  `result`/`friendList`/`jobList` → list 命令把整个 `data` 包成单元素数组、字段全空；补全真实键
  置前 + 空对象守卫（`boss chat` 无沟通返回 `data:{}`，原 wrap 会合成 1 条全空记录，改空对象→`[]`）。
  ② `mapApplication` 嵌套未解——真实 card = `{jobInfo:{…}, brandInfo:{…}, updateTimeDesc}`，原读
  扁平全错；改为解 `jobInfo`/`brandInfo` 嵌套（fallback 到 card，对齐 `card.get(jobInfo, card)`）。
  ③ `mapJob` 缺 `jobExperience`/`jobDegree`（真实 search 用这俩，非 `experienceName`/`degreeName`）；
  新增 `mapJobDetail` 解 `boss detail` 的 `{jobInfo, bossInfo:{name}, brandComInfo:{brandName}}` 嵌套
  （原裸调 `mapJob(data)` 全错）。④ `mapChat` 缺 `name` 键（真实 friend 优先 `name`）。`searchJobs`
  补全 industry/scale/stage/jobType 筛选项。
- **单测锚定真实形状**（`tests/unit/boss-cli-provider.test.ts`）：用从命令源码提炼的真实形状
  fixture 直接调 `map*`/`asArray` 断言——纠正 0010「mock 为准」根因，真实形状从此被测试锁定。
  mappers export（纯数据变换无副作用）。

Key decisions in `docs/decisions/0017-真实boss-cli接入与字段映射对照.md`:
- **gate 在 `credential_present` 而非 `authenticated`**（既有设计，本里程碑验证有效）：`boss status`
  在缺 `__zp_stoken__`（浏览器 JS 生成，QR 登录拿不到）时 `authenticated:false`，但 funnel 读
  API（applied/interviews/chat）只需 4 个 session cookie 即工作。实测用户已有 4 cookie
  （`bst`/`wbg`/`wt2`/`zp_at`）→ `applied`/`interviews`/`chat` 返回正确 envelope（读路径已可用），
  `search` 缺 stoken → `not_authenticated` 错误 envelope → 既有 `provider_unavailable` 降级。
- **从本地源码 `uv tool install .` 而非 PyPI**——用户 clone 了源码，本地装便于改后重装。
- **mappers export 供单测**——纯数据变换无副作用，测真实形状正是其职责。
- **不改 container/scheduler/engine**——`refreshBossProvider` swap 逻辑已正确（`container.ts:311`），
  安装后 boot 时 `boss status` 通过即切 real，未登录留 mock（镜像 Gmail/163 降级）。

**Deferred (out of this pass):** 完整 `boss search`/`recommend`（用户需 `boss logout &&
boss login` 浏览器登录补 `__zp_stoken__` 后 search 才返回真实岗位；funnel 读路径不依赖它）；
真实 `greet`（R3 审批，属原 spec P5 / Roadmap D，本里程碑只做读取真实化）；GUI 启动的 PATH
（`pnpm dev` 终端启动 `boss` 在 PATH；打包 .app 从 Finder 启动时 PATH 可能不含 `~/.local/bin`，
届时用 `DAYMATE_BOSS_BIN` 绝对路径或打包注入 PATH——post-MVP 打包 follow-up）。

**Next: post-MVP 继续 — 真实 provider 激活（待凭证）、full 对话式 Assistant（用户后续
若要）、code signing/notarization（待 Apple Developer ID）；以及用户后续提出的 Roadmap G+。**

## Post-MVP — 岗位推荐双桶重做（校招生实习 + 秋招正职双投）

Milestone C 的「岗位推荐」面向社招，校招生用户六个不满：给社招岗（service 没传
job-type/experience/degree 过滤 → boss 返回混杂社招）、只 15 条无翻页、慢（boss-cli
反爬延迟必需）、低匹配不让投递（转投按钮被 `r.recommend` 闸）、多城市填不上（单文本
框 split）、无实习/校招分栏。本里程碑重做为双桶 + 多城市复选 + 分页 + 限流友好。
Verified: typecheck + lint + 346 tests (1 skipped) + build 全绿。

六块，全做：

- **双桶确定性分桶（§12）。** `JobBucket = 'intern'|'campus'`；实习桶 =
  `boss search --job-type 实习`，秋招正职桶 = `boss search --job-type 全职 --exp 在校/应届`
  （boss-cli `JOB_TYPE_CODES`/`EXP_CODES["在校/应届"]` 已验证）。**bucket 是确定性业务
  规则，agent bucket 无感知** —— `score_job_matches` 的 Zod/TypeBox/stub/prompt 不动
  （6-touchpoint lockstep 不动）；service 按桶发不同 search、一次打分调用、按 securityId
  拆回两桶。`bucket` 字段只存在于 IPC 类型 `JobRecommendations`，不进 agent 输出 schema。
- **`searchJobsPaged` 透传 hasMore。** `BossCliProvider` 新增 `searchJobsPaged` 返回
  `{jobs, hasMore}`（透传 boss envelope `data.hasMore`）；旧 `searchJobs` 保留为 thin
  wrapper（`boss.search` tool / routine preset 不分页，不破坏既有契约）。`BossProvider`
  接口 + `SwappableBossProvider` + `MockBossProvider` 三处加 `searchJobsPaged`。
- **服务层 `fetchJobRecommendations` 双桶 + 多城市 + 分页 + 限流友好。** refresh（无参）
  清缓存抓两桶 page 1；append(`{bucket, append:true}`) 抓该桶下一页并入。`searchOneBucket`
  **顺序**遍历 cities（不并发 —— 反爬实测：连续/并发探测会触发 `__zp_stoken__` 限流
  失效，不可由代码修复）。评分一次（newJobs 合并）→ 按 sidSet 拆回两桶。限流处理：catch
  `BossCliError` code `not_authenticated`/`rate_limited` → 记 `provider_unavailable` +
  设 `error` 字段，**已抓部分仍返回**（镜像 email provider 宕机优雅降级）。
- **Mock 按 `jobType` 分桶。** `MockBossProvider.searchJobsPaged` 按 `query.jobType` 返回
  不同 securityIds 的 fixture（实习 = `元/天` 薪资；校招 = `K` 薪资；无 jobType → 全部
  legacy 路径，既有 preset 测试不受影响）。这是让双桶拆分在测试中可观测的关键 ——
  否则两桶拿相同 sid 会全塌进 intern 桶。`hasMore` 在 match 超 slice 或 page>1 时为真。
- **Renderer `JobRecommendationSection` 全量重写。** 求职意向表单：keyword + **城市复选
  网格**（POPULAR_CITIES top 12 + MORE_CITIES「更多」展开，取自 boss-cli `CITY_CODES`）
  + salaryMin/Max + **学历 select**（DEGREE_OPTIONS）；**移除经验栏**（桶隐含）。标签页
  切换 `[实习 (N)] [秋招正职 (N)]` segmented。岗位卡：tier 徽标 + score + salary/city/reasons，
  **转投递按钮始终显示**（去掉 `r.recommend &&` 闸，低匹配旁注「低匹配」灰字）。每桶
  底「加载更多」按钮（`hasMore` 为真时）。error 态：amber 限流提示条。
- **labels + IPC + 测试。** `JOB_BUCKET_LABEL = { intern:'实习', campus:'秋招正职' }`。
  `fetchJobRecommendations(opts?: {bucket?; append?})` IPC + preload。4 个新 dual-bucket
  service 测试（双桶拆分 sid 不交叉 + 实习 `元/天`/校招 `K`；append 累加桶内无重复；
  `RateLimitBossProvider` 限流 → error 字段 + 部分结果；低匹配可转投 + 二次幂等）。

Key decisions in `docs/decisions/0018-岗位推荐双桶重做-校招生双投.md`:
- **bucket 确定性、agent bucket 无感知** —— 镜像 `0011`「匹配是 service 确定性逻辑非
  模型」；service 分桶，agent 只评分。不动 6-touchpoint lockstep。
- **顺序抓取不并发** —— 反爬实测约束；顺序遍历 cities + 渐进加载是诚实设计，不额外加
  延迟（boss-cli 已内置 jitter/退避）。
- **`searchJobsPaged` 新增而非改 `searchJobs` 返回结构** —— 旧 `searchJobs` 是 thin
  wrapper，preset 路径不分页，不破坏既有契约。
- **转投递不闸 recommend** —— 用户要能投低匹配岗（自己决定）；低匹配旁注提示而非禁用。
- **经验栏移除** —— 桶隐含（校招桶=在校/应届）；避免手填与桶语义冲突。

**Deferred (out of this pass):** preset routine 双桶化（每日 NTK 分别通告实习/校招）——
preset 的 `boss.search` step 仍单桶，是 NTK 通告非双投主入口；评分加权可配置（延续
`0013`）；转投递后「去 BOSS 打招呼」R3 审批（延续 Roadmap D）；真实 boss-cli 字段映射
对照调整（延续 `0010/0011/0013/0017`，待用户安装）；岗位推荐历史趋势（需 brief 持久化
时序存储）。

## Working rules (Spec §23)

1. Implement one milestone at a time. 2. Do not add dependencies without
explaining why. 3. Do not expand scope. 4. Never hardcode credentials or expose
secrets through IPC. 5. Use typed schemas for external and model outputs.
6. Use mock providers before real integrations. 7. Add tests for approval and
idempotency before email sending. 8. Record architecture decisions under
`docs/decisions/`. 9. After each milestone run typecheck, tests and the critical
flow; report changed files, tests, known limitations and next milestone.
