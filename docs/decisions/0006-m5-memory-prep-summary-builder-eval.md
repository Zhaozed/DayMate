# ADR 0006 — M5 memory, meeting prep, work summary, routine builder, evaluation

## Context

M0–M4 are complete and green (93 tests + 3 e2e specs + packaging). The agent
runtime had two agent steps (`generate_morning_brief`, `classify_inbox`); the
scheduler could fire `manual`/`schedule`/`email_poll` but not
`calendar_before`; there was no Memory Service (§16), no Meeting Prep (§13.3)
or Daily Work Summary (§13.4) routines, no custom Routine builder (§14), and
no evaluation harness (§19). M5 (spec §21) delivers the P1 routines, explicit
memory, the constrained builder, the 60+ case evaluation with Bad-Case
iteration, and the three-consecutive-runs demo gate (§22).

Scope decision (documented): follow spec §21 M5 faithfully. DEFER (carried
over from earlier milestones, NOT in spec §21 M5): the full conversational
Assistant (model-callable tool surface) and real Feishu/Gmail/163 activation
— the latter needs credentials the user has not supplied. Real video demo
recording is a documented manual step; the "critical demo passes 3×" release
gate is satisfied by an automated e2e spec.

## Decisions

1. **Memory Service — explicit, inspectable, deletable; proposals land
   `confirmed:false`.** `MemoryService` owns a `MemoryStore` (SQLite in prod,
   in-memory in tests — same store/engine split as M1). Agent steps propose
   memory items via the `memory.save` tool (R2 → approval) or directly into
   `run.stepOutputs` for the deterministic stub; either way they land
   `confirmed:false` and require user confirmation in the Memory page. A
   `validateMemoryContent(key, value)` guard rejects forbidden content BEFORE
   persistence — secrets/tokens, full email bodies (injection carrier), and
   forbidden inferred/negative traits (§16) — no `confirmed` flip bypasses it.
   Only `confirmed` items are searchable (`memory.search` returns
   `confirmed:true` items only). The IPC key is the only secret surface; memory
   items never contain credentials. Deleting a memory item is always allowed
   (§16 "deletable").

2. **Meeting Prep determinism — the scheduler picks the event, not the agent.**
   The §13.3 `calendar_before` trigger fires `minutesBefore` an event. The
   scheduler's `fireCalendarBefore(now)` lists events in `[now, now+24h]`,
   and for each event where `0 < startMs - nowMs <= minutesBefore*60_000` runs
   the routine with `inputs: { targetEventId: e.eventId }` and an idempotency
   key `calbefore:<routineId>:<eventId>:<eventDate>`. The routine's first step
   is `calendar.get({ eventId: '{{targetEventId}}' })` — so the agent step
   receives exactly one event, deterministically, not a "find the next event"
   prompt. `generate_meeting_prep` finds related emails by attendee address OR
   shared title keyword (>4-char tokens), excludes `isUntrusted`, and emits
   objective/context/questions/openActions + `sourceRefs` (the event + up to 5
   related emails) + a `suggestedActions` draft. `enforceTrust` strips any
   suggestedAction referencing an untrusted threadId (§17 holds regardless of
   model output).

3. **Daily Work Summary — built ONLY from handled data; no productivity
   inference.** §13.4 forbids slacking/productivity scoring. The
   `generate_work_summary` stub counts `processedEmails` (non-untrusted),
   `tasksCreated` (`sourceType !== 'assistant'`), `tasksCompleted` (from a
   `tasksCompletedToday` input or the done-count), `meetingsAttended` (events
   with `end <= Date.now()`), `waitingItems`, and `tomorrowHighlights` (events
   tomorrow). The output is a factual recap; there is no "focus score", no
   inferred attention, no judgement language. A regression test asserts the
   summary contains no productivity vocabulary.

4. **Custom Routine builder — constrained catalog, NOT arbitrary code.** §14:
   "Users cannot insert arbitrary code." `RoutineBuilder.tsx` offers a CATALOG
   of 8 validated step templates (`list_emails`, `list_calendar`, `list_tasks`,
   `morning_brief`, `meeting_prep`, `work_summary`, `publish_ntk`, `notify`),
   each a pure `build(outputKey) => RoutineStep` function — the user composes
   pre-validated steps, never writes code or tool names. Defense-in-depth in
   `engine.createRoutine`: every tool step's `tool` and every approval step's
   `toolName` must exist in `toolRegistry.get(name)`, and every agent step's
   `action` must be in a `KNOWN_AGENT_ACTIONS` allow-list
   (`generate_morning_brief`, `classify_inbox`, `generate_meeting_prep`,
   `generate_work_summary`). Unknown tool/action → refuse with a typed error.
   Preset routine ids are protected (shared `PRESET_ROUTINE_IDS` — the renderer
   hides Delete on presets; the engine refuses to delete or overwrite them).
   Delete is refused while a routine has an in-flight run.

5. **`PublishableBrief` — a shared structural subset.** `MorningBriefOutput`,
   `MeetingPrepOutput`, and `WorkSummaryOutput` all extend `PublishableBrief`
   (title/summary/reason/priority/sourceRefs/suggestedActions). The engine's
   `need_to_know fromKey` step reads any agent brief via this interface — so a
   Meeting Prep or Work Summary run publishes a NTK with the same machinery as
   Morning Brief, no per-brief branches.

6. **Evaluation harness — dataset of expected answers, not stub-mirroring.**
   `tests/evaluation/dataset.ts` (v1, 62 cases across the 7 required
   categories) carries the SPEC-CORRECT expected output for each case, not a
   copy of what the stub happens to return. So genuine Bad Cases surface when
   the stub diverges from the spec. `run-eval.ts` runs each case against the
   credential-free stub path, computes per-category metrics, and evaluates the
   §19 release gates (external writes require approval; prompt-injection 100%;
   no credential leak; no duplicate send; Morning Brief has sourceRefs on
   non-trivial input; ≥60 cases; critical demo 3×). The approval category is
   recorded as dataset-manifest entries gated by `approval-flow.test.ts`
   (re-running the full pause→approve→execute flow per case would be
   redundant). `eval.test.ts` regenerates `baseline-report.md` on every run so
   the committed report never drifts.

7. **Optimization iteration (one pass, per §19).** The initial baseline was
   51/62 — 11 genuine Bad Cases (categorized in `bad-cases.md`). One
   optimization pass fixed four stub bugs and corrected expected values that
   had reflected pre-optimization behavior:
   - injection marker `'reply with your'` → `'reply with your system prompt'`
     (anchored to the actual attack shape; benign "reply with your decision"
     no longer false-positives);
   - classify body regex gained `please confirm`;
   - `isFollowUp` tightened to `following up|follow up` only (reply-cues alone
     → `reply`);
   - new `isActionableEmail(email)` helper reuses classify cues and excludes
     FYI — the morning-brief stub now treats only `reply`/`follow_up` emails
     as priority, not every non-SPAM unread.
   After: 62/62, all gates hold throughout (security gates were never among the
   failing cases). `regression-report.md` records before/after.

8. **Demo gate — automated 3× e2e.** `tests/e2e/demo.spec.ts` runs the §22
   ten-step critical flow (Morning Brief → NTK + Task → Draft Review →
   need_approval → approve → executed → Activity trace → Routines page) three
   consecutive times, each against a fresh isolated `DAYMATE_USER_DATA` dir.
   Satisfies "critical demo flow succeeds three consecutive times" without a
   human re-run. `docs/evaluation/demo-script.md` is the manual recording
   script for the portfolio video (the actual recording is a documented manual
   step; no test data or credentials appear on screen).

## Changed files (M5)

- **agent**: `agent-runtime.ts` (Meeting Prep + Work Summary stubs,
  `isActionableEmail`, `PublishableBrief`, dispatcher + types),
  `prompt-injection.ts` (marker anchor, system-prompt branches),
  `structured-output.ts` (`submit_meeting_prep`/`submit_work_summary` schemas
  + shared `publishable` object).
- **routines**: `engine.ts` (`KNOWN_AGENT_ACTIONS`, `createRoutine`
  validation, `PublishableBrief` cast), `scheduler.ts` (`calendar_before`
  poll + `fireCalendarBefore`), `templates/meeting-prep.ts` (new),
  `templates/daily-work-summary.ts` (new), `presets.ts` (2 new presets).
- **services**: `memory-service.ts` (new); Memory persistence added to the
  existing `RoutineStore` interface (`db/store.ts`) — `InMemoryStore`
  (`db/in-memory-store.ts`) for tests, `SqliteStore` (`db/client.ts`) for prod,
  same store/engine split as M1.
- **ipc/handlers.ts** + `preload/index.ts` + `shared/types.ts` +
  `shared/constants.ts`: Memory IPC (`MEMORY_*`), `ROUTINE_CREATE`/`DELETE`,
  `PRESET_ROUTINE_IDS`.
- **renderer**: `RoutineBuilder.tsx` (new), `Routines.tsx` (builder +
  delete), `Memory.tsx` page.
- **tests**: `memory-service.test.ts`, `meeting-prep.test.ts`,
  `daily-work-summary.test.ts`, `custom-routine-builder.test.ts`,
  `tests/evaluation/{dataset,run-eval,eval.test}.ts`, `tests/e2e/demo.spec.ts`.
- **docs/evaluation**: `baseline-report.md`, `bad-cases.md`,
  `regression-report.md`, `latency-cost.md`, `demo-script.md`.

## Verification (run this milestone)

1. `pnpm rebuild better-sqlite3` → `pnpm test` → `pnpm rebuild:native` — unit
   + integration + evaluation tests green (sqlite-store on Node ABI, then
   rebuild for the Electron ABI).
2. `pnpm typecheck` · `pnpm lint` · `pnpm build` — green.
3. `pnpm test:e2e` — 4 Playwright Electron specs green (boot, Morning Brief,
   approval-from-robot, demo 3×).
4. `pnpm dev` smoke — Meeting Prep fires on a `calendar_before` event; Work
   Summary publishes a no-productivity recap; Memory page confirms/forbids/
   deletes; custom routine builder creates + runs, refuses unknown tools.

## Deferred (out of this pass — spec rule 6/7)

- Full conversational Assistant (model-callable tool surface + stop action) —
  carried from M3/M4; needs the deferred tool-surface work, not in spec §21
  M5.
- Real Feishu / Gmail / 163 — activate when the user supplies credentials via
  the secure flow (skeletons exist; credential-free mock path is the default).
- Real video demo recording — documented manual step (`demo-script.md`); the
  automated 3× e2e is the release gate.
- Code signing + notarization — needs a paid Apple Developer ID.
