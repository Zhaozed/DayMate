# ADR 0005 — M4 robot surface, notifications, packaging, and e2e

## Context

M0–M3 are complete and green (75 tests). The robot window only fetched state
once on mount and click-cycled a hard-coded value; the engine hard-coded
`setRobotState('done')` in `notify` — nothing drove robot state from real
runtime events. The robot had no push subscription, proactive bubble, quick
panel, context menu, or approval reachability. Workbench pages swallowed IPC
errors silently (`catch(() => setX([]))`). `test:e2e` was a no-op echo; there
was no Playwright, no packaging config.

M4 (spec §21 / §18) makes the robot a real ambient surface, polishes the
workbench, adds macOS packaging, and wires a real e2e suite over the
credential-free mock path.

## Decisions

1. **Robot state is owned by a `RobotStateController` driven by Activity
   events.** `ActivityService.subscribe(cb)` is a non-breaking listener;
   `RobotStateController` maps the latest event to a `RobotState`
   (`routine_started`→working, `agent_started`→thinking,
   `approval_requested`→need_approval (sticky), `approval_resolved`→working,
   `routine_completed`→done, failures→error). `done` auto-resets to `idle`
   after ~6s; any newer event cancels the reset; `need_approval` is sticky and
   only cleared by `approval_resolved`. The container wires
   `activityService.subscribe` and replaces the hard-coded `setRobotState('done')`
   — `notify` now only emits the proactive bubble; state is owned by the
   controller. The controller is pure/framework-agnostic (takes `onChange` +
   an injectable timer), so it is unit-tested without Electron.

2. **Push channels as constants + typed bridge methods.** New `IPC` channels
   (`ROBOT_STATE_CHANGED`, `ROBOT_NOTIFY`, `WORKBENCH_NAV`, `OPEN_WORKBENCH_AT`,
   `SET_ROBOT_VIEW`, `ROUTINE_UPDATE`, `ROUTINE_PAUSE_ALL`, `ROUTINE_RESUME_ALL`,
   `APP_QUIT`). Preload exposes `onRobotStateChanged`, `onRobotNotify`,
   `onNavigate`, `openWorkbenchAt`, `setRobotView`, `pauseRoutines`,
   `resumeRoutines`, `quitApp`, `updateRoutine` — all typed on `DaymateApi`.

3. **View-driven window resize around a fixed screen anchor.** The robot
   window is transparent/frameless/always-on-top; the renderer can't resize it
   (sandboxed), so it asks main via `SET_ROBOT_VIEW(view)` where `view` is
   `orb | bubble | panel`. `robot-window.ts` computes per-view geometry with the
   orb/dot center pinned to a fixed screen anchor so the orb never jumps when
   switching views (views expand up-and-to-the-left). No click-through hackery
   (`setIgnoreMouseEvents`) — closed state is a small 168×168 orb; the panel
   fills its window. Single-vs-double click is discriminated with a 220ms timer
   (click → panel, double-click → workbench, drag → move via `app-region: drag`).

4. **Native right-click context menu.** `installRobotContextMenu(actions)`
   builds a `Menu` (Open Workbench / Pause / Resume Routines / Quit). Actions
   are injected from `index.ts` so `robot-window.ts` does not import the
   container (avoids the module-load cycle container → handlers → windows →
   robot-window). `RoutineScheduler.pause()/resume()` toggle a `paused` flag
   that suppresses `fire` (manual runs still work); distinct from `stop()`.

5. **Draft Review preset — a real pausing routine.** The mock path otherwise
   never pauses (Morning Brief / Auto Inbox have no R2/R3 auto-runs). The Draft
   Review routine: `email.list` (continueOnError) → explicit `approval` step on
   `email.create_draft` (R3) with **field-templated args**
   (`{{gmailEmails[0].accountId}}`, `{{gmailEmails[0].from.address}}`,
   `Re: {{gmailEmails[0].subject}}`, …) → notify. This required two fixes:
   - **`resolveTemplate` array-index support** (`tokenizePath` handles
     `[N]` → dotted parts; new `TOKEN_PATH`/`EXACT_RE`/`MIXED_RE`).
   - **A latent content-immutability bug.** `engine.resolveStepArgs` resolved
     args against **empty** outputs — fine for the M2 static-args approval
     test, but any templated approval step hashed mismatch at resume and was
     refused ("content changed"). Fixed to resolve against `run.stepOutputs`
     (stable across pause/resume since earlier steps don't re-run). A new
     regression test covers templated-args approval.

6. **Workbench polish: loading / error / empty triad + routine config.**
   `hooks/useAsync.ts` centralizes `{data, loading, error, setData, refetch}`;
   `components/states.tsx` provides `Loading`/`EmptyState`/`ErrorState`. Applied
   across Home, Tasks, Activity, NeedToKnow, Approvals, Routines, and the
   Integrations LLM card — pages no longer silently swallow IPC rejections.
   Routines page gains next-run (compute from trigger type — poll is
   computable; cron next-fire needs a parser and is out of scope, so the
   schedule is surfaced without a misleading precise time), run-history
   (expandable, `listRoutineRuns`), and inline trigger editing via
   `updateRoutine` (`manual`/`schedule`/`email_poll`/`calendar_before`);
   step editing stays M5. Workbench subscribes to `onNavigate` so the robot
   "Review" deep-link switches the active page.

7. **macOS packaging.** `electron-builder` (config in `electron-builder.yml`):
   appId `com.daymate.app`, mac targets `dir`+`dmg`, host-architecture only
   (no cross-arch electron download — the deliverable is a local .app that runs
   on the build machine; universal/arm64+x64 is a later step). `asarUnpack`
   keeps `better-sqlite3`'s `.node` outside the asar. **No code signing /
   notarization** (needs a paid Apple Developer ID) — the unsigned app opens on
   the build machine; Gatekeeper may warn. `dist`/`dist:dir` scripts.

8. **Playwright Electron e2e.** `@playwright/test` installed with
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (only `_electron.launch` is used — no
   browser binaries needed). `test:e2e` = `pnpm build && playwright test`.
   Each test isolates `userData` via a `DAYMATE_USER_DATA` env var honored in
   `main/index.ts` before bootstrap reads it (fresh temp dir → no clobber of the
   real profile/DB; distinct single-instance locks). Three specs (all green):
   boot (two windows, idle state, no Node exposure via the typed bridge),
   Morning Brief (run from Home → robot done + Activity recorded), and
   approval-from-robot (Draft Review → need_approval; Review deep-link opens
   Approvals; approve → executed; covers content-immutability at resume with
   templated args).

## Verification (run this milestone)

1. `pnpm rebuild better-sqlite3` → `pnpm test` → `pnpm rebuild:native` — 93 unit
   + integration tests green (the sqlite-store test runs on the Node ABI, then
   the native rebuild restores the Electron ABI for the app/e2e).
2. `pnpm typecheck` · `pnpm lint` · `pnpm build` — green.
3. `pnpm dist` — produces `dist/mac-arm64/Daymate.app` (+ dmg).
4. `pnpm test:e2e` — 3 Playwright Electron specs green.
5. `pnpm dev` smoke — robot orb reflects working→thinking→done + a bubble on a
   Morning Brief; Draft Review → need_approval, Review opens Approvals, approve
   → done; right-click robot → context menu pauses/resumes/opens/quits.

## Deferred (out of this pass — spec rule 6/7)

- Full conversational Assistant (model-callable tool surface, stop action) —
  M5 (needs the deferred-from-M3 tool surface).
- Memory Service — M5 (§21).
- Real Feishu / Gmail / 163 — activate when credentials are supplied.
- Code signing + notarization — needs a paid Apple Developer ID.
- Universal / arm64+x64 packaging + the cron next-fire computation.
- Custom Routine builder (step editing) — M5.
