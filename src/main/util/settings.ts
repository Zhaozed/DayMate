// Plain (non-secret) application settings, persisted as JSON under
// `app.getPath('userData')`. Only NON-SECRET values live here — the LLM API
// key is in the SecretStore (encrypted). The renderer reads this shape via
// `getLlmConfig()` which augments it with a `keyConfigured` flag (never the
// key itself) (Spec §17.8).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { LLM_PROVIDERS, DEFAULT_LLM_MODEL_IDS } from '@shared/constants'
import type {
  LlmProvider,
  JobSearchSettings,
  NotificationPrefs,
  BirthData,
  EmailSyncCursor,
  WeatherBriefing,
  TodoSettings
} from '@shared/types'

export type {
  JobSearchSettings,
  NotificationPrefs,
  BirthData,
  EmailSyncCursor,
  WeatherBriefing,
  TodoSettings
} from '@shared/types'

/** Non-secret email-sync config (Milestone: 邮件驱动求职汇总). `cursor` is the
 *  per-provider high-water-mark so the poll only classifies NEW mail. */
export interface EmailSyncSettings {
  enabled?: boolean
  intervalSec?: number
  cursor?: EmailSyncCursor
}

export interface LlmSettings {
  provider: LlmProvider
  modelId: string
}

export interface AppSettings {
  llm: LlmSettings
  jobSearch?: JobSearchSettings
  /** Non-secret notification preferences (Milestone D §D2). */
  notifications?: NotificationPrefs
  /** Non-secret birth data for the daily 运势 (Milestone E). Trusted §17 —
   *  the user's own config (not a credential, not external untrusted text). */
  birthData?: BirthData
  /** Non-secret email-sync poll config + incremental cursor (邮件驱动求职汇总). */
  emailSync?: EmailSyncSettings
  /** Non-secret weather briefing cache for the Home 今日天气 card (ADR 0026).
   *  Generated daily (real wttr.in + LLM-polished copy); `date` detects staleness. */
  weather?: WeatherBriefing
  /** Non-secret weather city (default 北京). ADR 0026. */
  weatherCity?: string
  /** Non-secret ToDo pipeline settings (ADR 0027 — ToDo 重构): cold-start
   *  backfill state, school-spam skip tokens, kill switch. */
  todo?: TodoSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    provider: 'anthropic',
    modelId: DEFAULT_LLM_MODEL_IDS.anthropic
  }
}

export class Settings {
  private cached: AppSettings | undefined

  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    if (this.cached) return this.cached
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.cached = normalize(parsed)
    } catch {
      this.cached = { ...DEFAULT_SETTINGS }
    }
    return this.cached
  }

  async readLlm(): Promise<LlmSettings> {
    return (await this.read()).llm
  }

  async readJobSearch(): Promise<JobSearchSettings> {
    return (await this.read()).jobSearch ?? {}
  }

  async writeJobSearch(jobSearch: JobSearchSettings): Promise<JobSearchSettings> {
    const current = await this.read()
    const next: AppSettings = { ...current, jobSearch }
    await this.persist(next)
    this.cached = next
    return next.jobSearch!
  }

  /** ADR 0027 — ToDo pipeline settings (cold-start state, skip tokens, switch). */
  async readTodo(): Promise<TodoSettings> {
    return (await this.read()).todo ?? {}
  }

  async writeTodo(todo: TodoSettings): Promise<TodoSettings> {
    const current = await this.read()
    // ADR 0027 — MERGE at the field level, not replace. The boot purge IIFE
    // (writes purgeDone/skipTokens) and the cold-start trigger (writes
    // coldStartDone) are both fire-and-forget async writers; a replace would
    // let one clobber the other's keys (observed: coldStartDone overwrote
 // purgeDone → every restart re-purged → email ToDos vanished after the
 // 2nd boot because cold-start wouldn't re-run). Merge keeps every key the
 // caller didn't touch.
    const merged: TodoSettings = { ...(current.todo ?? {}), ...todo }
    const next: AppSettings = { ...current, todo: merged }
    await this.persist(next)
    this.cached = next
    return next.todo!
  }

  async readNotifications(): Promise<NotificationPrefs> {
    return (await this.read()).notifications ?? {}
  }

  async writeNotifications(prefs: NotificationPrefs): Promise<NotificationPrefs> {
    const current = await this.read()
    const next: AppSettings = { ...current, notifications: prefs }
    await this.persist(next)
    this.cached = next
    return next.notifications!
  }

  async readBirthData(): Promise<BirthData | undefined> {
    return (await this.read()).birthData
  }

  async writeBirthData(birth: BirthData): Promise<BirthData> {
    const current = await this.read()
    const next: AppSettings = { ...current, birthData: birth }
    await this.persist(next)
    this.cached = next
    return next.birthData!
  }

  async clearBirthData(): Promise<void> {
    const current = await this.read()
    if (!current.birthData) return
    const next: AppSettings = { ...current }
    delete next.birthData
    await this.persist(next)
    this.cached = next
  }

  /** Today's weather briefing cache (null = not generated yet / stale). ADR 0026. */
  async readWeatherCache(): Promise<WeatherBriefing | undefined> {
    return (await this.read()).weather
  }

  async writeWeatherCache(weather: WeatherBriefing): Promise<WeatherBriefing> {
    const current = await this.read()
    const next: AppSettings = { ...current, weather }
    await this.persist(next)
    this.cached = next
    return next.weather!
  }

  /** Weather city for wttr.in (default 北京). ADR 0026. */
  async readWeatherCity(): Promise<string> {
    return (await this.read()).weatherCity ?? '北京'
  }

  async writeWeatherCity(city: string): Promise<string> {
    const current = await this.read()
    const next: AppSettings = { ...current, weatherCity: city }
    await this.persist(next)
    this.cached = next
    return next.weatherCity!
  }

  /** Email-sync poll config (enabled / interval) with defaults applied. */
  async readEmailSyncConfig(): Promise<{ enabled: boolean; intervalSec: number }> {
    const es = (await this.read()).emailSync
    return {
      enabled: es?.enabled !== false,
      intervalSec: Number.isFinite(es?.intervalSec) && es!.intervalSec! >= 60
        ? es!.intervalSec!
        : 180
    }
  }

  async readEmailSyncCursor(): Promise<EmailSyncCursor> {
    return (await this.read()).emailSync?.cursor ?? {}
  }

  /** Merge the advanced cursor into the persisted email-sync block (only touches
   *  `cursor`; `enabled`/`intervalSec` preserved). Called after each poll. */
  async writeEmailSyncCursor(cursor: EmailSyncCursor): Promise<EmailSyncCursor> {
    const current = await this.read()
    const next: AppSettings = {
      ...current,
      emailSync: { ...(current.emailSync ?? {}), cursor }
    }
    await this.persist(next)
    this.cached = next
    return next.emailSync!.cursor!
  }

  /**
   * Read the base resume file content (trusted §17 — the user's own document).
   * Returns undefined when no path is configured or the file is unreadable;
   * the resume-generation agent step then runs without a base resume (the stub
   * produces a scaffold either way). Never throws — a missing base resume is a
   * soft degradation, not a run failure.
   */
  async readBaseResumeContent(): Promise<string | undefined> {
    const { baseResumePath } = await this.readJobSearch()
    if (!baseResumePath) return undefined
    try {
      return await readFile(baseResumePath, 'utf8')
    } catch {
      return undefined
    }
  }

  async writeLlm(llm: LlmSettings): Promise<LlmSettings> {
    const current = await this.read()
    const next: AppSettings = { ...current, llm }
    await this.persist(next)
    this.cached = next
    return next.llm
  }

  private async persist(settings: AppSettings): Promise<void> {
    if (!existsSync(dirname(this.filePath))) {
      await mkdir(dirname(this.filePath), { recursive: true })
    }
    await writeFile(this.filePath, JSON.stringify(settings, null, 2), 'utf8')
  }
}

/** Coerce a parsed (possibly partial) object into a valid AppSettings. */
function normalize(parsed: Partial<AppSettings> | null | undefined): AppSettings {
  const llm = parsed?.llm
  const valid = LLM_PROVIDERS as readonly string[]
  const provider: LlmProvider =
    llm?.provider && valid.includes(llm.provider) ? (llm.provider as LlmProvider) : 'anthropic'
  const modelId =
    typeof llm?.modelId === 'string' && llm.modelId.length > 0
      ? llm.modelId
      : DEFAULT_LLM_MODEL_IDS[provider]
  // Preserve a valid-shape jobSearch block if present (both paths optional,
  // string-valued). Partial/missing → omitted (defaults apply downstream).
  const js = parsed?.jobSearch
  const jobSearch: JobSearchSettings | undefined =
    js && (typeof js.baseResumePath === 'string' || typeof js.transcriptTemplatePath === 'string')
      ? {
          ...(typeof js.baseResumePath === 'string' ? { baseResumePath: js.baseResumePath } : {}),
          ...(typeof js.transcriptTemplatePath === 'string'
            ? { transcriptTemplatePath: js.transcriptTemplatePath }
            : {})
        }
      : undefined
  const notifications = normalizeNotifications(parsed?.notifications)
  const birth = normalizeBirthData(parsed?.birthData)
  const emailSync = normalizeEmailSync(parsed?.emailSync)
  const weather = normalizeWeather(parsed?.weather)
  const weatherCity =
    typeof parsed?.weatherCity === 'string' && parsed.weatherCity.trim().length > 0
      ? parsed.weatherCity.trim()
      : undefined
  const todo = normalizeTodo(parsed?.todo)
  return {
    llm: { provider, modelId },
    ...(jobSearch ? { jobSearch } : {}),
    ...(notifications ? { notifications } : {}),
    ...(birth ? { birthData: birth } : {}),
    ...(emailSync ? { emailSync } : {}),
    ...(weather ? { weather } : {}),
    ...(weatherCity ? { weatherCity } : {}),
    ...(todo ? { todo } : {})
  }
}

/** Coerce a parsed ToDo block into a valid shape (ADR 0027). Drops junk rather
 *  than throwing — a bad block just means defaults apply downstream. */
function normalizeTodo(t: unknown): TodoSettings | undefined {
  if (!t || typeof t !== 'object') return undefined
  const raw = t as Record<string, unknown>
  const out: TodoSettings = {}
  if (typeof raw.purgeDone === 'boolean') out.purgeDone = raw.purgeDone
  if (Number.isFinite(raw.purgeVersion) && (raw.purgeVersion as number) >= 0) {
    out.purgeVersion = raw.purgeVersion as number
  }
  if (Array.isArray(raw.coldStartDone)) {
    out.coldStartDone = (raw.coldStartDone as unknown[]).filter(
      (s): s is string => typeof s === 'string'
    )
  }
  if (Array.isArray(raw.skipTokens)) {
    out.skipTokens = (raw.skipTokens as unknown[]).filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    )
  }
  if (typeof raw.coldStartEnabled === 'boolean') out.coldStartEnabled = raw.coldStartEnabled
  if (
    Number.isFinite(raw.backfillBatchSize) &&
    (raw.backfillBatchSize as number) >= 5 &&
    (raw.backfillBatchSize as number) <= 100
  ) {
    out.backfillBatchSize = raw.backfillBatchSize as number
  }
  if (typeof raw.demoSeeded === 'boolean') out.demoSeeded = raw.demoSeeded
  return Object.keys(out).length ? out : undefined
}

/** Coerce a parsed email-sync block into a valid shape. Drops non-numeric
 *  cursors / intervals rather than throwing — a bad cursor just means the next
 *  sync re-scans from zero (idempotent via `sourceRef`, never duplicates). */
function normalizeEmailSync(e: unknown): EmailSyncSettings | undefined {
  if (!e || typeof e !== 'object') return undefined
  const raw = e as Record<string, unknown>
  const out: EmailSyncSettings = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (Number.isFinite(raw.intervalSec) && (raw.intervalSec as number) >= 60) {
    out.intervalSec = raw.intervalSec as number
  }
  const c = raw.cursor
  if (c && typeof c === 'object') {
    const cursor: EmailSyncCursor = {}
    const m163 = (c as Record<string, unknown>).mail163LastUid
    const gmail = (c as Record<string, unknown>).gmailLastInternalDate
    if (Number.isFinite(m163)) cursor.mail163LastUid = m163 as number
    if (Number.isFinite(gmail)) cursor.gmailLastInternalDate = gmail as number
    if (Object.keys(cursor).length) out.cursor = cursor
  }
  return Object.keys(out).length ? out : undefined
}

/** Coerce a parsed weather-briefing block into a valid `WeatherBriefing`. Drops
 *  a malformed cache (the Home card then shows "not generated yet" + a button). */
function normalizeWeather(w: unknown): WeatherBriefing | undefined {
  if (!w || typeof w !== 'object') return undefined
  const raw = w as Record<string, unknown>
  if (
    typeof raw.date !== 'string' ||
    typeof raw.city !== 'string' ||
    typeof raw.tempText !== 'string' ||
    typeof raw.summary !== 'string' ||
    typeof raw.clothing !== 'string' ||
    !Array.isArray(raw.yi) ||
    !Array.isArray(raw.ji)
  ) {
    return undefined
  }
  return {
    date: raw.date,
    city: raw.city,
    tempText: raw.tempText,
    summary: raw.summary,
    clothing: raw.clothing,
    yi: raw.yi.filter((s) => typeof s === 'string') as string[],
    ji: raw.ji.filter((s) => typeof s === 'string') as string[]
  }
}

/** Coerce a parsed birth-data block into a valid `BirthData`. Drops a block
 *  with out-of-range year/month/day (a bad date mutes nothing — the fortune
 *  degrades to a generic read). */
function normalizeBirthData(b: unknown): BirthData | undefined {
  if (!b || typeof b !== 'object') return undefined
  const raw = b as Record<string, unknown>
  const year = Number(raw.year)
  const month = Number(raw.month)
  const day = Number(raw.day)
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2100 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return undefined
  }
  const out: BirthData = { year, month, day }
  if (Number.isInteger(raw.hour) && (raw.hour as number) >= 0 && (raw.hour as number) <= 23) {
    out.hour = raw.hour as number
  }
  if (raw.gender === 'male' || raw.gender === 'female') out.gender = raw.gender
  return out
}

/** Coerce a parsed (possibly partial) notifications block into a valid
 * `NotificationPrefs`. Drops malformed quiet-hours / category entries rather
 * than throwing — a bad value mutes nothing (defaults apply downstream). */
function normalizeNotifications(
  n: unknown
): NotificationPrefs | undefined
{
  if (!n || typeof n !== 'object') return undefined
  const raw = n as Record<string, unknown>
  const prefs: NotificationPrefs = {}
  if (typeof raw.nativeEnabled === 'boolean') prefs.nativeEnabled = raw.nativeEnabled
  const qh = raw.quietHours
  if (qh && typeof qh === 'object') {
    const q = qh as Record<string, unknown>
    const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/
    if (
      q.enabled === true &&
      typeof q.start === 'string' &&
      typeof q.end === 'string' &&
      hhmm.test(q.start) &&
      hhmm.test(q.end)
    ) {
      prefs.quietHours = { enabled: true, start: q.start, end: q.end }
    }
  }
  if (raw.categories && typeof raw.categories === 'object') {
    const cats: Partial<Record<string, boolean>> = {}
    for (const [k, v] of Object.entries(raw.categories as Record<string, unknown>)) {
      if (typeof v === 'boolean') cats[k] = v
    }
    if (Object.keys(cats).length) prefs.categories = cats
  }
  if (raw.routineOverrides && typeof raw.routineOverrides === 'object') {
    const ro: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(
      raw.routineOverrides as Record<string, unknown>
    )) {
      if (typeof v === 'boolean') ro[k] = v
    }
    if (Object.keys(ro).length) prefs.routineOverrides = ro
  }
  return Object.keys(prefs).length ? prefs : undefined
}
