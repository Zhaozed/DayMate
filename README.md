# Daymate

A persistent, privacy-first personal work agent for macOS. Daymate connects
your inboxes and calendar, proactively surfaces what actually needs your
attention today, drafts replies in your own tone, tracks your job-search
funnel end-to-end — and **never performs an external write without your
explicit approval**.

It runs as a local desktop agent (Electron). All credentials, provider calls,
agent execution, and database writes live in the sandboxed main process; the
renderer never touches Node, tokens, or raw storage.

> Full product spec: [`DEVELOPMENT_SPEC.md`](./DEVELOPMENT_SPEC.md).
> Working constraints & milestone index: [`CLAUDE.md`](./CLAUDE.md).

## What it does

- **必读 (the briefing)** — a consolidated, cross-source view of everything
  important from connected inboxes. Same-conversation emails collapse into a
  single thread item; items are grouped into 学校 / 求职 / 日常 / 其他.
  Three-layer defense keeps the signal clean: deterministic pre-filter
  (bulk / marketing / verification codes never reach the LLM), LLM
  classification, and an `important || actionable` surface gate.
- **首页 (home)** — three cards: today's weather (real wttr.in + LLM-polished
  advice, cached daily), a swipeable morning-brief carousel over the last
  week, and a manageable to-do list. Mail to-dos (`todoTitle` / `dueDate`)
  are extracted inside the already-running classifier — zero extra LLM calls.
- **投递 (job-search funnel)** — applications and their event timeline
  (投递 → 测评 → 笔试 → 面试 → offer → 复盘) tracked in one place. New
  applications are inferred from incoming email with a confidence gate
  (low-confidence leads stay `pending` and are never auto-created). Includes
  a review dashboard (KPI tiles, funnel bar, source donut) and an AI
  post-mortem action.
- **Agent + safety** — an agent runtime (`@earendil-works/pi-agent-core`)
  with a Tool Registry, structured output (Zod re-validation), prompt-injection
  hardening (`enforceTrust` strips untrusted-source fields), and §15 approval
  gates. External writes need preview + approval, and content cannot change
  between approval and execution. Drafts are the one R1 exception (insert into
  your own Drafts folder, review + send manually).

## Real integrations

- **Gmail** — OAuth 2.0 loopback flow, REST (no googleapis), safe MIME
  extraction, tokens in Keychain, proxy-aware fetch.
- **163 Mail** — real IMAP (read) + SMTP (send) authorized by 授权码; IMAP
  APPEND drafts, exact RFC822 send with content immutability.
- **Feishu Calendar** — skeleton, activates on credentials.

## Architecture

Everything sensitive runs in the Electron **main process**; the renderer is
sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`)
and talks only through the typed IPC surface exposed by the preload
(`window.daymate`). Canonical contracts live in `src/shared`. Provider calls,
routine scheduling, agent execution, and SQLite writes never cross to the
renderer.

```
src/main/        windows · agent · routines · providers · services · db · ipc
src/preload/     contextBridge (the only ipcRenderer surface)
src/renderer/    robot/ · workbench/  (separate HTML entries)
src/shared/      types · schemas · constants · cron  (IPC contracts)
tests/           unit · integration · e2e
docs/            decisions/ (ADRs) · evaluation/
```

## Download & install (macOS)

Prebuilt **universal** (Apple Silicon + Intel) releases are published on the
[GitHub Releases page](https://github.com/Zhaozed/DayMate/releases) — download
the `.dmg`, drag Daymate to Applications, and follow
[`INSTALL.md`](./INSTALL.md) for the one-time Gatekeeper step (the app is
unsigned for now) and first-run credential setup (LLM key, Gmail OAuth client,
163 授权码 — all self-supplied, encrypted, local-only).

## Local setup

Requirements: Node ≥ 20, pnpm, Python 3 (for `better-sqlite3` native rebuild).

```bash
pnpm install
cp .env.example .env   # fill in only what you need; never commit real secrets
pnpm dev               # launches the robot + workbench windows
```

Connect providers from the in-app **集成与设置** page (Gmail OAuth, 163
授权码, weather city, etc.). The LLM key is write-only and safeStorage-encrypted.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Run the app in development (electron-vite) |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript check (shared + main + renderer) |
| `pnpm lint` | ESLint (zero warnings) |
| `pnpm test` | Vitest unit + integration tests |
| `pnpm test:e2e` | Playwright e2e (builds first) |
| `pnpm dist` | Universal (arm64 + x64) macOS packaging |

## Tech stack

Electron · electron-vite · React + TypeScript · Tailwind CSS v4 ·
`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` · Zod ·
SQLite + Drizzle ORM · node-cron · Gmail API · IMAP/SMTP (163) · Feishu OpenAPI.

## Decisions

Every milestone and post-MVP change is recorded as an ADR under
[`docs/decisions/`](./docs/decisions) (0001–0029) — each captures what was
verified, the key decisions, and the failure → root-cause → fix path. The
milestone index lives in [`CLAUDE.md`](./CLAUDE.md).

## Status

Core milestones (M0–M5) and post-MVP extensions through ADR 0029 are complete
and self-hosted. Real providers activated for Gmail + 163; Feishu Calendar
activates on credentials. See the milestone table in `CLAUDE.md` for the full
history and current state.
