// Content Security Policy, applied via session headers so dev and prod differ.
// Spec §17: external content is untrusted; tokens never enter model context.
//
// Dev must allow vite's inline HMR/react-refresh preamble + ws, otherwise the
// renderer JS module never evaluates and the window stays blank. Production
// keeps a strict CSP (no inline script, no eval, no ws).

import { app, session } from 'electron'

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // vite HMR websocket + local dev server
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*"
].join('; ')

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:"
].join('; ')

export function installContentSecurityPolicy(): void {
  const policy = app.isPackaged ? PROD_CSP : DEV_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
