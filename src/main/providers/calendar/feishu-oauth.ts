// Feishu (飞书) user-OAuth helpers (Spec §10). Mirrors the Gmail loopback
// pattern, with ONE difference: Feishu requires the redirect_uri to be
// EXACTLY pre-registered in the app console (no "any localhost port" rule like
// Google's RFC 8252). So we bind a FIXED port (12700) instead of an
// OS-assigned one. If 12700 is taken, the connect fails with a clear error.
//
// Flow: authorize URL (browser) → loopback /callback?code=...&state=... →
// app_access_token (app_id/secret) → exchange code for user_access_token +
// refresh_token (Bearer app_access_token). Refresh with refresh_access_token.
//
// open.feishu.cn is domestic (CN); reachable without a proxy. But to stay
// consistent with the Gmail provider (and survive a proxy that touches it),
// the HTTP calls take an injectable `FeishuFetch` — prod passes Electron
// `net.fetch`, tests pass Node global `fetch`.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export type FeishuFetch = (
  input: string,
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>

export const FEISHU_REDIRECT_PORT = 12700
export const FEISHU_REDIRECT_URI = `http://127.0.0.1:${FEISHU_REDIRECT_PORT}/callback`
export const FEISHU_BASE = 'https://open.feishu.cn'

export interface FeishuClient {
  appId: string
  appSecret: string
}

export interface FeishuUserTokens {
  accessToken: string
  refreshToken: string
  /** Unix-ms epoch when the access token expires. */
  expiresAt: number
}

export function newState(): string {
  return randomBytes(16).toString('hex')
}

export function authorizeUrl(client: FeishuClient, state: string): string {
  const params = new URLSearchParams({
    app_id: client.appId,
    redirect_uri: FEISHU_REDIRECT_URI,
    state,
    // Force consent each time so we always get a fresh refresh token.
    always_reload: 'true'
  })
  return `${FEISHU_BASE}/open-apis/authen/v1/authorize?${params.toString()}`
}

/**
 * App-level access token (needed to exchange/refresh the user token). Short-
 * lived (~2h); fetched fresh each time it's needed.
 */
export async function fetchAppAccessToken(
  client: FeishuClient,
  fetchImpl: FeishuFetch
): Promise<string> {
  const res = await fetchImpl(`${FEISHU_BASE}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: client.appId, app_secret: client.appSecret })
  })
  const json = (await res.json()) as { code?: number; msg?: string; app_access_token?: string }
  if (json.code !== 0 || !json.app_access_token) {
    throw new Error(`飞书获取 app_access_token 失败：${json.msg ?? JSON.stringify(json)}`)
  }
  return json.app_access_token
}

/**
 * Exchange the user-OAuth code for user tokens. Requires the app_access_token
 * as a Bearer header (Feishu quirk).
 */
export async function exchangeCode(
  client: FeishuClient,
  code: string,
  fetchImpl: FeishuFetch
): Promise<FeishuUserTokens> {
  const appToken = await fetchAppAccessToken(client, fetchImpl)
  const res = await fetchImpl(`${FEISHU_BASE}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${appToken}`
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code })
  })
  const json = (await res.json()) as {
    code?: number
    msg?: string
    data?: { access_token?: string; refresh_token?: string; expires_in?: number }
  }
  if (json.code !== 0 || !json.data?.access_token || !json.data.refresh_token) {
    throw new Error(`飞书用户令牌交换失败：${json.msg ?? JSON.stringify(json)}`)
  }
  const expiresAt = Date.now() + (json.data.expires_in ?? 7200) * 1000
  return { accessToken: json.data.access_token, refreshToken: json.data.refresh_token, expiresAt }
}

/** Refresh an expired user access token using the refresh token. */
export async function refreshUserToken(
  client: FeishuClient,
  refreshToken: string,
  fetchImpl: FeishuFetch
): Promise<FeishuUserTokens> {
  const appToken = await fetchAppAccessToken(client, fetchImpl)
  const res = await fetchImpl(`${FEISHU_BASE}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${appToken}`
    },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken })
  })
  const json = (await res.json()) as {
    code?: number
    msg?: string
    data?: { access_token?: string; refresh_token?: string; expires_in?: number }
  }
  if (json.code !== 0 || !json.data?.access_token || !json.data.refresh_token) {
    throw new Error(`飞书令牌刷新失败：${json.msg ?? JSON.stringify(json)}`)
  }
  const expiresAt = Date.now() + (json.data.expires_in ?? 7200) * 1000
  return { accessToken: json.data.access_token, refreshToken: json.data.refresh_token, expiresAt }
}

export interface CallbackResult {
  code: string
  state: string
}

/**
 * Loopback callback server on the FIXED port 12700 (Feishu requires the
 * redirect_uri to be pre-registered, so the port can't be OS-assigned).
 * Resolves with {code, state} on success, rejects on error/timeout/CSRF
 * mismatch. Auto-closes in all cases via `.then(close, close)` (NOT finally,
 * which would propagate the rejection to the chained promise).
 */
export async function startCallbackServer(
  expectedState: string,
  timeoutMs = 3 * 60 * 1000
): Promise<{
  waitForCode: () => Promise<CallbackResult>
  redirectUri: string
  close: () => void
}> {
  const u = new URL(FEISHU_REDIRECT_URI)
  const server: Server = createServer((req, res) => {
    // CORS / health: only handle the callback path.
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (!req.url) {
      res.writeHead(404)
      res.end('not found')
      return
    }
  })
  // Defer handler registration until we have expectedState below.
  let resolveCb: ((r: CallbackResult) => void) | undefined
  let rejectCb: ((e: Error) => void) | undefined
  const promise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCb = resolve
    rejectCb = reject
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      if (!req.url) return
      const url = new URL(req.url, FEISHU_REDIRECT_URI)
      if (url.pathname !== u.pathname) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const err = url.searchParams.get('error')
      if (err) {
        res.writeHead(200)
        res.end(`<h1>Authorization failed</h1><p>${err}</p><p>Close this tab and return to Daymate.</p>`)
        rejectCb?.(new Error(`Feishu authorization denied: ${err}`))
        return
      }
      if (!code || !state) {
        res.writeHead(400)
        res.end('missing code/state')
        return
      }
      if (state !== expectedState) {
        res.writeHead(400)
        res.end('状态不匹配 —— 可能存在 CSRF')
        rejectCb?.(new Error('飞书 OAuth 状态不匹配（CSRF 校验失败）'))
        return
      }
      res.writeHead(200)
      res.end('<h1>Feishu authorized</h1><p>You can close this tab and return to Daymate.</p>')
      resolveCb?.({ code, state })
    })
  })

  // Bind the FIXED port. If taken, reject with a clear error.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Feishu OAuth callback port ${FEISHU_REDIRECT_PORT} is in use — close the app holding it and retry.`))
      } else {
        reject(err)
      }
    }
    server.once('error', onError)
    server.listen(FEISHU_REDIRECT_PORT, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const timeout = setTimeout(() => {
    rejectCb?.(new Error('Feishu OAuth callback timed out (3 min)'))
  }, timeoutMs)
  const close = (): void => {
    clearTimeout(timeout)
    server.close()
  }
  promise.then(() => close(), () => close())

  return {
    waitForCode: () => promise,
    redirectUri: FEISHU_REDIRECT_URI,
    close
  }
}
