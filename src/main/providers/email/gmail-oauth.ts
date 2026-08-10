// Gmail OAuth 2.0 loopback flow (Spec §9) — desktop/installed-app flow.
//
// Spec §9/§17: OAuth 2.0 installed application flow; offline access + refresh
// token; refresh token stored via Credential Service; never log tokens or raw
// authorization codes; renderer never sees refresh token. The loopback
// callback server runs on the main process; only an opaque status reaches the
// renderer. client_id/client_secret are credentials → SecretStore, never
// source/settings.json.
//
// No `googleapis` dependency: the REST surface is tiny (auth token exchange,
// messages, drafts) and hand-rolling keeps token handling inside the
// SecretStore architecture and avoids a large native/ESM dependency.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  // Read-only user email for the account display name (Spec §15: show source
  // account). userinfo.email is read-only and carries no mail access.
  'https://www.googleapis.com/auth/userinfo.email'
]

export interface GmailTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number // epoch ms
  scope?: string
  emailAddress?: string
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

/**
 * Fetch signature narrow enough to accept BOTH the global `fetch` (Node undici)
 * and Electron's `net.fetch` (whose `input` is `string | Request`, no `URL`).
 * Gmail/OAuth only ever pass string URLs, so this is safe. Defined via type
 * queries so we don't reference bare `RequestInit`/`Response` globals (which
 * eslint's no-undef can't resolve from @types/node).
 */
export type GmailFetch = (
  input: string,
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>

/** Build the authorization URL for the browser (Spec §9 desktop flow). */
export function buildAuthUrl(client: OAuthClient, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline', // refresh token
    include_granted_scopes: 'true',
    state,
    prompt: 'consent' // force consent so a refresh token is always granted
  })
  return `${AUTH_URL}?${params.toString()}`
}

/** Look up the user's email for the account display (read-only userinfo). */
async function fetchEmail(accessToken: string, fetchImpl: GmailFetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { emailAddress?: string }
    return json.emailAddress
  } catch {
    return undefined
  }
}

/** Exchange an authorization code for tokens (never logged). */
export async function exchangeCode(
  client: OAuthClient,
  code: string,
  redirectUri: string,
  fetchImpl: GmailFetch = fetch
): Promise<GmailTokens> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    // Never include the code/secret in the thrown message.
    throw new Error(`OAuth 令牌交换失败：${res.status}`)
  }
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
  }
  const tokens: GmailTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope
  }
  // Resolve the account email for display + accountId (read-only userinfo).
  tokens.emailAddress = await fetchEmail(json.access_token, fetchImpl)
  return tokens
}

/** Refresh an expired access token using the stored refresh token. */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
  fetchImpl: GmailFetch = fetch
): Promise<GmailTokens> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`OAuth 令牌刷新失败：${res.status}`)
  const json = (await res.json()) as { access_token: string; expires_in: number; scope?: string }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope
  }
}

/**
 * Start the loopback HTTP server that receives the OAuth callback. Returns the
 * resolved redirect URI and a promise that resolves with {code, state} when
 * Google redirects back. The server is closed after the first callback.
 * Uses port 0 (OS-assigned); Google's Desktop app type accepts any localhost
 * port (RFC 8252 loopback), so no fixed port registration is needed.
 */
export async function startCallbackServer(): Promise<{
  redirectUri: string
  waitForCode: () => Promise<{ code: string; state: string }>
  close: () => void
}> {
  let server: Server | null = null
  let resolveCb: ((v: { code: string; state: string }) => void) | null = null
  let rejectCb: ((e: Error) => void) | null = null

  const promise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCb = resolve
    rejectCb = reject
  })

  server = createServer((req, res) => {
    const u = parseUrl(req.url ?? '/')
    if (!u || u.pathname !== '/callback') {
      res.writeHead(404).end('not found')
      return
    }
    const code = u.searchParams.get('code')
    const state = u.searchParams.get('state')
    const err = u.searchParams.get('error')
    if (err) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<h2>Gmail connection cancelled</h2><p>${err}</p><p>You can close this tab.</p>`)
      rejectCb?.(new Error(`OAuth cancelled: ${err}`))
      return
    }
    if (!code || !state) {
      res.writeHead(400).end('缺少 code/state')
      rejectCb?.(new Error('OAuth 回调缺少 code/state'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h2>Gmail connected</h2><p>You can close this tab and return to Daymate.</p>')
    resolveCb?.({ code, state })
  })

  // Listen on an OS-assigned port; the assigned port is only available once
  // 'listening' fires, so await it.
  await new Promise<void>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => resolve())
    server!.once('error', reject)
  })
  const port = (server.address() as { port: number }).port
  const redirectUri = `http://127.0.0.1:${port}/callback`

  const close = (): void => {
    server?.close()
    server = null
  }

  // Auto-close after the callback resolves or a 3-minute timeout. Use
  // `then(close, close)` rather than `finally`: `finally` would propagate the
  // rejection to the returned chained promise (unhandled), whereas both
  // handlers here return undefined → the chain resolves cleanly.
  const timeout = setTimeout(() => rejectCb?.(new Error('OAuth callback timed out (3 min)')), 3 * 60 * 1000)
  promise.then(
    () => {
      clearTimeout(timeout)
      close()
    },
    () => {
      clearTimeout(timeout)
      close()
    }
  )

  return { redirectUri, waitForCode: () => promise, close }
}

/** Opaque state token to mitigate CSRF on the callback. */
export function newState(): string {
  return randomBytes(16).toString('hex')
}

// Node URL global is available in Electron main (Node 20+). Tiny parse helper
// avoids importing the URL module on the hot path.
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw, 'http://127.0.0.1')
  } catch {
    return null
  }
}
