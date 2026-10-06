// Real Gmail Provider (Spec §9). Implements the EmailProvider contract over
// the Gmail REST API + OAuth 2.0 desktop flow. Tokens (access + refresh +
// expiry) and the OAuth client (client_id/secret) live in the SecretStore
// (safeStorage/Keychain) — never in source, settings.json, logs, or the
// renderer. The renderer only ever sees an opaque account status.
//
// No `googleapis`: hand-rolled fetch over the small REST surface we need
// (messages.list/get, drafts.create/send). MIME text is extracted safely —
// text/plain preferred, HTML stripped to text — and never executed
// (Spec §17.12/§17.13). Bodies are length-capped by the agent runtime.

import type {
  IntegrationAccount,
  IntegrationStatus,
  NormalizedEmail,
  EmailQuery,
  EmailDraft,
  EmailDraftInput,
  EmailSendResult,
  SentMailQuery,
  MailAddress
} from '@shared/types'
import type { EmailProvider } from './email-provider'
import type { SecretStore } from '../../util/secrets'
import { nowIso } from '../../util/ids'
import { detectBulkFromHeaders } from '../../util/bulk-mail'
import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  startCallbackServer,
  newState,
  type GmailTokens,
  type OAuthClient,
  type GmailFetch
} from './gmail-oauth'

const TOKENS_KEY = 'gmail'
const CLIENT_KEY = 'gmail-oauth-client'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

export interface GmailProviderDeps {
  secrets: SecretStore
  /** Open an external URL in the default browser (electron.shell.openExternal). */
  openExternal: (url: string) => Promise<void>
  /**
   * HTTP fetch implementation. In production this is Electron's `net.fetch`
   * (Chromium network stack → respects system proxy / VPN, so Gmail API calls
   * work from behind a proxy where Node's undici fetch times out). In tests the
   * default Node global fetch is fine (loopback only).
   */
  fetch?: GmailFetch
}

export class GmailProvider implements EmailProvider {
  readonly provider = 'gmail' as const
  readonly accountId = 'gmail-real'

  constructor(private readonly deps: GmailProviderDeps) {}

  /** The fetch impl to use for Gmail/OAuth REST calls (proxy-aware in prod). */
  private get http(): GmailFetch {
    return this.deps.fetch ?? globalThis.fetch
  }

  // ── OAuth client (client_id/secret) — stored as a credential, not config ──

  async setClient(clientId: string, clientSecret: string): Promise<void> {
    await this.deps.secrets.save(CLIENT_KEY, JSON.stringify({ clientId, clientSecret }))
  }

  async hasClient(): Promise<boolean> {
    return this.deps.secrets.has(CLIENT_KEY)
  }

  async getClient(): Promise<OAuthClient> {
    const raw = await this.deps.secrets.readKey(CLIENT_KEY)
    if (!raw) throw new Error('Gmail OAuth 客户端未配置 —— 请在「集成」中填写 client_id/secret。')
    const parsed = JSON.parse(raw) as OAuthClient
    if (!parsed.clientId || !parsed.clientSecret) throw new Error('Gmail OAuth 客户端配置无效。')
    return parsed
  }

  // ── Token storage ──────────────────────────────────────────────────────────

  async loadTokens(): Promise<GmailTokens | undefined> {
    const raw = await this.deps.secrets.readKey(TOKENS_KEY)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as GmailTokens
    } catch {
      return undefined
    }
  }

  async saveTokens(t: GmailTokens): Promise<void> {
    await this.deps.secrets.save(TOKENS_KEY, JSON.stringify(t))
  }

  /** Resolve a valid access token, refreshing if expired. Throws if offline. */
  private async ensureAccessToken(): Promise<string> {
    const t = await this.loadTokens()
    if (!t) throw new Error('Gmail 未连接 —— 请在「集成」中执行连接。')
    // Refresh if expired or within 60s of expiry.
    if (t.expiresAt - Date.now() < 60_000) {
      if (!t.refreshToken) throw new Error('Gmail 访问令牌已过期且无刷新令牌 —— 请重新连接。')
      const client = await this.getClient()
      const refreshed = await refreshAccessToken(client, t.refreshToken, this.http)
      const next: GmailTokens = {
        ...t,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope ?? t.scope
      }
      await this.saveTokens(next)
      return next.accessToken
    }
    return t.accessToken
  }

  // ── EmailProvider interface ─────────────────────────────────────────────────

  async connect(): Promise<IntegrationAccount> {
    const client = await this.getClient()
    const cb = await startCallbackServer()
    const state = newState()
    const authUrl = buildAuthUrl(client, cb.redirectUri, state)
    // Open the browser for the user to authorize; await the loopback callback.
    await this.deps.openExternal(authUrl)
    const { code, state: returned } = await cb.waitForCode()
    if (returned !== state) throw new Error('OAuth 状态不匹配 —— 可能存在 CSRF，已中止。')
    const tokens = await exchangeCode(client, code, cb.redirectUri, this.http)
    await this.saveTokens(tokens)
    return this.account()
  }

  async disconnect(): Promise<void> {
    // Delete stored tokens (revocation is best-effort; we never hold the
    // client secret in logs). Client creds are retained for easy reconnect.
    await this.deps.secrets.delete(TOKENS_KEY)
  }

  async getStatus(): Promise<IntegrationStatus> {
    const t = await this.loadTokens()
    if (!t) return 'disconnected'
    if (t.expiresAt - Date.now() < 60_000 && !t.refreshToken) return 'expired'
    return 'connected'
  }

  /** The connected account's email (read-only userinfo), never the token. */
  async getEmailAddress(): Promise<string | undefined> {
    const t = await this.loadTokens()
    return t?.emailAddress
  }

  async listMessages(query: EmailQuery): Promise<NormalizedEmail[]> {
    const accessToken = await this.ensureAccessToken()
    const limit = Math.min(query.limit ?? 20, 100)
    const params = new URLSearchParams({ maxResults: String(limit) })
    const q: string[] = []
    if (query.unreadOnly) q.push('is:unread')
    if (query.sinceHours) q.push(`newer_than:${query.sinceHours}h`)
    if (q.length) params.set('q', q.join(' '))
    const ids = await this.gmailGet<{ messages?: Array<{ id: string; threadId?: string }> }>(
      accessToken,
      `/users/me/messages?${params}`
    )
    if (!ids.messages) return []
    const out: NormalizedEmail[] = []
    for (const m of ids.messages) {
      const msg = await this.getMessage(m.id)
      // Incremental high-water-mark: Gmail `list` returns newest-first, so once
      // we hit a message at or before the cursor, the rest are already-seen —
      // stop fetching (avoids re-running the agent on processed mail). The
      // `format=full` get for the boundary message is the only wasted fetch.
      if (query.sinceInternalDate && new Date(msg.receivedAt).getTime() <= query.sinceInternalDate) {
        break
      }
      out.push(msg)
    }
    return out
  }

  /** ADR 0027 — cold-start backfill: page backward through the full history
   *  (via `nextPageToken`, which `listMessages` deliberately does NOT consume)
   *  until the oldest message on a page predates `sinceInternalDate` or pages
   *  run out. Caps at `maxPages × 100` mails for cost/rate-limit safety. This
   *  path is SEPARATE from the incremental `listMessages` so the sync loop's
   *  cursor logic is untouched. Returns newest-first. */
  async listAllSince(sinceInternalDate: number, maxPages = 20): Promise<NormalizedEmail[]> {
    const accessToken = await this.ensureAccessToken()
    const out: NormalizedEmail[] = []
    let pageToken: string | undefined
    let pages = 0
    let hitBoundary = false
    while (pages < maxPages && !hitBoundary) {
      const params = new URLSearchParams({ maxResults: '100' })
      if (pageToken) params.set('pageToken', pageToken)
      const ids = await this.gmailGet<{
        messages?: Array<{ id: string; threadId?: string }>
        nextPageToken?: string
      }>(accessToken, `/users/me/messages?${params}`)
      if (!ids.messages || ids.messages.length === 0) break
      for (const m of ids.messages) {
        const msg = await this.getMessage(m.id)
        if (new Date(msg.receivedAt).getTime() <= sinceInternalDate) {
          hitBoundary = true
          break
        }
        out.push(msg)
      }
      pageToken = ids.nextPageToken
      pages++
      if (!pageToken) break // no more pages
    }
    return out
  }

  /** ADR 0027 — EmailProvider.listBackfill for the cold-start orchestrator. */
  async listBackfill(sinceDate: Date, maxItems = 2000): Promise<NormalizedEmail[]> {
    const since = sinceDate.getTime()
    const maxPages = Math.max(1, Math.ceil(maxItems / 100))
    return this.listAllSince(since, maxPages)
  }

  async getMessage(messageId: string): Promise<NormalizedEmail> {
    const accessToken = await this.ensureAccessToken()
    const msg = await this.gmailGet<GmailMessageRaw>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}?format=full`
    )
    return normalizeGmailMessage(msg, this.accountId)
  }

  /** ADR 0029 — fetch the whole conversation via threads.get (native threadId).
   *  Returns the thread's messages oldest-first so the 必读 expand reads top-
   *  down. R0 read-only; never persisted. */
  async getThread(threadId: string): Promise<NormalizedEmail[]> {
    const accessToken = await this.ensureAccessToken()
    const thread = await this.gmailGet<{ messages?: GmailMessageRaw[] }>(
      accessToken,
      `/users/me/threads/${encodeURIComponent(threadId)}?format=full`
    )
    if (!thread.messages?.length) return []
    const out = thread.messages.map((m) => normalizeGmailMessage(m, this.accountId))
    // Oldest first (Gmail returns newest-first).
    out.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
    return out
  }

  async searchMessages(query: string, limit?: number): Promise<NormalizedEmail[]> {
    const accessToken = await this.ensureAccessToken()
    const params = new URLSearchParams({ q: query, maxResults: String(limit ?? 20) })
    const ids = await this.gmailGet<{ messages?: Array<{ id: string }> }>(
      accessToken,
      `/users/me/messages?${params}`
    )
    if (!ids.messages) return []
    const out: NormalizedEmail[] = []
    for (const m of ids.messages) out.push(await this.getMessage(m.id))
    return out
  }

  async listSent(query: SentMailQuery): Promise<NormalizedEmail[]> {
    // `in:sent` restricts to the user's Sent mailbox. `to:${addr}` further
    // narrows to replies sent to a specific contact, so the tone corpus mirrors
    // the voice the user uses with THAT recipient. Gmail `to:` queries the To
    // header and is reliable for this.
    const accessToken = await this.ensureAccessToken()
    const limit = Math.min(query.limit ?? 10, 50)
    const params = new URLSearchParams({ maxResults: String(limit) })
    const q: string[] = ['in:sent']
    if (query.toAddress) q.push(`to:${query.toAddress}`)
    if (query.sinceHours) q.push(`newer_than:${query.sinceHours}h`)
    params.set('q', q.join(' '))
    const ids = await this.gmailGet<{ messages?: Array<{ id: string }> }>(
      accessToken,
      `/users/me/messages?${params}`
    )
    if (!ids.messages) return []
    const out: NormalizedEmail[] = []
    for (const m of ids.messages) out.push(await this.getMessage(m.id))
    return out
  }

  async createDraft(input: EmailDraftInput): Promise<EmailDraft> {
    const accessToken = await this.ensureAccessToken()
    const raw = buildRfc822(input)
    const res = await this.gmailPost<{ id: string; message?: { threadId?: string; id: string } }>(
      accessToken,
      '/users/me/drafts',
      { message: { raw } }
    )
    return {
      id: res.id,
      threadId: res.message?.threadId ?? input.threadId,
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      body: input.body,
      createdAt: nowIso()
    }
  }

  async sendDraft(draftId: string): Promise<EmailSendResult> {
    const accessToken = await this.ensureAccessToken()
    const res = await this.gmailPost<{ id: string }>(
      accessToken,
      '/users/me/drafts/send',
      { id: draftId }
    )
    return { messageId: res.id, sentAt: nowIso() }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async account(): Promise<IntegrationAccount> {
    const t = await this.loadTokens()
    return {
      id: this.accountId,
      provider: 'gmail',
      displayName: 'Gmail',
      email: t?.emailAddress,
      status: 'connected',
      scopes: t?.scope?.split(' ') ?? [],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  private async gmailGet<T>(accessToken: string, path: string): Promise<T> {
    const res = await this.http(`${GMAIL_API}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) throw new Error(`Gmail API ${path} 失败：${res.status}`)
    return (await res.json()) as T
  }

  private async gmailPost<T>(accessToken: string, path: string, body: unknown): Promise<T> {
    const res = await this.http(`${GMAIL_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`Gmail API ${path} 失败：${res.status}`)
    return (await res.json()) as T
  }
}

// ── Gmail message normalization (safe MIME extraction) ──────────────────────
// Exported for unit tests (no network — these are pure transforms).

export interface GmailPayload {
  headers?: Array<{ name: string; value: string }>
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailPayload[]
}

export interface GmailMessageRaw {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  payload?: GmailPayload
  internalDate?: string
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

export function decodeBase64Url(data: string): string {
  // Gmail uses base64url; pad and decode as UTF-8 text.
  const b = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b + '='.repeat((4 - (b.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function extractText(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  // Direct text/plain body.
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  // Walk multipart parts.
  if (payload.parts) {
    let text = ''
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        text += decodeBase64Url(part.body.data)
      }
    }
    if (text) return text
    // Fall back to text/html stripped to text (Spec §17.13: sanitize HTML).
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data))
      }
    }
  }
  // Single text/html body.
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data))
  }
  return ''
}

/** Strip HTML to plain text without executing anything (Spec §17.13). */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseAddresses(raw: string): MailAddress[] {
  if (!raw) return []
  // "Name <a@b.com>, c@d.com"
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.*?)\s*<([^>]+)>$/)
      if (m) return { name: m[1].replace(/^"|"$/g, '') || undefined, address: m[2].trim() }
      return { address: s }
    })
}

export function normalizeGmailMessage(msg: GmailMessageRaw, accountId: string): NormalizedEmail {
  const h = msg.payload?.headers
  const fromRaw = header(h, 'from')
  const from = parseAddresses(fromRaw)[0] ?? { address: fromRaw }
  const subject = header(h, 'subject')
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : header(h, 'date')
      ? new Date(header(h, 'date')).toISOString()
      : nowIso()
  const labelIds = msg.labelIds ?? []
  const body = extractText(msg.payload) || msg.snippet || ''
  // ADR 0023: read the bulk-signal routing headers (provider-local; only the
  // boolean persists on NormalizedEmail — §17) so mass mail is filtered before
  // any LLM pass downstream.
  const bulk = detectBulkFromHeaders((name) => header(h, name))
  return {
    provider: 'gmail',
    accountId,
    messageId: msg.id,
    threadId: msg.threadId,
    from,
    to: parseAddresses(header(h, 'to')),
    cc: parseAddresses(header(h, 'cc')),
    subject,
    textBody: body.slice(0, 200000),
    receivedAt,
    unread: labelIds.includes('UNREAD'),
    labels: labelIds,
    sourceUrl: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
    bulk
  }
}

/** Build a minimal RFC822 message and base64url-encode it for the Gmail API. */
export function buildRfc822(input: EmailDraftInput): string {
  const lines: string[] = []
  lines.push(`To: ${input.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`)
  if (input.cc?.length) {
    lines.push(`Cc: ${input.cc.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`)
  }
  lines.push(`Subject: ${encodeHeader(input.subject)}`)
  if (input.threadId) lines.push(`In-Reply-To: ${input.threadId}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('MIME-Version: 1.0')
  lines.push('')
  lines.push(input.body)
  const raw = lines.join('\r\n')
  return Buffer.from(raw, 'utf8').toString('base64url')
}

function encodeHeader(s: string): string {
  // Encode non-ASCII header values per RFC 2047 (minimal: only if needed).
  // The control-char range here is the ASCII boundary, not a real control char.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(s)) {
    return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
  }
  return s
}
