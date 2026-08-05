# Daymate

Persistent macOS-first desktop personal work agent. Connects Gmail, 163 Mail
and Feishu Calendar, runs configurable Routines, and requires explicit
approval before any external write.

Full product spec: [`DEVELOPMENT_SPEC.md`](./DEVELOPMENT_SPEC.md).

## Status

Milestone 0 — repository scaffold and security guardrails.

## Local setup

Requirements: Node ≥ 20, pnpm.

```bash
pnpm install
cp .env.example .env   # fill in only what you need; never commit real secrets
pnpm dev               # launches the robot + workbench windows
```

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Run the app in development (electron-vite) |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript check (main + renderer) |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright e2e (wired in Milestone 4) |

## Architecture

All credentials, Provider calls, Agent execution, Routine scheduling and
database writes run in the Electron main process. The renderer is sandboxed
(`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and
communicates only through the typed IPC surface exposed by the preload. See
[`CLAUDE.md`](./CLAUDE.md) for the full constraint summary.
