# ADR 0001 — Milestone 0 security and build decisions

Date: 2026-08-06
Status: Accepted
Milestone: 0

## Context

M0 scaffolds the Electron shell under strict security constraints (spec §5,
§17): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
typed IPC only, and a Content-Security-Policy. Two issues surfaced while
bringing the renderer up blank.

## Decision 1 — CommonJS main + preload (no `"type": "module"`)

**Problem:** With `"type": "module"` in `package.json`, electron-vite builds the
preload as ESM (`out/preload/index.mjs`). A **sandboxed** renderer preload
cannot evaluate ESM — it fails with `Cannot use import statement outside a
module`, so the preload never runs, `contextBridge` never exposes `window.daymate`,
and the renderer crashes on first IPC call (blank window).

**Decision:** Drop `"type": "module"`. electron-vite then emits CommonJS
(`out/main/index.js`, `out/preload/index.js`) for main and preload. CJS preload
loads cleanly under `sandbox: true`. The renderer stays ESM (Vite handles it
independently; it is not affected by this setting).

**Rejected alternative:** keep ESM and set `sandbox: false`. Rejected because
spec §5 wants `sandbox: true where compatible`; making the preload CJS keeps
sandbox on. ESM main has negligible benefit for a desktop agent and is not
worth the sandbox cost.

## Decision 2 — CSP via session header, dev/prod split

**Problem:** Vite injects an inline HMR/react-refresh preamble and uses a
WebSocket for HMR. A strict `script-src 'self'` CSP (set via HTML `<meta>`)
blocks the inline preamble, so `$RefreshSig`/`$RefreshReg` are undefined and
component modules throw on evaluation — blank window again.

**Decision:** Remove the `<meta>` CSP from the renderer HTML and set CSP via
`session.defaultSession.webRequest.onHeadersReceived` in main
(`src/main/security/csp.ts`):
- **dev** (`!app.isPackaged`): allow `'unsafe-inline'`/`'unsafe-eval'` for
  script, `ws:` and `localhost` for connect — required by Vite HMR.
- **prod**: strict — `script-src 'self'`, no eval, no ws.

This keeps the production posture strict (spec §17) while not fighting the dev
toolchain. The dev "Insecure Content-Security-Policy" warning is expected.

## Decision 3 — Renderer entry paths

electron-vite serves nested renderer HTML at its path under the vite root
(`src/renderer`): the robot loads `${URL}/robot/index.html` and workbench loads
`${URL}/workbench/index.html` (not `/robot.html`). Both windows share one
preload that exposes the typed `window.daymate` API.
