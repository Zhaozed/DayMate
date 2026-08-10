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

## Working rules (Spec §23)

1. Implement one milestone at a time. 2. Do not add dependencies without
explaining why. 3. Do not expand scope. 4. Never hardcode credentials or expose
secrets through IPC. 5. Use typed schemas for external and model outputs.
6. Use mock providers before real integrations. 7. Add tests for approval and
idempotency before email sending. 8. Record architecture decisions under
`docs/decisions/`. 9. After each milestone run typecheck, tests and the critical
flow; report changed files, tests, known limitations and next milestone.
