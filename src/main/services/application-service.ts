// Application Service — the cross-channel job-application funnel (boss-cli
// integration). Owns the event-timeline model: an Application is one job the
// user applied to (boss-cli sync OR a manual 官网/内推 entry), and its progress
// is an ordered list of ApplicationEvents. The latest event is the current
// stage; `offer`/`rejected`/`withdrawn` are terminal (sticky). Manual events are
// `locked` (user truth); the full auto-doesn't-overwrite-locked precedence
// lands with email inference (P2) — P1 stores the flag and surfaces it.
//
// Boss sync pulls `boss applied/interviews/chat` into the funnel, upserting
// applications by `bossSecurityId` and idempotently appending events by
// `sourceRef` (so re-syncing never duplicates). A boss-cli failure (not
// installed / cookies expired / rate-limited) → a `provider_unavailable`
// Activity and the run continues (mirror the email-provider-down handling).

import type { RoutineStore } from '../db/store'
import type { BossProvider } from '../providers/boss/boss-provider'
import { BossCliError } from '../providers/boss/boss-provider'
import type { EmailProvider } from '../providers/email/email-provider'
import type {
  AgentRuntime,
  ClassifyApplicationEmailOutput,
  ApplicationEmailResult,
  ResumeOutput,
  InterviewTranscriptOutput
} from '../agent/agent-runtime'
import type { ActivityService } from './activity-service'
import type {
  Application,
  ApplicationEvent,
  ApplicationEventInput,
  ApplicationCreateInput,
  ApplicationUpdateFields,
  ApplicationView,
  ApplicationEventType,
  ApplicationSource,
  ResumeVersion,
  PrepMaterial,
  SmartFunnelBucket,
  SmartFunnelGroup,
  InterviewNote,
  InterviewNoteInput,
  BossApplication,
  BossInterview,
  BossChat,
  EmailMatchProposal,
  NormalizedEmail,
  ApplicationFunnelStats,
  FunnelStageCounts,
  FunnelReviewInput,
  FunnelReviewOutput,
  JobMatchInput,
  JobMatchOutput,
  JobMatchResult,
  JobIntent,
  JobRecommendations,
  FetchJobRecommendationsOpts,
  JobBucket,
  BossJob,
  BossSearchQuery,
  EmailSyncCursor,
  EmailQuery
} from '@shared/types'
import { newId, nowIso } from '../util/ids'
import { sha256 } from '../util/hash'
import { writeZip } from '../util/zip-writer'
import { APPLICATION_SOURCES, APPLICATION_EVENT_TYPES } from '@shared/constants'

const TERMINAL: ApplicationEventType[] = ['offer', 'rejected', 'withdrawn']
const STALE_DAYS = 14 // no-progress threshold → auto-demote to priority 'back'
const PURGE_DAYS = 30 // soft-deleted rows are hard-purged after this
const ARCHIVE_AFTER_REJECT_DAYS = 30 // terminal-rejected rows auto-archive

// Domains of third-party recruiting/assessment platforms. Retained for the
// future confidence-tiered match path (sender-domain signal upgrades a fuzzy
// match); the current aggressive auto-create routing uses normalized exact +
// fuzzy substring only, so this list is not consulted yet. 初版清单，按实际邮件补充。
export const RECRUITING_PLATFORM_DOMAINS = [
  'nowcoder.com', // 牛客
  'beisen.com', // 北森
  'acmcoder.com', // 赛码
  'mokahr.com', // Moka
  'zhipin.com' // BOSS 直聘
]

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime()
  return Math.floor(ms / 86_400_000)
}

function sortAsc(events: ApplicationEvent[]): ApplicationEvent[] {
  return [...events].sort((a, b) => {
    if (a.eventAt !== b.eventAt) return a.eventAt < b.eventAt ? -1 : 1
    return a.createdAt < b.createdAt ? -1 : 1
  })
}

/** Extract the registrable domain (last two labels) from an email address. */
export function extractDomain(address: string | undefined): string | undefined {
  if (!address) return undefined
  const at = address.lastIndexOf('@')
  if (at < 0) return undefined
  const host = address.slice(at + 1).toLowerCase()
  const labels = host.split('.')
  if (labels.length < 2) return host
  // last two labels (e.g. "nowcoder.com"); crude but sufficient for matching.
  return labels.slice(-2).join('.')
}

/** Does the company name appear verbatim in the email subject or body? */
export function textHasEmail(email: NormalizedEmail, company: string): boolean {
  const text = (email.subject + ' ' + email.textBody).toLowerCase()
  return text.includes(company.toLowerCase())
}

// ── Normalized company/position comparison (mail-driven funnel rebuild) ────
// The same company may surface in mail as "字节跳动有限公司", "字节跳动", "字节
// 招聘"; the same position as "后端工程师", "后端开发工程师", "Go 后端". To avoid
// creating duplicate applications per mail variant, we normalize both sides
// (lowercase + strip corporate/role suffixes + collapse whitespace) before an
// exact compare. This is a SAFETY NET on top of the per-event `sourceRef`
// idempotency — it catches the cross-message case (different messageId, same
// company+position) where sourceRef can't dedupe.
const COMPANY_SUFFIX_RE = /(有限公司|有限责任公司|股份公司|集团|科技|技术|控股|分公司|co\.?,?\.?ltd\.?|inc\.?|corp\.?|公司)$/gi
const POSITION_NOISE_RE = /(资深|高级|初级|实习|全职|全职|开发|研发|工程师|工程|师|岗)$/g

function normalizeCompany(s: string | undefined): string {
  if (!s) return ''
  return s.toLowerCase().replace(COMPANY_SUFFIX_RE, '').replace(/[\s·]+/g, '').trim()
}
function normalizePosition(s: string | undefined): string {
  if (!s) return ''
  return s.toLowerCase().replace(POSITION_NOISE_RE, '').replace(/[\s·]+/g, '').trim()
}

export class ApplicationService {
  /** In-memory email→application match queue (low-confidence / unmatched).
   * Keyed by messageId; survives only the process lifetime (§3.3 待确认队列). */
  private readonly emailMatches = new Map<string, EmailMatchProposal>()
  /** Last fetched boss.jobs by securityId — the lookup cache for `convertJobToApplication`
   *  (the renderer clicks 转投递 on a job from the most recent 抓取 batch). */
  private readonly lastJobs = new Map<string, BossJob>()
  /** Dual-track job recommendation state (校招生 实习 + 秋招正职). `lastPage` is
   *  the last page fetched per bucket (0 = none yet); `lastResults` the scored
   *  list per bucket; `*HasMore` the boss `hasMore` flag for "load more";
   *  `*SecurityIds` the split key (which bucket a securityId belongs to) so
   *  the bucket-unaware `score_job_matches` output can be split back. */
  private lastPage: { intern: number; campus: number } = { intern: 0, campus: 0 }
  private lastResults: { intern: JobMatchResult[]; campus: JobMatchResult[] } = { intern: [], campus: [] }
  private lastHasMore: { intern: boolean; campus: boolean } = { intern: false, campus: false }
  private internSecurityIds = new Set<string>()
  private campusSecurityIds = new Set<string>()
  /** Listener fired when the pending queue changes (container wires the IPC broadcast). */
  private onEmailMatchesChanged?: () => void

  constructor(
    private readonly store: RoutineStore,
    private readonly bossProvider: BossProvider,
    private readonly activityService: ActivityService
  ) {}

  /** Wire the pending-queue broadcast (container → IPC.EMAIL_MATCHES_CHANGED). */
  setEmailMatchesListener(fn: () => void): void {
    this.onEmailMatchesChanged = fn
  }
  private broadcastEmailMatches(): void {
    this.onEmailMatchesChanged?.()
  }

  /** List every application as a funnel view (application + computed state). */
  list(): ApplicationView[] {
    return this.store.listApplications().map((a) => this.toView(a))
  }

  /** Manually add an application (官网/内推/线下). Seeds an `applied` event. */
  create(input: ApplicationCreateInput): ApplicationView {
    const now = nowIso()
    const app: Application = {
      id: newId('app'),
      company: input.company,
      position: input.position,
      source: input.source ?? 'manual',
      bossSecurityId: undefined,
      appliedAt: input.appliedAt ?? now,
      channelRef: input.channelRef,
      notes: input.notes,
      city: input.city,
      salaryRange: input.salaryRange,
      jdText: input.jdText,
      stage: input.stage,
      stageDeadline: input.stageDeadline,
      interviewLink: input.interviewLink,
      priority: 'normal',
      createdAt: now,
      updatedAt: now
    }
    this.store.createApplication(app)
    this.seedAppliedEvent(app.id, 'manual', undefined, app.appliedAt)
    return this.toView(app)
  }

  /** Append a manual progress event. Manual events are locked by default. */
  addEvent(input: ApplicationEventInput): ApplicationView {
    const app = this.store.getApplication(input.applicationId)
    if (!app) throw new Error(`未找到投递记录：${input.applicationId}`)
    const now = nowIso()
    const event: ApplicationEvent = {
      id: newId('appevt'),
      applicationId: input.applicationId,
      type: input.type,
      round: input.round,
      role: input.role,
      subState: input.subState,
      source: 'manual',
      sourceRef: undefined,
      evidence: input.evidence,
      locked: input.locked ?? true,
      eventAt: input.eventAt ?? now,
      createdAt: now
    }
    this.store.createApplicationEvent(event)
    return this.toView(app)
  }

  /**
   * Pull `boss applied/interviews/chat` into the funnel. Idempotent by
   * `bossSecurityId` (application) and `sourceRef` (event). A boss-cli failure
   * (not installed / cookies expired / rate-limited) is logged as a
   * `provider_unavailable` Activity and the call returns gracefully.
   */
  async syncFromBoss(): Promise<{ synced: number; message: string }> {
    let applications: BossApplication[]
    let interviews: BossInterview[]
    let chats: BossChat[]
    try {
      ;[applications, interviews, chats] = await Promise.all([
        this.bossProvider.listApplications(),
        this.bossProvider.listInterviews(),
        this.bossProvider.listChats()
      ])
    } catch (err) {
      const message = err instanceof BossCliError ? err.message : err instanceof Error ? err.message : String(err)
      this.activityService.record({
        type: 'provider_unavailable',
        summary: `BOSS 直聘同步失败：${message}`,
        metadata: { provider: 'boss', error: message }
      })
      return { synced: 0, message: `BOSS 同步失败：${message}` }
    }

    let synced = 0
    // 1. Upsert applications + seed an `applied` event each.
    for (const b of applications) {
      const app = this.upsertBossApplication(b)
      this.seedAppliedEvent(app.id, 'boss', `boss:applied:${b.securityId}`, b.appliedAt ?? app.appliedAt)
      synced++
    }
    // 2. Interviews → an `interview` event on the matching application.
    for (const iv of interviews) {
      const app = this.matchBossApplication(iv.securityId, iv.companyName, iv.jobName)
      if (!app) continue
      this.appendEvent(app.id, {
        type: 'interview',
        source: 'boss',
        sourceRef: `boss:interview:${iv.interviewId}`,
        eventAt: iv.interviewTime ?? nowIso(),
        evidence: iv.status ? `BOSS 面试：${iv.status}` : 'BOSS 面试邀请'
      })
    }
    // 3. Chats → a `communicated` event (the HR replied on BOSS).
    for (const c of chats) {
      const app = this.matchBossApplication(c.securityId, c.companyName, c.jobName)
      if (!app) continue
      this.appendEvent(app.id, {
        type: 'communicated',
        source: 'boss',
        sourceRef: `boss:chat:${c.friendId}`,
        eventAt: c.lastTime ?? nowIso(),
        evidence: c.lastMessage ? `BOSS 沟通：${c.lastMessage}` : 'BOSS 沟通'
      })
    }
    this.activityService.record({
      type: 'tool_completed',
      summary: `BOSS 同步完成：${synced} 条投递`,
      metadata: { provider: 'boss', synced }
    })
    return { synced, message: `已同步 ${synced} 条 BOSS 投递` }
  }

  // ── Email→application inference (§3.3) ────────────────────────────────────

  /**
   * Pull unread mail from every connected email provider, classify each message
   * as an application EVENT (`classify_application_email` agent step), then
   * DETERMINISTICALLY match the model's output to existing applications — NOT the
   * model. Matching strategies (in priority order):
   *   1. `email_ref_id` direct (the application was linked to this messageId);
   *   2. sender domain (a known recruiting platform, or a company-domain hit);
   *   3. company+position substring (bidirectional contains).
   * Unique match + company name verbatim in the email text → high → append an
   * `email`-source event (`locked:false`, §17 risk #3). Multiple candidates or
   * no candidate → low → manual-confirm queue. Untrusted mail is skipped
   * entirely (never produces an event, §17). Idempotent by `sourceRef`
   * (`email:<messageId>`) so re-syncing never duplicates an event.
   */
  async syncFromEmails(
    emailProviders: EmailProvider[],
    agentRuntime: AgentRuntime,
    cursor: EmailSyncCursor = {}
  ): Promise<{
    synced: number
    created: number
    pending: number
    message: string
    cursor: EmailSyncCursor
  }> {
    const byMessageId = new Map<string, NormalizedEmail>()
    // Per-provider incremental query: each provider gets its high-water-mark so
    // the agent only runs on NEW mail (token-cost control). `unreadOnly` is NOT
    // set — a user may read mail in their client before Daymate syncs; the cursor
    // (UID / internalDate) is the sole "already processed" gate.
    let nextMail163Uid = cursor.mail163LastUid ?? 0
    let nextGmailInternalDate = cursor.gmailLastInternalDate ?? 0
    for (const p of emailProviders) {
      const query: EmailQuery = { limit: 50 }
      if (p.provider === 'mail163' && cursor.mail163LastUid) {
        query.sinceUid = cursor.mail163LastUid
      } else if (p.provider === 'gmail' && cursor.gmailLastInternalDate) {
        query.sinceInternalDate = cursor.gmailLastInternalDate
      }
      try {
        const emails = await p.listMessages(query)
        for (const e of emails) {
          byMessageId.set(e.messageId, e)
          // Advance the high-water-mark per provider type.
          if (p.provider === 'mail163') {
            const uid = Number(e.messageId)
            if (Number.isFinite(uid) && uid > nextMail163Uid) nextMail163Uid = uid
          } else if (p.provider === 'gmail') {
            const ts = new Date(e.receivedAt).getTime()
            if (Number.isFinite(ts) && ts > nextGmailInternalDate) nextGmailInternalDate = ts
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.activityService.record({
          type: 'provider_unavailable',
          summary: `邮件推断跳过 ${p.provider}：${message}`,
          metadata: { provider: p.provider, error: message }
        })
      }
    }
    if (byMessageId.size === 0) {
      return {
        synced: 0,
        created: 0,
        pending: 0,
        message: '邮件推断：无新邮件',
        cursor: {
          mail163LastUid: nextMail163Uid || undefined,
          gmailLastInternalDate: nextGmailInternalDate || undefined
        }
      }
    }

    let output: ClassifyApplicationEmailOutput
    try {
      output = (await agentRuntime.runAgentStep('classify_application_email', {
        emails: [...byMessageId.values()]
      })) as ClassifyApplicationEmailOutput
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.activityService.record({
        type: 'agent_failed',
        summary: `邮件推断分类失败：${message}`,
        metadata: { error: message }
      })
      return {
        synced: 0,
        created: 0,
        pending: 0,
        message: `邮件推断分类失败：${message}`,
        cursor: {
          mail163LastUid: nextMail163Uid || undefined,
          gmailLastInternalDate: nextGmailInternalDate || undefined
        }
      }
    }

    // Aggressive auto-create routing (user decision: "全部自动建"). For each
    // non-untrusted result with company AND position: normalize-dedupe against
    // existing applications — hit → append event; miss → create application +
    // seed event. Missing company OR position → pending queue (no identity to
    // dedupe/create on). Untrusted → skip entirely (§17).
    const apps = this.store.listApplications()
    let synced = 0
    let created = 0
    let pending = 0
    for (const r of output.results) {
      if (r.untrusted) continue // §17
      const email = byMessageId.get(r.messageId)
      if (!email) continue
      if (!r.company || !r.position) {
        this.pushPending(r, email, undefined)
        pending++
        continue
      }
      const match = this.findApplicationByNormalized(apps, r.company, r.position)
      let appId: string
      if (match) {
        appId = match.id
      } else {
        // Aggressive: company+position extracted → create even at low confidence.
        const view = this.create({
          company: r.company,
          position: r.position,
          source: 'email',
          city: r.city,
          salaryRange: r.salary,
          jdText: r.jdExcerpt
        })
        // Link the new application to this email so future mail in the thread
        // matches directly (mirrors confirmEmailMatch's direct-link seeding).
        this.store.updateApplication(view.application.id, { emailRefId: r.messageId })
        view.application.emailRefId = r.messageId
        appId = view.application.id
        created++
        apps.push(view.application)
      }
      if (this.appendEmailEvent(appId, r, email)) synced++
    }
    this.broadcastEmailMatches()
    this.activityService.record({
      type: 'tool_completed',
      summary: `邮件推断完成：${synced} 条事件、${created} 条新建、${pending} 条待确认`,
      metadata: { synced, created, pending }
    })
    return {
      synced,
      created,
      pending,
      message: `邮件推断完成：${synced} 事件 / ${created} 新建 / ${pending} 待确认`,
      cursor: {
        mail163LastUid: nextMail163Uid || undefined,
        gmailLastInternalDate: nextGmailInternalDate || undefined
      }
    }
  }

  /**
   * Normalized exact match of company+position against existing applications.
   * The normalized compare (lowercase + strip corporate/role suffixes) catches
   * "字节跳动有限公司" vs "字节跳动" for the same job. There is intentionally NO
   * fuzzy substring fallback: the user may apply to MULTIPLE positions at one
   * company, so a company-only substring hit would wrongly merge two distinct
   * funnel items. When the normalized compare misses, the caller aggressively
   * creates a new application (user decision: 全部自动建). The per-event
   * `sourceRef` idempotency still prevents duplicate events on the SAME email.
   */
  private findApplicationByNormalized(
    apps: Application[],
    company: string,
    position: string
  ): Application | undefined {
    const nc = normalizeCompany(company)
    const np = normalizePosition(position)
    return apps.find(
      (a) => normalizeCompany(a.company) === nc && normalizePosition(a.position) === np
    )
  }

  /**
   * @deprecated Replaced by `findApplicationByNormalized` (mail-driven funnel
   * rebuild). The normalized compare + fuzzy fallback there subsumes the old
   * direct-link / domain / substring strategies. Removed: tsc noUnusedLocals.
   */

  /** Append an email-detected event — idempotent by `email:<messageId>`.
   * Returns true if a new event was inserted, false if it already existed.
   * Also patches the application's empty jdText/city/salaryRange fields from
   * the classified result (R1 local write, §15 only gates external writes). */
  private appendEmailEvent(
    applicationId: string,
    r: ApplicationEmailResult,
    email: NormalizedEmail
  ): boolean {
    const sourceRef = `email:${r.messageId}`
    const existing = this.store.getApplicationEventBySourceRef(applicationId, sourceRef)
    if (existing) return false
    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId,
      type: r.eventType,
      source: 'email',
      sourceRef,
      evidence: r.evidence || email.subject,
      locked: false, // §17 risk #3: auto events never override a locked anchor
      eventAt: email.receivedAt,
      createdAt: nowIso()
    })
    // Backfill empty rich fields from the classified email. Minimal patch —
    // only writes fields that are currently empty, so a manually-entered JD
    // or a `web.fetch_jd` result is never clobbered by email extraction.
    const app = this.store.getApplication(applicationId)
    if (app) {
      const patch: ApplicationUpdateFields = {}
      if (!app.jdText && r.jdExcerpt) patch.jdText = r.jdExcerpt
      if (!app.city && r.city) patch.city = r.city
      if (!app.salaryRange && r.salary) patch.salaryRange = r.salary
      if (Object.keys(patch).length > 0) this.store.updateApplication(applicationId, patch)
    }
    return true
  }

  /** Push a low-confidence / unmatched result into the manual-confirm queue. */
  private pushPending(
    r: ApplicationEmailResult,
    email: NormalizedEmail,
    applicationId?: string
  ): void {
    // Idempotent: an existing proposal for this messageId is overwritten (refresh).
    const existing = this.store.getApplication(applicationId ?? '')
    this.emailMatches.set(r.messageId, {
      id: newId('ematch'),
      messageId: r.messageId,
      subject: email.subject,
      from: email.from.address,
      eventType: r.eventType,
      company: r.company,
      position: r.position,
      confidence: r.confidence,
      applicationId,
      applicationCompany: existing?.company,
      applicationPosition: existing?.position,
      evidence: r.evidence
    })
  }

  /** The current pending-queue proposals (renderer sub-section, §3.3). */
  listPendingEmailMatches(): EmailMatchProposal[] {
    return [...this.emailMatches.values()]
  }

  /**
   * Confirm a pending proposal: append the email event to the given application,
   * or to a freshly-created application (with `emailRefId` set so future mail in
   * the thread links directly). Removes the proposal from the queue.
   */
  confirmEmailMatch(messageId: string, applicationId?: string): void {
    const proposal = this.emailMatches.get(messageId)
    if (!proposal) return
    let appId = applicationId
    if (!appId) {
      const created = this.create({
        company: proposal.company ?? '未知公司',
        position: proposal.position ?? '未知岗位',
        source: 'email'
      })
      appId = created.application.id
      // Link the new application to this email so future mail matches directly.
      this.store.updateApplication(appId, { emailRefId: messageId })
    }
    const sourceRef = `email:${messageId}`
    const existing = this.store.getApplicationEventBySourceRef(appId, sourceRef)
    if (!existing) {
      this.store.createApplicationEvent({
        id: newId('appevt'),
        applicationId: appId,
        type: proposal.eventType,
        source: 'email',
        sourceRef,
        evidence: proposal.evidence ?? proposal.subject,
        locked: true, // user-confirmed → locked (user truth)
        eventAt: nowIso(),
        createdAt: nowIso()
      })
    }
    this.emailMatches.delete(messageId)
    this.broadcastEmailMatches()
  }

  /** Dismiss a pending proposal without acting on it. */
  ignoreEmailMatch(messageId: string): void {
    this.emailMatches.delete(messageId)
    this.broadcastEmailMatches()
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private upsertBossApplication(b: BossApplication): Application {
    const existing = b.securityId ? this.store.getApplicationByBossSecurityId(b.securityId) : undefined
    const now = nowIso()
    if (existing) {
      const updated = this.store.updateApplication(existing.id, {
        company: b.companyName,
        position: b.jobName,
        appliedAt: b.appliedAt ?? existing.appliedAt
      })
      return updated ?? existing
    }
    const app: Application = {
      id: newId('app'),
      company: b.companyName,
      position: b.jobName,
      source: 'boss',
      bossSecurityId: b.securityId,
      appliedAt: b.appliedAt ?? now,
      createdAt: now,
      updatedAt: now
    }
    this.store.createApplication(app)
    return app
  }

  /** Match a boss interview/chat back to an application (by securityId, else
   * company+position). Chat fixtures may omit company/position names, in which
   * case only the securityId path can match. */
  private matchBossApplication(
    securityId: string | undefined,
    company: string | undefined,
    position: string | undefined
  ): Application | undefined {
    if (securityId) {
      const bySid = this.store.getApplicationByBossSecurityId(securityId)
      if (bySid) return bySid
    }
    if (!company || !position) return undefined
    return this.store.listApplications().find((a) => a.company === company && a.position === position)
  }

  /** Seed an `applied` event — idempotent by sourceRef (boss sync) / always for manual. */
  private seedAppliedEvent(
    applicationId: string,
    source: 'boss' | 'manual',
    sourceRef: string | undefined,
    eventAt: string
  ): void {
    if (sourceRef) {
      const existing = this.store.getApplicationEventBySourceRef(applicationId, sourceRef)
      if (existing) return
    }
    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId,
      type: 'applied',
      source,
      sourceRef,
      locked: source === 'manual',
      eventAt,
      createdAt: nowIso()
    })
  }

  /** Append a boss-detected event — idempotent by sourceRef. */
  private appendEvent(
    applicationId: string,
    spec: { type: ApplicationEventType; source: 'boss'; sourceRef: string; eventAt: string; evidence: string }
  ): void {
    const existing = this.store.getApplicationEventBySourceRef(applicationId, spec.sourceRef)
    if (existing) return
    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId,
      type: spec.type,
      source: spec.source,
      sourceRef: spec.sourceRef,
      evidence: spec.evidence,
      locked: false,
      eventAt: spec.eventAt,
      createdAt: nowIso()
    })
  }

  /** Build a funnel view: application + events + computed current status. */
  private toView(app: Application): ApplicationView {
    const events = sortAsc(this.store.listApplicationEvents(app.id))
    const { currentStatus, currentRound, isTerminal, lastEventAt } = this.computeStatus(events)
    return {
      application: app,
      events,
      currentStatus,
      currentRound,
      isTerminal,
      lastEventAt,
      daysSinceLastEvent: lastEventAt ? daysSince(lastEventAt) : undefined
    }
  }

  /**
   * Status resolution with locked-precedence (Milestone A — the email-inference
   * rule finally takes effect).
   *
   * The anchor pool is the LOCKED events (user truth) when any exist; otherwise
   * the full event list (all auto-detected). Within the anchor pool, terminal
   * events win (sticky — you don't "un-reject"); otherwise the latest event
   * wins. Auto-detected events (locked:false, from boss/email) are always
   * recorded in the timeline (visible) but never move the status off a locked
   * anchor — including auto terminals (e.g. an auto `offer` cannot override a
   * locked `rejected`, §17 risk #3; the user must confirm it into a locked
   * event first).
   *
   * `lastEventAt` always reflects the newest event regardless of lock state,
   * so staleness detection is unaffected (a pinned app still goes "stale" if
   * nothing new arrives).
   */
  private computeStatus(events: ApplicationEvent[]): {
    currentStatus: ApplicationEventType
    currentRound?: number
    isTerminal: boolean
    lastEventAt?: string
  } {
    if (events.length === 0) {
      return { currentStatus: 'applied', isTerminal: false }
    }
    const last = events[events.length - 1]
    const lockedEvents = events.filter((e) => e.locked === true)
    const anchorPool = lockedEvents.length > 0 ? lockedEvents : events
    const terminals = anchorPool.filter((e) => TERMINAL.includes(e.type))
    if (terminals.length > 0) {
      const latestTerminal = terminals[terminals.length - 1]
      return {
        currentStatus: latestTerminal.type,
        isTerminal: true,
        lastEventAt: last.eventAt
      }
    }
    const anchor = anchorPool[anchorPool.length - 1]
    return {
      currentStatus: anchor.type,
      currentRound: anchor.round,
      isTerminal: false,
      lastEventAt: last.eventAt
    }
  }

  // ── Rich-field editing (Milestone A §3) ────────────────────────────────────

  /** Update editable rich fields (single-field refresh or inline edit). */
  updateFields(id: string, patch: ApplicationUpdateFields): ApplicationView | undefined {
    const app = this.store.getApplication(id)
    if (!app) return undefined
    const updated = this.store.updateApplication(id, patch)
    return updated ? this.toView(updated) : undefined
  }

  // ── Soft delete / restore / purge (§3.1 recycle bin) ───────────────────────

  /** Soft-delete (→ recycle bin). Visible 30d, then auto-purged. */
  softDelete(id: string): void {
    this.store.softDeleteApplication(id, nowIso())
  }
  restore(id: string): ApplicationView | undefined {
    this.store.restoreApplication(id)
    const app = this.store.getApplication(id)
    return app ? this.toView(app) : undefined
  }
  /** Hard-delete now (manual early-delete from the recycle bin). */
  purgeApplication(id: string): void {
    this.store.purgeApplication(id)
  }
  listDeleted(): ApplicationView[] {
    return this.store.listDeletedApplications().map((a) => this.toView(a))
  }
  listArchived(): ApplicationView[] {
    return this.store.listArchivedApplications().map((a) => this.toView(a))
  }
  archive(id: string): ApplicationView | undefined {
    this.store.archiveApplication(id, nowIso())
    const app = this.store.getApplication(id)
    return app ? this.toView(app) : undefined
  }
  unarchive(id: string): ApplicationView | undefined {
    const app = this.store.getApplication(id)
    if (!app) return undefined
    const updated = this.store.updateApplication(id, { archivedAt: undefined })
    return updated ? this.toView(updated) : undefined
  }

  /**
   * Maintenance sweep (§3.1 / §5). Soft-deleted rows older than PURGE_DAYS are
   * hard-purged; terminal-`rejected` rows older than ARCHIVE_AFTER_REJECT_DAYS
   * are auto-archived out of the active funnel; non-terminal rows with no event
   * for STALE_DAYS are auto-demoted to `priority:'back'`. Run once a day (cron,
   * not the 60s poll — a 30d/14d window needs no tighter cadence).
   */
  runMaintenance(): { purged: number; archived: number; demoted: number } {
    let purged = 0
    const cutoffMs = Date.now() - PURGE_DAYS * 86_400_000
    for (const a of this.store.listDeletedApplications()) {
      if (a.deletedAt && new Date(a.deletedAt).getTime() < cutoffMs) {
        this.store.purgeApplication(a.id)
        purged++
      }
    }
    let archived = 0
    const rejectCutoff = Date.now() - ARCHIVE_AFTER_REJECT_DAYS * 86_400_000
    for (const v of this.list()) {
      if (v.currentStatus === 'rejected' && v.lastEventAt && new Date(v.lastEventAt).getTime() < rejectCutoff) {
        this.store.archiveApplication(v.application.id, nowIso())
        archived++
      }
    }
    let demoted = 0
    for (const v of this.list()) {
      if (v.isTerminal) continue
      if (v.application.priority === 'back') continue
      if (v.daysSinceLastEvent !== undefined && v.daysSinceLastEvent >= STALE_DAYS) {
        this.store.updateApplication(v.application.id, { priority: 'back' })
        demoted++
      }
    }
    this.activityService.record({
      type: 'tool_completed',
      summary: `维护完成：清理 ${purged}、归档 ${archived}、降级 ${demoted}`,
      metadata: { purged, archived, demoted }
    })
    return { purged, archived, demoted }
  }

  // ── Smart funnel grouping (§5) ─────────────────────────────────────────────

  /**
   * Group the active (non-archived, non-deleted) funnel into ordered buckets:
   * urgent (near deadline / interview soon) → active → stale (14d+,
   * auto-demoted) → offered → ended (terminal) → archived (folded).
   */
  smartSortedViews(): SmartFunnelBucket[] {
    const active = this.list()
    const archived = this.listArchived()
    const buckets: Record<SmartFunnelGroup, ApplicationView[]> = {
      urgent: [],
      active: [],
      stale: [],
      offered: [],
      ended: [],
      archived: archived
    }
    const now = Date.now()
    for (const v of active) {
      if (v.currentStatus === 'offer') {
        buckets.offered.push(v)
      } else if (v.isTerminal) {
        buckets.ended.push(v)
      } else if (v.application.priority === 'back' || (v.daysSinceLastEvent ?? 0) >= STALE_DAYS) {
        buckets.stale.push(v)
      } else if (this.isUrgent(v, now)) {
        buckets.urgent.push(v)
      } else {
        buckets.active.push(v)
      }
    }
    const order: SmartFunnelGroup[] = ['urgent', 'active', 'stale', 'offered', 'ended', 'archived']
    return order
      .map((group) => ({ group, views: this.sortWithin(buckets[group]) }))
      .filter((b) => b.views.length > 0)
  }

  /** Urgent = a stage_deadline or interview within 3 days. */
  private isUrgent(v: ApplicationView, now: number): boolean {
    const deadline = v.application.stageDeadline ?? this.nextInterviewTime(v)
    if (!deadline) return false
    const ms = new Date(deadline).getTime() - now
    return ms <= 3 * 86_400_000 // ≤3d away (or already past)
  }

  private nextInterviewTime(v: ApplicationView): string | undefined {
    const iv = v.events.find((e) => e.type === 'interview')
    return iv?.eventAt
  }

  private sortWithin(views: ApplicationView[]): ApplicationView[] {
    // Urgent bucket: soonest deadline first. Others: most-recent activity first.
    return [...views].sort((a, b) => {
      const da = a.lastEventAt ?? ''
      const db = b.lastEventAt ?? ''
      return da < db ? 1 : da > db ? -1 : 0
    })
  }

  // ── Interview-status trigger (§F — application_status poller) ──────────────

  /**
   * Applications whose current status is `interview` and that have NO prep
   * material yet — the candidates for the `application_status` trigger (fire the
   * `interview_prep` routine once per such app). `currentStatus` already applies
   * the locked-precedence rule, so an auto-detected interview (locked:false)
   * only surfaces here when no locked event pins the status to something else.
   */
  listInterviewStatusApps(): ApplicationView[] {
    return this.list().filter(
      (v) => v.currentStatus === 'interview' && !this.store.getLatestPrepMaterial(v.application.id)
    )
  }

  // ── Search (§3.2 — for the agent transcript routine + renderer) ──────────
  /**
   * Search the active funnel by company/position/city substring (case-insensitive
   * contains). `{ id }` returns the single matching view directly. Used by the
   * `application.search` tool (R0) — the transcript routine looks up the target
   * application before generating prep material.
   */
  searchApplications(query: { company?: string; position?: string; city?: string; id?: string }): ApplicationView[] {
    if (query.id) {
      const app = this.store.getApplication(query.id)
      return app ? [this.toView(app)] : []
    }
    const lc = (s?: string) => (s ?? '').toLowerCase()
    const company = lc(query.company)
    const position = lc(query.position)
    const city = lc(query.city)
    return this.list().filter((v) => {
      if (company && !v.application.company.toLowerCase().includes(company)) return false
      if (position && !v.application.position.toLowerCase().includes(position)) return false
      if (city && !(v.application.city ?? '').toLowerCase().includes(city)) return false
      return true
    })
  }

  // ── 面经库 (§6 — interview-experience notes) ──────────────────────────────
  listInterviewNotes(query?: string): InterviewNote[] {
    const all = this.store.listInterviewNotes()
    if (!query) return all
    const q = query.toLowerCase()
    return all.filter((n) => {
      return (
        (n.company ?? '').toLowerCase().includes(q) ||
        (n.position ?? '').toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
  }
  getInterviewNote(id: string): InterviewNote | undefined {
    return this.store.getInterviewNote(id)
  }
  createInterviewNote(input: InterviewNoteInput): InterviewNote {
    const now = nowIso()
    const note: InterviewNote = {
      id: newId('ivnote'),
      company: input.company,
      position: input.position,
      applicationId: input.applicationId,
      tags: input.tags,
      content: input.content,
      source: 'manual',
      createdAt: now,
      updatedAt: now
    }
    this.store.createInterviewNote(note)
    return note
  }

  // ── Resume / prep-material versioning (§4.2 / §4.3) ──────────────────────────

  /** Latest AI resume HTML for an application (undefined if none generated). */
  getLatestResume(applicationId: string): ResumeVersion | undefined {
    return this.store.getLatestResumeVersion(applicationId)
  }
  getLatestPrepMaterial(applicationId: string): PrepMaterial | undefined {
    return this.store.getLatestPrepMaterial(applicationId)
  }
  listResumeVersions(applicationId: string): ResumeVersion[] {
    return this.store.listResumeVersions(applicationId)
  }
  listPrepMaterials(applicationId: string): PrepMaterial[] {
    return this.store.listPrepMaterials(applicationId)
  }
  /** Save a new resume version (version = prev+1, or 1 if first). */
  saveResume(applicationId: string, html: string, modelId?: string, promptHash?: string): ResumeVersion {
    const prev = this.store.getLatestResumeVersion(applicationId)
    const version = prev ? prev.version + 1 : 1
    const v: ResumeVersion = {
      id: newId('res'),
      applicationId,
      version,
      html,
      modelId,
      promptHash,
      createdAt: nowIso()
    }
    this.store.createResumeVersion(v)
    return v
  }
  savePrepMaterial(applicationId: string, html: string, modelId?: string, promptHash?: string): PrepMaterial {
    const prev = this.store.getLatestPrepMaterial(applicationId)
    const version = prev ? prev.version + 1 : 1
    const m: PrepMaterial = {
      id: newId('prep'),
      applicationId,
      version,
      html,
      modelId,
      promptHash,
      createdAt: nowIso()
    }
    this.store.createPrepMaterial(m)
    return m
  }

  // ── Manual AI generation (§4.2/§4.3 — renderer "重新生成" buttons) ────────
  // These run the agent step directly (NOT via the Routine Engine) — resume
  // generation is a side-effect of creating an application, and a manual
  // transcript regenerate is the same. The auto `interview_prep` routine is
  // the event-triggered path; these are the user-initiated paths. Both pass
  // JD via `frameJd` (untrusted, user message only, §17) and the base resume
  // via `frameTrustedDoc` (trusted — the user's own document).

  /**
   * Generate (or regenerate) an AI resume for an application, save it as a new
   * version, and return it. `baseResume` is the user's own document content
   * (read by the caller from `settings.readBaseResumeContent()`). `promptHash`
   * = SHA-256 of (baseResume + jdText) so a re-request with unchanged inputs is
   * a cache hit (skip the LLM) in a later iteration.
   */
  async generateResume(
    applicationId: string,
    agentRuntime: AgentRuntime,
    baseResume?: string
  ): Promise<ResumeVersion> {
    const app = this.store.getApplication(applicationId)
    if (!app) throw new Error(`未找到投递记录：${applicationId}`)
    const output = (await agentRuntime.runAgentStep('generate_resume', {
      company: app.company,
      position: app.position,
      jdText: app.jdText,
      baseResume
    })) as ResumeOutput
    const promptHash = sha256((baseResume ?? '') + '\n---\n' + (app.jdText ?? ''))
    return this.saveResume(applicationId, output.html, undefined, promptHash)
  }

  /**
   * Regenerate an interview transcript (prep material) for an application on
   * demand. Pulls the latest resume + 面经 notes for the company, runs the
   * `generate_interview_transcript` agent step, and saves a new prep version.
   * (The `interview_prep` routine is the auto-triggered equivalent; this is
   * the manual "重新生成" path.)
   */
  async generatePrepMaterial(applicationId: string, agentRuntime: AgentRuntime): Promise<PrepMaterial> {
    const app = this.store.getApplication(applicationId)
    if (!app) throw new Error(`未找到投递记录：${applicationId}`)
    const notes = this.listInterviewNotes(app.company)
    const resume = this.getLatestResume(applicationId)
    const output = (await agentRuntime.runAgentStep('generate_interview_transcript', {
      company: app.company,
      position: app.position,
      jdText: app.jdText,
      resume: resume?.html,
      notes
    })) as InterviewTranscriptOutput
    return this.savePrepMaterial(applicationId, output.html, undefined, undefined)
  }

  // ── Funnel review statistics (Milestone B) ─────────────────────────────────
  // Aggregate derived from `list()` + `smartSortedViews()`, reduced in memory
  // (the store stays pure CRUD; data volume is tens-to-hundreds). DESCRIPTIVE
  // only — §2/§13.4 forbid productivity/slacking framing. `reachedStage` counts
  // apps that have EVER had an event of a stage type (cumulative funnel shape);
  // `applied` = total (every app exists because it was applied to, even if the
  // `applied` event itself was implicit). Conversion is round(x / applied * 100).

  stats(): ApplicationFunnelStats {
    const views = this.list()
    const total = views.length

    const byStatus = Object.fromEntries(
      APPLICATION_EVENT_TYPES.map((t) => [t, 0])
    ) as Record<ApplicationEventType, number>
    const bySource = Object.fromEntries(
      APPLICATION_SOURCES.map((s) => [s, 0])
    ) as Record<ApplicationSource, number>
    const reachedStage: FunnelStageCounts = {
      applied: total,
      communicated: 0,
      assessment: 0,
      written_test: 0,
      interview: 0,
      offer: 0
    }
    const byFunnelGroup = Object.fromEntries(
      (['urgent', 'active', 'stale', 'offered', 'ended', 'archived'] as SmartFunnelGroup[]).map(
        (g) => [g, 0]
      )
    ) as Record<SmartFunnelGroup, number>

    for (const v of views) {
      byStatus[v.currentStatus]++
      bySource[v.application.source]++
      // Cumulative "ever reached stage X" = an event of that type exists.
      const types = new Set(v.events.map((e) => e.type))
      if (types.has('communicated')) reachedStage.communicated++
      if (types.has('assessment')) reachedStage.assessment++
      if (types.has('written_test')) reachedStage.written_test++
      if (types.has('interview')) reachedStage.interview++
      if (types.has('offer')) reachedStage.offer++
    }
    // byFunnelGroup counts from the smart funnel (reuses the exact bucketing
    // the 投递 page renders, including the archived bucket).
    for (const b of this.smartSortedViews()) {
      byFunnelGroup[b.group] = b.views.length
    }

    const terminal = {
      offer: byStatus.offer,
      rejected: byStatus.rejected,
      withdrawn: byStatus.withdrawn
    }
    const terminalCount = terminal.offer + terminal.rejected + terminal.withdrawn
    const active = total - terminalCount

    const nonTerminal = views.filter((v) => !v.isTerminal)
    const stale = nonTerminal.filter(
      (v) => (v.daysSinceLastEvent ?? 0) >= STALE_DAYS
    ).length
    const urgent = byFunnelGroup.urgent

    const avgDaysSinceLastEvent = nonTerminal.length
      ? Math.round(
          nonTerminal.reduce((s, v) => s + (v.daysSinceLastEvent ?? 0), 0) / nonTerminal.length
        )
      : null
    const avgDaysInProcess = nonTerminal.length
      ? Math.round(
          nonTerminal.reduce((s, v) => {
            const applied = v.application.appliedAt
              ? Date.now() - new Date(v.application.appliedAt).getTime()
              : 0
            return s + Math.floor(applied / 86_400_000)
          }, 0) / nonTerminal.length
        )
      : null

    const conv = (stage: keyof FunnelStageCounts): number =>
      reachedStage.applied > 0
        ? Math.round((reachedStage[stage] / reachedStage.applied) * 100)
        : 0

    return {
      total,
      active,
      terminal,
      byStatus,
      bySource,
      byFunnelGroup,
      reachedStage,
      conversion: {
        assessment: conv('assessment'),
        written_test: conv('written_test'),
        interview: conv('interview'),
        offer: conv('offer')
      },
      stale,
      urgent,
      avgDaysSinceLastEvent,
      avgDaysInProcess
    }
  }

  /**
   * Build the agent input for a funnel review (stats + a compact per-app
   * projection). `apps` carries only short structured field values (company /
   * position / status / days / priority / source) — NO jd_text, email bodies,
   * or evidence prose (§17: the agent input is Daymate's own derived records;
   * company/position are boss/email field values framed as DATA in the user
   * message, never in the system prompt).
   */
  private buildFunnelReviewInput(): FunnelReviewInput {
    const stats = this.stats()
    const apps = this.list().map((v) => ({
      company: v.application.company,
      position: v.application.position,
      currentStatus: v.currentStatus,
      daysSinceLastEvent: v.daysSinceLastEvent,
      priority: v.application.priority,
      source: v.application.source
    }))
    return { stats, apps }
  }

  /**
   * Generate an AI 复盘 narrative for the whole funnel on demand (manual
   * "生成复盘" button — NOT via the Routine Engine, mirroring
   * `generateResume`/`generatePrepMaterial`). Returns a descriptive brief
   * (highlights / riskApps / suggestedActions) — no productivity score (§2/
   * §13.4). `memoryProposals` are returned for display; they are NOT persisted
   * here (per the "declarative proposals, not runtime injection" decision — a
   * future daily routine wires `memory.save_proposals` for that path).
   */
  async generateFunnelReview(agentRuntime: AgentRuntime): Promise<FunnelReviewOutput> {
    const input = this.buildFunnelReviewInput()
    const output = (await agentRuntime.runAgentStep(
      'generate_funnel_review',
      input as unknown as Record<string, unknown>
    )) as FunnelReviewOutput
    return output
  }

  /**
   * Search one bucket (实习 / 秋招正职) across all configured cities for a single
   * page, sequentially (NOT concurrent — BOSS anti-bot trips on parallel CLI
   * probes; verified empirically during real-cli integration). Bucket is a
   * deterministic business rule (§12): 实习桶 filters `--job-type 实习`;
   * 秋招正职桶 filters `--job-type 全职 --exp 在校/应届` (校招生 truth). The agent
   * (`score_job_matches`) stays bucket-unaware — the service splits results back
   * into buckets by securityId after the single scoring call. §17: job field
   * values are short structured strings framed as DATA in the user message.
   *
   * Rate-limit tolerance: a `BossCliError` with code `not_authenticated`/
   * `rate_limited` (anti-bot trip / cookie staleness) stops the bucket but keeps
   * already-fetched partial results + surfaces an `error` string (mirror email
   * provider outage graceful degradation). Other errors propagate.
   */
  private async searchOneBucket(
    bucket: JobBucket,
    intent: JobIntent,
    cities: string[],
    page: number
  ): Promise<{ jobs: BossJob[]; hasMore: boolean; error?: string }> {
    const jobs: BossJob[] = []
    let hasMore = false
    let error: string | undefined
    for (const city of cities) {
      try {
        const query: BossSearchQuery = {
          keyword: intent.keyword,
          city,
          degree: intent.degree,
          page,
          jobType: bucket === 'intern' ? '实习' : '全职',
          experience: bucket === 'campus' ? '在校/应届' : undefined
        }
        const res = await this.bossProvider.searchJobsPaged(query)
        for (const j of res.jobs) {
          if (!jobs.some((x) => x.securityId === j.securityId)) jobs.push(j)
        }
        hasMore = hasMore || res.hasMore
      } catch (err) {
        const code = err instanceof BossCliError ? err.code : undefined
        const message =
          err instanceof BossCliError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err)
        if (code === 'not_authenticated' || code === 'rate_limited') {
          error = message
          this.activityService.record({
            type: 'provider_unavailable',
            summary: `BOSS ${
              bucket === 'intern' ? '实习' : '秋招正职'
            }抓取受限：${message}`,
            metadata: { provider: 'boss', bucket, error: message }
          })
          break // stop more cities for this bucket; keep partial.
        }
        throw err // unexpected → propagate to the caller.
      }
    }
    return { jobs, hasMore, error }
  }

  /**
   * Fetch + score job recommendations across two buckets (实习 / 秋招正职) —
   * manual "抓取" button, NOT via the Routine Engine (mirrors
   * `generateFunnelReview`). 校招生 dual-applies: 实习桶 + 秋招正职桶 each
   * filtered appropriately (job-type / experience). Caches raw jobs by
   * securityId so `convertJobToApplication` can find them.
   *
   * - refresh (no opts or `append:false`): reset state, fetch page 1 of both
   *   buckets, score the combined set once (agent bucket-unaware), split results
   *   back into buckets by securityId.
   * - append (`{bucket, append:true}`): fetch that bucket's next page, score only
   *   the new jobs, merge into the bucket's cached results.
   *
   * Boss-cli outage → `error` field set, partial results still returned.
   */
  async fetchJobRecommendations(
    agentRuntime: AgentRuntime,
    jobIntent: JobIntent,
    opts: FetchJobRecommendationsOpts = {}
  ): Promise<JobRecommendations> {
    const bucket =
      opts.bucket === 'intern' || opts.bucket === 'campus' ? opts.bucket : null
    const append = opts.append === true && bucket !== null

    if (append) {
      // append: no reset, fetch next page of `bucket`.
    } else if (bucket) {
      // refresh ONE bucket: reset only that bucket's state. The other bucket's
      // cached results + lastJobs stay (convertJobToApplication still works).
      this.lastPage[bucket] = 0
      this.lastResults[bucket] = []
      this.lastHasMore[bucket] = false
      ;(bucket === 'intern' ? this.internSecurityIds : this.campusSecurityIds).clear()
    } else {
      this.lastJobs.clear()
      this.lastPage = { intern: 0, campus: 0 }
      this.lastResults = { intern: [], campus: [] }
      this.lastHasMore = { intern: false, campus: false }
      this.internSecurityIds.clear()
      this.campusSecurityIds.clear()
    }

    const cities =
      jobIntent.cities && jobIntent.cities.length > 0 ? jobIntent.cities : ['全国']
    const buckets: JobBucket[] = bucket ? [bucket] : ['intern', 'campus']
    const newJobs: BossJob[] = []
    const errors: string[] = []

    for (const b of buckets) {
      const page = (append ? this.lastPage[b] : 0) + 1
      let bucketError: string | undefined
      try {
        const res = await this.searchOneBucket(b, jobIntent, cities, page)
        bucketError = res.error
        const sidSet =
          b === 'intern' ? this.internSecurityIds : this.campusSecurityIds
        for (const j of res.jobs) {
          if (!sidSet.has(j.securityId)) {
            sidSet.add(j.securityId)
            newJobs.push(j)
            this.lastJobs.set(j.securityId, j)
          }
        }
        this.lastPage[b] = page
        this.lastHasMore[b] = res.hasMore
      } catch (err) {
        const message =
          err instanceof BossCliError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err)
        this.activityService.record({
          type: 'provider_unavailable',
          summary: `BOSS ${b === 'intern' ? '实习' : '秋招正职'}抓取失败：${message}`,
          metadata: { provider: 'boss', bucket: b, error: message }
        })
        bucketError = message
        this.lastHasMore[b] = false
      }
      if (bucketError) {
        errors.push(`${b === 'intern' ? '实习' : '秋招正职'}：${bucketError}`)
      }
    }

    // Score the newly-fetched jobs in ONE call (agent stays bucket-unaware),
    // then split results back into buckets by securityId.
    if (newJobs.length > 0) {
      const input: JobMatchInput = { intent: jobIntent, jobs: newJobs }
      const output = (await agentRuntime.runAgentStep(
        'score_job_matches',
        input as unknown as Record<string, unknown>
      )) as JobMatchOutput
      for (const r of output.results) {
        if (this.internSecurityIds.has(r.securityId)) {
          if (!this.lastResults.intern.some((x) => x.securityId === r.securityId)) {
            this.lastResults.intern.push(r)
          }
        } else if (this.campusSecurityIds.has(r.securityId)) {
          if (!this.lastResults.campus.some((x) => x.securityId === r.securityId)) {
            this.lastResults.campus.push(r)
          }
        }
      }
    }

    // recommend-first, then score-desc (stub already sorts, but append merges).
    const sortFn = (a: JobMatchResult, b: JobMatchResult) =>
      a.recommend !== b.recommend ? (a.recommend ? -1 : 1) : b.score - a.score
    this.lastResults.intern.sort(sortFn)
    this.lastResults.campus.sort(sortFn)

    const errorText = errors.length
      ? `部分抓取受限：${errors.join('；')}。请稍后重试或 boss login。`
      : undefined

    return {
      title: '岗位推荐',
      summary: `实习 ${this.lastResults.intern.length} 个 · 秋招正职 ${this.lastResults.campus.length} 个`,
      reason: errorText ?? '抓取完成',
      priority: 'medium',
      intern: this.lastResults.intern,
      campus: this.lastResults.campus,
      error: errorText,
      internHasMore: this.lastHasMore.intern,
      campusHasMore: this.lastHasMore.campus,
      internFetched: this.lastPage.intern > 0,
      campusFetched: this.lastPage.campus > 0
    }
  }

  /**
   * Convert a recommended BOSS job (from the most recent `fetchJobRecommendations`
   * batch) into a tracked application — the "一键转投递" action. Idempotent: if an
   * application with the same `bossSecurityId` already exists, returns its view
   * unchanged. Creates the application with source `boss` + `bossSecurityId` set
   * (so a future boss-cli sync upserts onto it rather than duplicating) and a
   * `locked` `applied` event (the user decided to apply — user truth; sourceRef
   * `boss:applied:<sid>` dedupes against the boss-sync seed).
   */
  convertJobToApplication(securityId: string): ApplicationView {
    const job = this.lastJobs.get(securityId)
    if (!job) {
      throw new Error('未找到该岗位（请先抓取岗位推荐）。')
    }
    const existing = this.store.getApplicationByBossSecurityId(securityId)
    if (existing) return this.toView(existing)
    const now = nowIso()
    const app: Application = {
      id: newId('app'),
      company: job.companyName,
      position: job.jobName,
      source: 'boss',
      bossSecurityId: securityId,
      appliedAt: now,
      city: job.city,
      salaryRange: job.salary,
      priority: 'normal',
      createdAt: now,
      updatedAt: now
    }
    this.store.createApplication(app)
    // User-initiated → locked. sourceRef matches boss-sync's seed so a later
    // sync dedupes (getApplicationEventBySourceRef) instead of duplicating.
    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId: app.id,
      type: 'applied',
      source: 'boss',
      sourceRef: `boss:applied:${securityId}`,
      locked: true,
      eventAt: now,
      createdAt: nowIso()
    })
    this.activityService.record({
      type: 'tool_completed',
      summary: `转投递：${job.companyName}·${job.jobName}`,
      metadata: { securityId, applicationId: app.id }
    })
    return this.toView(app)
  }

  /** Build a ZIP of the entire 投递 module (Milestone D §D3): every
   *  application (active + soft-deleted + archived) with its events, every
   *  resume version, every prep material, and every 面经 note — each table
   *  as a JSON dump. Returns the raw ZIP bytes (STORED, no compression) so the
   *  IPC handler can write it to a user-chosen path. Pure + framework-agnostic
   *  (no Electron import) so it's testable. */
  exportApplicationsZip(): Uint8Array {
    const apps = this.store.listApplications()
    const deleted = this.store.listDeletedApplications()
    const archived = this.store.listArchivedApplications()
    const allApps = [...apps, ...deleted, ...archived]
    const events: ApplicationEvent[] = []
    const resumes: ResumeVersion[] = []
    const preps: PrepMaterial[] = []
    for (const a of allApps) {
      events.push(...this.store.listApplicationEvents(a.id))
      resumes.push(...this.store.listResumeVersions(a.id))
      preps.push(...this.store.listPrepMaterials(a.id))
    }
    const notes = this.store.listInterviewNotes()
    const entries: { name: string; data: Uint8Array }[] = [
      { name: 'applications.json', data: toUtf8(allApps) },
      { name: 'application_events.json', data: toUtf8(events) },
      { name: 'resume_versions.json', data: toUtf8(resumes) },
      { name: 'prep_materials.json', data: toUtf8(preps) },
      { name: 'interview_notes.json', data: toUtf8(notes) },
      {
        name: 'README.txt',
        data: toUtf8(
          [
            'Daymate 投递模块数据导出',
            `导出时间：${nowIso()}`,
            '',
            `applications.json — 投递记录（${allApps.length} 条，含已删除/已归档）`,
            `application_events.json — 事件时间线（${events.length} 条）`,
            `resume_versions.json — AI 简历版本（${resumes.length} 条）`,
            `prep_materials.json — 面试逐字稿/面经准备（${preps.length} 条）`,
            `interview_notes.json — 面经库（${notes.length} 条）`
          ].join('\n')
        )
      }
    ]
    return writeZip(entries, { fixedDate: new Date() })
  }
}

function toUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2))
}
