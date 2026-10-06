// Real 163 Mail Provider (Spec §9) — IMAP (imap.163.com:993) + SMTP
// (smtp.163.com:465), authorized by the mailbox's 授权码 (authorization code,
// NOT the login password — 163 requires a separate code for IMAP/SMTP access).
//
// The email address + 授权码 are credentials stored in the SecretStore
// (safeStorage/Keychain) — never in source, settings.json, logs, or the
// renderer. The renderer only ever sees opaque status + the connected address.
//
// 163 is a domestic (CN) service reachable by direct TCP, so unlike Gmail it
// needs no proxy-aware fetch — imapflow/nodemailer use Node's net/tls which
// connect directly. MIME text is parsed by mailparser (text/plain preferred,
// text/html stripped to text, never executed — Spec §17.12/§17.13).

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
import { newId, nowIso } from '../../util/ids'
import { detectBulkFromHeaders } from '../../util/bulk-mail'
import { buildRfc822Raw, normalizeRfc822ViaParser, type ParsedMailLike } from './mail-mime'

const CLIENT_KEY = 'mail163-client'

export interface Mail163Client {
  email: string
  authCode: string
}

export interface Mail163ProviderDeps {
  secrets: SecretStore
}

const IMAP_HOST = 'imap.163.com'
const IMAP_PORT = 993
const SMTP_HOST = 'smtp.163.com'
const SMTP_PORT = 465

export class Mail163Provider implements EmailProvider {
  readonly provider = 'mail163' as const
  readonly accountId = 'mail163-real'
  /** In-memory store of draftId → RFC822, so sendDraft can SMTP-send it. */
  private drafts = new Map<string, { rfc822: string; to: MailAddress[]; cc: MailAddress[]; subject: string; body: string }>()

  constructor(private readonly deps: Mail163ProviderDeps) {}

  // ── credential storage ─────────────────────────────────────────────────────

  async setClient(email: string, authCode: string): Promise<void> {
    await this.deps.secrets.save(CLIENT_KEY, JSON.stringify({ email, authCode }))
  }

  async hasClient(): Promise<boolean> {
    return this.deps.secrets.has(CLIENT_KEY)
  }

  private async getClient(): Promise<Mail163Client> {
    const raw = await this.deps.secrets.readKey(CLIENT_KEY)
    if (!raw) throw new Error('163 邮箱未配置 —— 请在「集成」中填写邮箱地址 + 授权码。')
    const parsed = JSON.parse(raw) as Mail163Client
    if (!parsed.email || !parsed.authCode) throw new Error('163 邮箱客户端配置无效。')
    return parsed
  }

  // ── EmailProvider interface ─────────────────────────────────────────────────

  async connect(): Promise<IntegrationAccount> {
    // Validate the credentials by actually logging in to IMAP.
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      await imap.status('INBOX', { unseen: true })
    } finally {
      await safeCloseImap(imap)
    }
    return this.account(client)
  }

  async disconnect(): Promise<void> {
    await this.deps.secrets.delete(CLIENT_KEY)
    this.drafts.clear()
  }

  async getStatus(): Promise<IntegrationStatus> {
    const has = await this.hasClient()
    return has ? 'connected' : 'disconnected'
  }

  async getEmailAddress(): Promise<string | undefined> {
    const raw = await this.deps.secrets.readKey(CLIENT_KEY)
    if (!raw) return undefined
    try {
      return (JSON.parse(raw) as Mail163Client).email
    } catch {
      return undefined
    }
  }

  async listMessages(query: EmailQuery): Promise<NormalizedEmail[]> {
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      const lock = await imap.getMailboxLock('INBOX')
      try {
        const search: Record<string, unknown> = {}
        if (query.unreadOnly) search.seen = false
        if (query.sinceHours) {
          // IMAP `since` is date-only (midnight). Fetch by date, filter by hour
          // client-side below.
          search.since = new Date(Date.now() - query.sinceHours * 3600_000)
        }
        let uids = (await imap.search(search, { uid: true })) ?? []
        // Incremental high-water-mark: only messages with UID strictly greater
        // than the last-seen cursor. UIDs are monotonic in 163, so this is the
        // clean "new mail since last sync" filter (avoids re-running the agent
        // on already-processed messages → token cost).
        if (query.sinceUid) {
          uids = uids.filter((u) => Number(u) > query.sinceUid!)
        }
        // Newest first.
        uids = [...uids].sort((a, b) => Number(b) - Number(a))
        if (query.limit) uids = uids.slice(0, query.limit)
        const out: NormalizedEmail[] = []
        for (const uid of uids) {
          const msg = await imap.fetchOne(uid, { source: true, internalDate: true, flags: true }, { uid: true })
          if (!msg || !msg.source) continue
          const parsed = await normalizeRfc822ViaParser(msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source))
          const receivedAt = msg.internalDate ? msg.internalDate.toISOString() : parsed.date?.toISOString() ?? nowIso()
          const unread = msg.flags ? !msg.flags.has('\\Seen') : true
          out.push(toNormalized(parsed, this.accountId, String(uid), receivedAt, unread, msg.flags ? [...msg.flags] : []))
          // 163 sinceHours is hour-precise; filter after parsing.
        }
        // sinceHours is hour-precise; filter after parsing. Capture into a
        // const so the narrowing holds inside the closure.
        const hours = query.sinceHours
        const filtered = hours
          ? out.filter((m) => new Date(m.receivedAt).getTime() >= Date.now() - hours * 3600_000)
          : out
        return filtered
      } finally {
        lock.release()
      }
    } finally {
      await safeCloseImap(imap)
    }
  }

  /** ADR 0027 — cold-start backfill: all mail newer than `sinceDate` (newest-
   *  first). 163's IMAP search + the client-side sinceHours filter already do
   *  the job, so this just widens `listMessages` to the requested window + cap. */
  async listBackfill(sinceDate: Date, maxItems = 2000): Promise<NormalizedEmail[]> {
    const sinceHours = Math.max(1, Math.ceil((Date.now() - sinceDate.getTime()) / 3600_000))
    return this.listMessages({ sinceHours, limit: maxItems })
  }

  async getMessage(messageId: string): Promise<NormalizedEmail> {
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      const lock = await imap.getMailboxLock('INBOX')
      try {
        const msg = await imap.fetchOne(Number(messageId), { source: true, internalDate: true, flags: true }, { uid: true })
        if (!msg || !msg.source) throw new Error(`163 未找到邮件：${messageId}`)
        const parsed = await normalizeRfc822ViaParser(msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source))
        const receivedAt = msg.internalDate ? msg.internalDate.toISOString() : parsed.date?.toISOString() ?? nowIso()
        const unread = msg.flags ? !msg.flags.has('\\Seen') : true
        return toNormalized(parsed, this.accountId, messageId, receivedAt, unread, msg.flags ? [...msg.flags] : [])
      } finally {
        lock.release()
      }
    } finally {
      await safeCloseImap(imap)
    }
  }

  /** ADR 0029 — best-effort thread fetch for 163. The synthesized `threadId` is
   *  the conversation ROOT's Message-ID (first References token, or the
   *  message's own Message-ID for the root). Replies carry the root in their
   *  References header; the root carries it in Message-Id. So searching both
   *  headers for the thread key + de-duping UIDs recovers the thread. IMAP
   *  header-substring search is unreliable on 163 → on any error / empty
   *  result, return [] (the 必读 expand falls back to surfaced sourceRefs).
   *  Never throws. R0 read-only; never persisted. */
  async getThread(threadId: string): Promise<NormalizedEmail[]> {
    if (!threadId) return []
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      const lock = await imap.getMailboxLock('INBOX')
      try {
        const uidSets = [
          await safeSearch(imap, { header: ['references', threadId] }),
          await safeSearch(imap, { header: ['in-reply-to', threadId] }),
          await safeSearch(imap, { header: ['message-id', threadId] })
        ]
        const uids = [...new Set(uidSets.flat().map((u) => Number(u)))].sort((a, b) => a - b)
        if (uids.length === 0) return []
        const out: NormalizedEmail[] = []
        for (const uid of uids) {
          const msg = await imap.fetchOne(uid, { source: true, internalDate: true, flags: true }, { uid: true })
          if (!msg || !msg.source) continue
          const parsed = await normalizeRfc822ViaParser(msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source))
          const receivedAt = msg.internalDate ? msg.internalDate.toISOString() : parsed.date?.toISOString() ?? nowIso()
          const unread = msg.flags ? !msg.flags.has('\\Seen') : true
          out.push(toNormalized(parsed, this.accountId, String(uid), receivedAt, unread, msg.flags ? [...msg.flags] : []))
        }
        // Oldest first (internalDate ascending).
        out.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
        return out
      } finally {
        lock.release()
      }
    } catch {
      return [] // best-effort — never surface a 163 IMAP error to the 必读 page
    } finally {
      await safeCloseImap(imap)
    }
  }

  async searchMessages(query: string, limit?: number): Promise<NormalizedEmail[]> {
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      const lock = await imap.getMailboxLock('INBOX')
      try {
        // IMAP SEARCH doesn't do body search well on 163; search subject/from.
        let uids = (await imap.search({ subject: query }, { uid: true })) ?? []
        if (limit) uids = uids.slice(0, limit)
        const out: NormalizedEmail[] = []
        for (const uid of uids) {
          const msg = await imap.fetchOne(uid, { source: true, internalDate: true, flags: true }, { uid: true })
          if (!msg || !msg.source) continue
          const parsed = await normalizeRfc822ViaParser(msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source))
          const receivedAt = msg.internalDate ? msg.internalDate.toISOString() : parsed.date?.toISOString() ?? nowIso()
          const unread = msg.flags ? !msg.flags.has('\\Seen') : true
          out.push(toNormalized(parsed, this.accountId, String(uid), receivedAt, unread, msg.flags ? [...msg.flags] : []))
        }
        return out
      } finally {
        lock.release()
      }
    } finally {
      await safeCloseImap(imap)
    }
  }

  async listSent(query: SentMailQuery): Promise<NormalizedEmail[]> {
    // Sent mail is the user's own voice — the prior-reply tone corpus (Spec
    // §13.5). The Sent mailbox is locale-dependent on 163: special-use `\\Sent`
    // is historically unreliable, so we probe localized name fallbacks when it
    // isn't advertised. `to:` narrows the corpus to replies sent to a specific
    // contact so the tone mirrors the voice used with THAT recipient.
    const client = await this.getClient()
    const imap = await this.openImap(client)
    try {
      const sentBox = await this.findSentMailbox(imap)
      if (!sentBox) return []
      const lock = await imap.getMailboxLock(sentBox)
      try {
        const search: Record<string, unknown> = {}
        if (query.toAddress) search.to = query.toAddress
        if (query.sinceHours) {
          search.since = new Date(Date.now() - query.sinceHours * 3600_000)
        }
        let uids = (await imap.search(search, { uid: true })) ?? []
        uids = [...uids].sort((a, b) => Number(b) - Number(a))
        if (query.limit) uids = uids.slice(0, query.limit)
        const out: NormalizedEmail[] = []
        for (const uid of uids) {
          const msg = await imap.fetchOne(uid, { source: true, internalDate: true, flags: true }, { uid: true })
          if (!msg || !msg.source) continue
          const parsed = await normalizeRfc822ViaParser(msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source))
          const receivedAt = msg.internalDate ? msg.internalDate.toISOString() : parsed.date?.toISOString() ?? nowIso()
          // Sent mail is the user's own — `unread` is meaningless here; mark read.
          out.push(toNormalized(parsed, this.accountId, String(uid), receivedAt, false, msg.flags ? [...msg.flags] : []))
        }
        const hours = query.sinceHours
        return hours ? out.filter((m) => new Date(m.receivedAt).getTime() >= Date.now() - hours * 3600_000) : out
      } finally {
        lock.release()
      }
    } finally {
      await safeCloseImap(imap)
    }
  }

  async createDraft(input: EmailDraftInput): Promise<EmailDraft> {
    const client = await this.getClient()
    const rfc822 = buildRfc822Raw(input)
    // APPEND to the mailbox flagged \\Drafts (locale-independent). Find it by
    // special-use so we don't hardcode a localized folder name.
    const imap = await this.openImap(client)
    try {
      const draftBox = await this.findSpecialMailbox(imap, '\\Drafts')
      const buf = Buffer.from(rfc822, 'utf8')
      if (draftBox) {
        await imap.append(draftBox, buf, ['\\Draft'])
      }
      // If no Drafts mailbox found, we still return a draft object (the send
      // path is SMTP; the persisted draft is best-effort on 163).
    } finally {
      await safeCloseImap(imap)
    }
    const draftId = newId('draft')
    this.drafts.set(draftId, {
      rfc822,
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      body: input.body
    })
    return {
      id: draftId,
      threadId: input.threadId,
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      body: input.body,
      createdAt: nowIso()
    }
  }

  async sendDraft(draftId: string): Promise<EmailSendResult> {
    const stored = this.drafts.get(draftId)
    if (!stored) throw new Error(`163 未找到草稿：${draftId}（草稿存于内存；请先创建再发送）`)
    const client = await this.getClient()
    const { createTransport } = await import('nodemailer')
    const transporter = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true,
      auth: { user: client.email, pass: client.authCode }
    })
    const info = await transporter.sendMail({
      from: client.email,
      to: stored.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      cc: stored.cc.length ? stored.cc.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ') : undefined,
      raw: stored.rfc822 // send the exact RFC822 we built (content immutability)
    })
    this.drafts.delete(draftId)
    return { messageId: info.messageId, sentAt: nowIso() }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async account(client: Mail163Client): Promise<IntegrationAccount> {
    return {
      id: this.accountId,
      provider: 'mail163',
      displayName: '163 Mail',
      email: client.email,
      status: 'connected',
      scopes: ['imap.read', 'smtp.send'],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  private async openImap(client: Mail163Client): Promise<ImapFlowLike> {
    const { ImapFlow } = await import('imapflow')
    const imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: client.email, pass: client.authCode },
      logger: false,
      socketTimeout: 30_000,
      connectionTimeout: 15_000
    })
    // Crucial: attach error listener so unhandled socket drops/timeouts (e.g. Socket timeout, ECONNRESET)
    // are caught here instead of causing unhandled exceptions in the Node/Electron main process.
    imap.on('error', (err: Error) => {
      console.warn('[mail163] IMAP socket notice:', err?.message || String(err))
    })
    await imap.connect()
    return imap as unknown as ImapFlowLike
  }

  private async findSpecialMailbox(imap: ImapFlowLike, specialUse: string): Promise<string | undefined> {
    const boxes = await imap.list()
    for (const b of boxes) {
      if (b.specialUse?.includes(specialUse)) return b.path
    }
    return undefined
  }

  /**
   * Locate the Sent mailbox. 163 is historically unreliable about advertising
   * `\\Sent` special-use, so after the special-use probe fails we fall back to
   * localized name probing via `mailboxExists` (locale-independent: works
   * whether the folder is 已发送 / Sent / Sent Items / 发件箱).
   */
  private async findSentMailbox(imap: ImapFlowLike): Promise<string | undefined> {
    const bySpecialUse = await this.findSpecialMailbox(imap, '\\Sent')
    if (bySpecialUse) return bySpecialUse
    const fallbacks = ['已发送', 'Sent', 'Sent Items', '发件箱']
    for (const name of fallbacks) {
      if (await imap.mailboxExists(name)) return name
    }
    return undefined
  }
}

/** Safely disconnect and close an IMAP session without throwing unhandled socket reset errors. */
async function safeCloseImap(imap: ImapFlowLike): Promise<void> {
  try {
    await imap.logout()
  } catch {
    try {
      imap.close()
    } catch {
      /* ignore */
    }
  }
}

// ── minimal typed surface of imapflow / mailparser (kept loose to avoid
//    importing the ESM/CJS shape at type-check time; we dynamic-import at run).

interface ImapFlowLike {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  status(path: string, query: Record<string, unknown>): Promise<unknown>
  getMailboxLock(path: string): Promise<{ release: () => Promise<void> }>
  search(query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[]>
  fetchOne(
    uid: number,
    fields: { source?: boolean; internalDate?: boolean; flags?: boolean },
    opts?: { uid?: boolean }
  ): Promise<{
    source?: Buffer | string
    internalDate?: Date
    flags?: Set<string>
  } | null>
  append(path: string, content: Buffer, flags?: string[]): Promise<void>
  list(): Promise<Array<{ path: string; specialUse?: string[] }>>
  mailboxExists(path: string): Promise<boolean>
}

/** Map a mailparser-parsed message to the normalized domain type. */
function toNormalized(
  parsed: ParsedMailLike,
  accountId: string,
  uid: string,
  receivedAt: string,
  unread: boolean,
  flags: string[]
): NormalizedEmail {
  const from = parsed.from.value?.[0] ? toAddress(parsed.from.value[0]) : { address: parsed.from.text ?? '' }
  // ADR 0023: compute the bulk flag from routing headers (provider-local;
  // only the boolean persists — §17) so mass mail is filtered pre-LLM.
  const bulk = detectBulkFromHeaders((name) => parsed.headers?.get(name) ?? '')
  // ADR 0029 — synthesize a thread key from RFC822 threading headers so 163
  // emails in the same conversation collapse into one 必读 item. References is
  // a space-separated list of angle-bracket ids; the FIRST is the thread root
  // (same for every reply). Fall back to In-Reply-To, then the message's own
  // Message-ID (the root itself has no References). mailparser parses these
  // headers; `toNormalized` previously discarded them.
  const threadId = synthesizeThreadId(parsed)
  return {
    provider: 'mail163',
    accountId,
    messageId: uid,
    threadId,
    from,
    to: (parsed.to?.value ?? []).map(toAddress),
    cc: (parsed.cc?.value ?? []).map(toAddress),
    subject: parsed.subject ?? '',
    textBody: (parsed.text ?? '').slice(0, 200000),
    receivedAt,
    unread,
    labels: flags,
    sourceUrl: `https://mail.163.com/`,
    bulk
  }
}

/** Extract the first `<...>` angle-bracket token from a References /
 *  In-Reply-To header value (may contain several ids). Returns the bare id
 *  without angle brackets, or undefined if none. Exported for unit tests.
 *  Coerces mailparser's `.get()` which can return a non-string (array) for
 *  list-valued headers. */
export function firstAngleToken(headerVal: unknown): string | undefined {
  if (!headerVal) return undefined
  const s = Array.isArray(headerVal) ? headerVal.join(' ') : String(headerVal)
  const m = s.match(/<([^>]+)>/)
  return m ? m[1] : undefined
}

/** Best-effort IMAP header search that never throws — 163's IMAP header search
 *  is unreliable, so a thrown error just yields an empty UID set (the thread
 *  fetch degrades to surfaced-only). */
async function safeSearch(imap: ImapFlowLike, query: Record<string, unknown>): Promise<number[]> {
  try {
    const r = await imap.search(query, { uid: true })
    return r ?? []
  } catch {
    return []
  }
}

/** ADR 0029 — synthesize a 163 thread key. Prefer the first References token
 *  (the conversation root, shared by every reply); fall back to In-Reply-To;
 *  fall back to the message's own Message-ID (the root message has neither).
 *  The messageId fallback ALSO strips angle brackets so the root's key matches
 *  the bare id every reply references (mailparser returns Message-Id WITH
 *  brackets; References/In-Reply-To tokens are extracted WITHOUT). Exported
 *  for unit tests (pure function over parsed headers). */
export function synthesizeThreadId(parsed: ParsedMailLike): string | undefined {
  const fromRefs = firstAngleToken(parsed.headers?.get('references'))
  if (fromRefs) return fromRefs
  const fromIrt = firstAngleToken(parsed.headers?.get('in-reply-to'))
  if (fromIrt) return fromIrt
  const mid = parsed.messageId
  if (!mid) return undefined
  return firstAngleToken(mid) ?? mid
}

function toAddress(v: { name?: string; address?: string }): MailAddress {
  return { name: v.name || undefined, address: v.address ?? '' }
}
