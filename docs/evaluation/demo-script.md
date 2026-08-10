# Critical Demo Script (Spec §22)

The three-minute demo of the credential-free Daymate flow. The automated
guard — `tests/e2e/demo.spec.ts` — runs this exact flow three consecutive
times (fresh isolated app each run) to satisfy the §19 release gate
"critical demo flow succeeds three consecutive times." This document is the
manual recording script for the portfolio video.

## Prerequisites

- `pnpm install` done; `pnpm build` green (or run `pnpm dev` for a live build).
- No credentials required — the credential-free mock path provides Gmail,
  163 and Feishu fixtures, deterministic agent stubs, and a mock draft sender.
- Optional: configure an LLM key (Integrations → LLM) to run the real model
  path. The demo works identically without it; the stubs are deterministic.

## The ten-step critical flow

| # | Step | How to show it | Pass criterion |
|---|------|----------------|----------------|
| 1 | Robot wakes + Morning Brief ready | Click **Run Morning Brief** on Home | Robot orb cycles working→thinking→**done** |
| 2 | Home shows combined Gmail/163/Feishu/Tasks | Read the Recent-activity card | Activity entries span all sources |
| 3 | Important email becomes Need to Know | Open **Need to Know** | A NTK item derived from an email exists |
| 4 | Agent extracts action + creates a Task | Open **Tasks** | A Task with `sourceType` from the brief exists |
| 5 | Agent drafts a response | Click **Run** on the **Draft Review** routine | Run pauses at `waiting_approval` |
| 6 | Robot enters Need Approval | Watch the robot orb | Orb → **need_approval** + a proactive bubble |
| 7 | User previews + approves | Robot bubble **Review** → Approvals → **Approve & send** | Approval card previewed, then approved |
| 8 | Exact reviewed draft is sent | Approvals list | That approval → **executed** (draft created) |
| 9 | Activity shows the complete trace | Open **Activity** | Both runs' steps listed in order |
| 10 | Routines page shows config + next run | Open **Routines** | Presets visible (Morning Brief, Draft Review, …) with triggers |

## Recording notes

- Record in a single take, ~3 minutes. Each step's pass criterion is visible on
  screen — narrate it as you go.
- The robot orb is the visual anchor: it should read `idle` → `working` →
  `thinking` → `done` (step 1), then `need_approval` (step 6), then `done`
  again (step 8).
- Right-click the robot at any point to show the context menu (Pause/Resume
  Routines, Open Workbench, Quit) — optional flourish.
- No test data or credentials appear on screen: the mock fixtures are labelled
  (`mock-msg-…`, `mock-event-…`), the LLM key field is write-only (displays
  only `keyConfigured: true`, never the value), and the userData dir is
  isolated per run in the automated guard.

## Automated guard

`tests/e2e/demo.spec.ts` runs steps 1–10 three consecutive times against a
fresh `DAYMATE_USER_DATA` dir each iteration, asserting every pass criterion
programmatically (robot-state transitions, NTK/task counts, approval
pending→executed, activity growth, routines present). `pnpm test:e2e` runs
it as part of the e2e suite.
