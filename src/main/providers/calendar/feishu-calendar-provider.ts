// Real Feishu Calendar Provider (Spec §10). User-OAuth (user_access_token) so
// the agent reads the user's PRIMARY calendar — needed for real Meeting Prep
// (§13.3) and Daily Work Summary (§13.4). App credentials (app_id/app_secret)
// and the user refresh token are stored in the SecretStore (safeStorage/
// Keychain), never in source/settings/log/renderer.
//
// open.feishu.cn is domestic (CN) — reachable without a proxy — but HTTP calls
// take an injectable `FeishuFetch` (prod passes Electron `net.fetch`, tests pass
// Node global `fetch`) to stay consistent with the Gmail provider and survive a
// proxy that touches it.
//
// P0 scope is READ only (list/get). create/update are R2 writes deferred to a
// later pass (Spec §2 / M3 decision) — they throw here, never silently no-op.

import type {
  IntegrationAccount,
  IntegrationStatus,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  DateRange,
  MailAddress
} from '@shared/types'
import type { CalendarProvider } from './calendar-provider'
import type { SecretStore } from '../../util/secrets'
import { nowIso } from '../../util/ids'
import {
  type FeishuClient,
  type FeishuFetch,
  type FeishuUserTokens,
  authorizeUrl,
  exchangeCode,
  refreshUserToken,
  startCallbackServer,
  newState,
  FEISHU_BASE
} from './feishu-oauth'

const CLIENT_KEY = 'feishu-client'
const USER_TOKENS_KEY = 'feishu-user-tokens'

const NOT_CONFIGURED =
  '飞书日历未配置 —— 请在「集成」中填写 app_id/app_secret 并连接。'

export interface FeishuCalendarProviderDeps {
  secrets: SecretStore
  openExternal: (url: string) => Promise<void> | void
  fetch?: FeishuFetch
}

type FeishuUserTokensStored = FeishuUserTokens

export class FeishuCalendarProvider implements CalendarProvider {
  readonly provider = 'feishu' as const
  readonly accountId = 'feishu-real'
  /** In-memory access-token cache (refresh token is persisted). */
  private cached: FeishuUserTokens | undefined
  /** Cached primary calendar_id (the user's main calendar). */
  private primaryCalendarId: string | undefined

  constructor(private readonly deps: FeishuCalendarProviderDeps) {}

  private get http(): FeishuFetch {
    return this.deps.fetch ?? globalThis.fetch
  }

  // ── credential storage ─────────────────────────────────────────────────────

  async setClient(appId: string, appSecret: string): Promise<void> {
    await this.deps.secrets.save(CLIENT_KEY, JSON.stringify({ appId, appSecret }))
  }

  async hasClient(): Promise<boolean> {
    return this.deps.secrets.has(CLIENT_KEY)
  }

  private async getClient(): Promise<FeishuClient> {
    const raw = await this.deps.secrets.readKey(CLIENT_KEY)
    if (!raw) throw new Error(NOT_CONFIGURED)
    const parsed = JSON.parse(raw) as FeishuClient
    if (!parsed.appId || !parsed.appSecret) throw new Error('飞书客户端配置无效。')
    return parsed
  }

  private async loadStoredUserTokens(): Promise<FeishuUserTokensStored | undefined> {
    const raw = await this.deps.secrets.readKey(USER_TOKENS_KEY)
    if (!raw) return undefined
    try {
      const t = JSON.parse(raw) as FeishuUserTokensStored
      if (!t.accessToken || !t.refreshToken || !t.expiresAt) return undefined
      return t
    } catch {
      return undefined
    }
  }

  private async saveUserTokens(t: FeishuUserTokens): Promise<void> {
    this.cached = t
    await this.deps.secrets.save(USER_TOKENS_KEY, JSON.stringify(t))
  }

  // ── CalendarProvider interface ─────────────────────────────────────────────

  async connect(): Promise<IntegrationAccount> {
    const client = await this.getClient()
    const state = newState()
    const cb = await startCallbackServer(state)
    try {
      await this.deps.openExternal(authorizeUrl(client, state))
      const { code } = await cb.waitForCode()
      const tokens = await exchangeCode(client, code, this.http)
      await this.saveUserTokens(tokens)
    } finally {
      cb.close()
    }
    return this.account()
  }

  async disconnect(): Promise<void> {
    await this.deps.secrets.delete(USER_TOKENS_KEY)
    await this.deps.secrets.delete(CLIENT_KEY)
    this.cached = undefined
    this.primaryCalendarId = undefined
  }

  async getStatus(): Promise<IntegrationStatus> {
    const hasClient = await this.hasClient()
    const hasTokens = !!(await this.loadStoredUserTokens())
    return hasClient && hasTokens ? 'connected' : 'disconnected'
  }

  async listEvents(range: DateRange): Promise<CalendarEvent[]> {
    const client = await this.getClient()
    const token = await this.ensureUserToken(client)
    const calendarId = await this.ensurePrimaryCalendarId(token)
    const startSec = Math.floor(new Date(range.start).getTime() / 1000)
    const endSec = Math.floor(new Date(range.end).getTime() / 1000)
    const events = await this.listEventsPaged(token, calendarId, startSec, endSec)
    return events.map((e) => this.normalizeEvent(e, calendarId))
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    // eventId is the composite `calendarId:eventId` we emit in listEvents.
    const [calendarId, realEventId] = eventId.split(':')
    if (!calendarId || !realEventId) throw new Error(`飞书事件 id 格式错误：${eventId}`)
    const client = await this.getClient()
    const token = await this.ensureUserToken(client)
    const res = await this.http(
      `${FEISHU_BASE}/open-apis/calendar/v6/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(realEventId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const json = (await res.json()) as { code?: number; msg?: string; data?: { event?: FeishuEvent } }
    if (json.code !== 0 || !json.data?.event) {
      throw new Error(`飞书获取事件失败：${json.msg ?? JSON.stringify(json)}`)
    }
    return this.normalizeEvent(json.data.event, calendarId)
  }

  async createEvent(_input: CalendarEventInput): Promise<CalendarEvent> {
    throw new Error('飞书 createEvent 属于 R2（写入）—— 已推迟（spec §2 / M3）。本轮未启用。')
  }

  async updateEvent(_eventId: string, _input: CalendarEventPatch): Promise<CalendarEvent> {
    throw new Error('飞书 updateEvent 属于 R2（写入）—— 已推迟（spec §2 / M3）。本轮未启用。')
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private account(): IntegrationAccount {
    return {
      id: this.accountId,
      provider: 'feishu',
      displayName: 'Feishu Calendar',
      status: 'connected',
      scopes: ['calendar.read'],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  /** Return a valid user access token, refreshing (and persisting) if needed. */
  private async ensureUserToken(client: FeishuClient): Promise<string> {
    // Refresh ~60s early to avoid edge expiry.
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) {
      return this.cached.accessToken
    }
    const stored = this.cached ?? (await this.loadStoredUserTokens())
    if (stored && stored.expiresAt > Date.now() + 60_000) {
      this.cached = stored
      return stored.accessToken
    }
    if (!stored) throw new Error('飞书未连接 —— 请在「集成」中执行连接。')
    const refreshed = await refreshUserToken(client, stored.refreshToken, this.http)
    await this.saveUserTokens(refreshed)
    return refreshed.accessToken
  }

  /** Resolve + cache the user's primary calendar id. */
  private async ensurePrimaryCalendarId(token: string): Promise<string> {
    if (this.primaryCalendarId) return this.primaryCalendarId
    // List the user's calendars and pick the primary one. Feishu marks it with
    // `is_primary: true` (or type 'primary'); fall back to the first calendar.
    const res = await this.http(`${FEISHU_BASE}/open-apis/calendar/v6/calendars`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { calendar_list?: FeishuCalendar[] }
    }
    if (json.code !== 0) {
      throw new Error(`飞书列出日历失败：${json.msg ?? JSON.stringify(json)}`)
    }
    const list = json.data?.calendar_list ?? []
    const primary = list.find((c) => c.is_primary) ?? list.find((c) => c.type === 'primary') ?? list[0]
    if (!primary?.calendar_id) {
      throw new Error('飞书：该账号没有可访问的日历。')
    }
    this.primaryCalendarId = primary.calendar_id
    return this.primaryCalendarId
  }

  /** Page through list-events (Feishu caps page_size at 50). */
  private async listEventsPaged(
    token: string,
    calendarId: string,
    startSec: number,
    endSec: number
  ): Promise<FeishuEvent[]> {
    const out: FeishuEvent[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        start_time: String(startSec),
        end_time: String(endSec),
        page_size: '50'
      })
      if (pageToken) params.set('page_token', pageToken)
      const res = await this.http(
        `${FEISHU_BASE}/open-apis/calendar/v6/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const json = (await res.json()) as {
        code?: number
        msg?: string
        data?: { items?: FeishuEvent[]; page_token?: string; has_more?: boolean }
      }
      if (json.code !== 0) {
        throw new Error(`飞书列出事件失败：${json.msg ?? JSON.stringify(json)}`)
      }
      out.push(...(json.data?.items ?? []))
      pageToken = json.data?.has_more ? json.data?.page_token : undefined
    } while (pageToken)
    return out
  }

  private normalizeEvent(e: FeishuEvent, calendarId: string): CalendarEvent {
    const startMs = e.start?.timestamp ? Number(e.start.timestamp) * 1000 : Date.now()
    const endMs = e.end?.timestamp ? Number(e.end.timestamp) * 1000 : startMs
    const attendees: MailAddress[] = (e.attendees ?? [])
      .filter((a) => a.email || a.display_name)
      .map((a) => ({ name: a.display_name || undefined, address: a.email ?? '' }))
    return {
      provider: 'feishu',
      accountId: this.accountId,
      // Composite id so getEvent can recover the calendar_id without extra
      // state (the tool registry / scheduler only ever passes eventId through).
      eventId: `${calendarId}:${e.event_id ?? e.iCal_uid ?? 'unknown'}`,
      title: e.summary ?? '(no title)',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      location: e.location?.name,
      attendees,
      description: e.description ?? undefined,
      sourceUrl: undefined
    }
  }
}

// ── minimal typed surface of Feishu calendar API responses ───────────────────

interface FeishuCalendar {
  calendar_id?: string
  summary?: string
  type?: string
  is_primary?: boolean
}

interface FeishuEvent {
  event_id?: string
  iCal_uid?: string
  summary?: string
  description?: string
  start?: { timestamp?: string | number }
  end?: { timestamp?: string | number }
  location?: { name?: string }
  attendees?: Array<{ display_name?: string; email?: string }>
}
