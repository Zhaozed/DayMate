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
import type { EmailProvider } from '../providers/email/email-provider'
import type {
  AgentRuntime,
  ClassifyApplicationEmailOutput,
  ApplicationEmailResult,
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
  EmailMatchProposal,
  NormalizedEmail,
  ApplicationFunnelStats,
  FunnelStageCounts,
  FunnelReviewInput,
  FunnelReviewOutput,
  EmailSyncCursor,
  EmailQuery
} from '@shared/types'
import { newId, nowIso } from '../util/ids'
import { shouldSkipFunnel, isSchoolSpam, isRecruitingVip, RECRUITING_KEYWORD_RE, DEFAULT_SKIP_TOKENS } from '../util/bulk-mail'
import { extractTextFromPdf } from '../util/pdf'
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
    if (a.type === 'applied' && b.type !== 'applied') return -1
    if (b.type === 'applied' && a.type !== 'applied') return 1
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

const ATS_POSITION_PATTERNS = [
  /(?:申请|应聘|投递)(?:了|的)?(?:[^\s【「]{1,20}?(?:公司|集团))?[:：\s]*[【「\[]([a-zA-Z\u4e00-\u9fa50-9+/#·_— -]{2,40}?)[】」\]](?:岗位|职位)?/i,
  /你申请的[【「\[]([a-zA-Z\u4e00-\u9fa50-9+/#·_— -]{2,40}?)[】」\]]/i,
  /【([a-zA-Z\u4e00-\u9fa50-9+/#·_— -]{2,40}?(?:经理|专家|工程师|专员|实习生|管培生|管培|设计|运营|开发|分析师|研究员|顾问|总监|助理|产品|Builder)[^】」\]]*?)】/i,
  /(?:应聘|投递|申请)(?:[^\s，。！!]{2,35}?(?:有限公司|有限责任公司|公司|集团)(?:的)?)?[:：\s]*[【「[]?([a-zA-Z\u4e00-\u9fa50-9+/#·_-]{2,30}?)[】」\]]?(?:职位|岗位)/i,
  /(?:职位|岗位|职位名称|应聘职位|投递职位)[:：\s]+[【「[]?([a-zA-Z\u4e00-\u9fa50-9+/#·_-]{2,30}?)[】」\]]?(?:[\r\n\t,，。；;]|$)/i,
  /【([a-zA-Z\u4e00-\u9fa50-9+/#·_-]{2,30}?(?:经理|专家|工程师|专员|实习生|管培生|管培|设计|运营|开发|分析师|研究员|顾问|总监|助理|产品))】/i,
  /(?:【|「|\[|的|^|\s)(售前产品经理|售前方案专家|售前工程师|售前技术支持|技术产品经理|AI产品经理|数据产品经理|商业化产品经理|用户产品经理|全球管培生|管培生|产品经理)(?:】|」|\]|岗位|职位|$|\s|，|。)/i,
  /(?:应聘|投递|申请)[:：\s]+(?:[^\s，。！!]{2,35}?(?:有限公司|有限责任公司|公司|集团)(?:的)?)?[:：\s]*([a-zA-Z\u4e00-\u9fa50-9+/#·_-]{2,30}?)(?:[\r\n\t,，。]|$)/i
]

const COMPANY_PREFIX_CLEAN_RE = /^(?:[^\s，。！!]{2,35}?(?:有限公司|有限责任公司|股份公司|集团公司|科技公司|网络公司)|我司|本公司|贵司)(?:的)?/i
const COMPANY_DE_CLEAN_RE = /^(?:[^\s，。！!]{2,35}?(?:公司|集团))的/i

const NON_POSITION_WORDS_RE =
  /^(反馈通知|结果通知|进展通知|状态更新|感谢信|求职申请|投递反馈|录用通知|面试通知|笔试通知|测评通知|通知|提醒|温馨提示|进展|结果|反馈|公告|邮件|更新|申请|邀请函|邀请)$/i

export function extractPositionFromText(text: string): string | undefined {
  if (!text) return undefined
  for (const p of ATS_POSITION_PATTERNS) {
    const m = text.match(p)
    if (m && m[1]) {
      let clean = m[1].trim()
      clean = clean.replace(COMPANY_PREFIX_CLEAN_RE, '').replace(COMPANY_DE_CLEAN_RE, '').trim()
      if (
        clean.length >= 2 &&
        !/^(您|我|本公司|此致|祝您|该公司|贵司|职位|岗位)$/.test(clean) &&
        !NON_POSITION_WORDS_RE.test(clean) &&
        !/(?:反馈通知|结果通知|进展通知|状态更新|感谢信)$/i.test(clean)
      ) {
        return clean
      }
    }
  }
  return undefined
}

export const INVALID_JOB_CODES = new Set([
  'null', 'undefined', 'none', 'true', 'false', 'n/a', 'na',
  'requirements', 'uirements', 'requirement', 'description',
  'qualifications', 'qualification', 'position', 'positions',
  'responsibilities', 'responsibility', 'overview', 'details',
  'application', 'applications', 'candidate', 'interview',
  'status', 'update', 'notice', 'email', 'urgent', 'normal',
  'beijing', 'shanghai', 'shenzhen', 'hangzhou', 'guangzhou'
])

const ATS_JOB_CODE_PATTERNS = [
  /(?:职位编号|岗位编号|职位代码|岗位代码|职位ID|岗位ID|需求编号|招聘编号|Req(?:uisition)?\s*(?:ID|No|Code|#)\b|Job\s*(?:ID|Code|#|Req\b))[:：\s#]+[【「[#]?([a-zA-Z0-9_-]{3,35})[】」\]]?/i,
  /[【「[](?:职位编号|岗位编号|Job ID|Req ID)[:：\s]*([a-zA-Z0-9_-]{3,35})[】」\]]/i,
  /\((?:职位编号|岗位编号|Req\s*ID|Job\s*ID)[:：\s]*([a-zA-Z0-9_-]{3,35})\)/i,
  /(?:职位|岗位|投递|应聘|[a-zA-Z\u4e00-\u9fa5]{2,10})[（(]([A-Z0-9_-]{4,25})[)）]/i,
  /[（(]([A-Z0-9_-]{5,25})[)）]/i,
  /\b(J\d{4,8}|REQ\d{4,8}|JOB\d{4,8})\b/i
]

export function extractJobCodeFromText(text: string): string | undefined {
  if (!text) return undefined
  for (const p of ATS_JOB_CODE_PATTERNS) {
    const m = text.match(p)
    if (m && m[1]) {
      const code = m[1].trim()
      const lower = code.toLowerCase()
      if (code.length < 3) continue
      if (INVALID_JOB_CODES.has(lower)) continue
      if (/^[a-zA-Z]+$/.test(code) && code.length > 8) continue
      return code
    }
  }
  return undefined
}

export class ApplicationService {
  /** In-memory email→application match queue (low-confidence / unmatched).
   * Keyed by messageId; survives only the process lifetime (§3.3 待确认队列). */
  private readonly emailMatches = new Map<string, EmailMatchProposal>()
  /** Listener fired when the pending queue changes (container wires the IPC broadcast). */
  private onEmailMatchesChanged?: () => void
  /** ADR 0026 — funnel-path ToDo extraction. Optional TaskService + broadcast;
   *  wired by the container. Absent on test runtimes. */
  private taskService?: import('./task-service').TaskService
  private onTasksChanged?: () => void
  /** ADR 0027 — school-spam subject tokens to skip in the funnel path too
   *  (school broadcast spam never reaches classify_application_email). */
  private skipTokens?: string[]

  constructor(
    private readonly store: RoutineStore,
    private readonly activityService: ActivityService
  ) {
    this.repairBogusJobCodeMerges()
  }

  /** Listener fired when applications change. */
  private onApplicationsChanged?: () => void

  /** Wire the applications broadcast (container → IPC.APPLICATION_CHANGED). */
  setApplicationsListener(fn: () => void): void {
    this.onApplicationsChanged = fn
  }
  private broadcastApplications(): void {
    this.onApplicationsChanged?.()
  }

  /** Wire the pending-queue broadcast (container → IPC.EMAIL_MATCHES_CHANGED). */
  setEmailMatchesListener(fn: () => void): void {
    this.onEmailMatchesChanged = fn
  }
  private persistPendingWriter?: (proposals: EmailMatchProposal[]) => Promise<void>
  setPendingPersistence(
    initialProposals: EmailMatchProposal[] | undefined,
    writer: (proposals: EmailMatchProposal[]) => Promise<void>
  ): void {
    if (initialProposals && Array.isArray(initialProposals)) {
      for (const p of initialProposals) {
        if (p && p.messageId) {
          this.emailMatches.set(p.messageId, p)
        }
      }
    }
    this.persistPendingWriter = writer
  }
  private broadcastEmailMatches(): void {
    this.onEmailMatchesChanged?.()
    this.persistPendingWriter?.([...this.emailMatches.values()]).catch(() => {})
  }

  /** Wire funnel-path ToDo extraction (ADR 0026). The service auto-creates a
   *  ToDo when a recruiting email carries a concrete next step + date
   *  (interview / written-test notice). Idempotent by sourceId. */
  setTaskExtraction(
    taskService: import('./task-service').TaskService,
    onTasksChanged: () => void
  ): void {
    this.taskService = taskService
    this.onTasksChanged = onTasksChanged
  }

  /** Wire school-spam skip tokens (ADR 0027). The funnel path also drops
   *  subject-prefix school broadcast spam before any LLM classify pass. */
  setSkipTokens(tokens: string[] | undefined): void {
    this.skipTokens = tokens
  }

  /** Background JD enrichment fetcher (using web.fetch_jd tool) */
  private jdFetcher?: (company: string, position: string, jobCode?: string) => Promise<string | null>
  setJdFetcher(fn: (company: string, position: string, jobCode?: string) => Promise<string | null>): void {
    this.jdFetcher = fn
  }

  async fetchJd(company: string, position: string, jobCode?: string): Promise<string | null> {
    if (this.jdFetcher) {
      return this.jdFetcher(company, position, jobCode)
    }
    return null
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
      jobCode: input.jobCode,
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
      prepStatus: input.prepStatus ?? 'none',
      priority: 'normal',
      createdAt: now,
      updatedAt: now
    }
    this.store.createApplication(app)
    const eventSource: 'boss' | 'email' | 'manual' =
      app.source === 'boss' ? 'boss' : app.source === 'email' ? 'email' : 'manual'
    this.seedAppliedEvent(app.id, eventSource, undefined, app.appliedAt)
    return this.toView(app)
  }

  /** Get an application view by id. */
  get(id: string): ApplicationView | undefined {
    const app = this.store.getApplication(id)
    return app ? this.toView(app) : undefined
  }

  /**
   * Seed AI产品经理 demo applications (source:'email') when the funnel holds
   * ONLY retired-BOSS rows (or is empty). BOSS is retired (ADR 0019 — UI
   * hidden, backend dormant), so boss-source rows are obsolete test data;
   * this is a one-time reset that wipes them and seeds a realistic
   * email-driven funnel so the 投递 panel has data to show. Once real
   * email/manual applications exist, `hasRealData` blocks the reset (non-
   * destructive on subsequent boots — the demo apps themselves are source
   * 'email', so after the first seed the guard holds). Events are email-
   * detected (source:'email', locked:false) with unique `sourceRef`s.
   */
  seedDemoData(): void {
    // Purged: No demo data is seeded.
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
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef,
      evidence: input.evidence,
      locked: input.locked ?? true,
      eventAt: input.eventAt ?? now,
      createdAt: now
    }
    this.store.createApplicationEvent(event)
    return this.toView(app)
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
    /** The deduped delta of new emails this round — fed to the email-briefing
     *  path so important mail can surface in 必读 + auto-draft without a
     *  second provider fetch. Empty on the no-new-mail / classify-fail paths. */
    newEmails: NormalizedEmail[]
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
        if (emails.length > 0) {
          console.log(`[email-sync] ${p.provider} listMessages query=${JSON.stringify(query)} returned ${emails.length} emails`)
        }
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
        if (p.provider === 'gmail' && typeof p.searchMessages === 'function' && !cursor.gmailLastInternalDate) {
          try {
            const searchTerms = '招聘 OR 校招 OR 求职 OR 投递 OR 面试 OR 笔试 OR 测评 OR 录用 OR offer OR "application received" OR "thank you for applying" OR "interview invitation"'
            const found = await p.searchMessages(searchTerms, 30)
            for (const e of found) {
              if (!byMessageId.has(e.messageId)) {
                byMessageId.set(e.messageId, e)
              }
            }
          } catch {
            // best-effort search query fallback
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[email-sync] ${p.provider} listMessages FAILED:`, message)
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
        },
        newEmails: []
      }
    }

    // Pre-LLM filter (ADR 0023): skip pure-marketing bulk (ads keywords) so the
    // funnel never burns a classify pass on platform edm. 投递确认 / 面试通知 are
    // bulk but NOT ads → kept (they ARE the funnel's feed). The full delta is
    // still returned as `newEmails` for the briefing path to filter its own way.
    const activeTokens = this.skipTokens && this.skipTokens.length > 0 ? this.skipTokens : DEFAULT_SKIP_TOKENS
    const funnelEmails = [...byMessageId.values()].filter((e) => {
      if (shouldSkipFunnel(e, activeTokens) || isSchoolSpam(e, activeTokens)) return false
      const text = `${e.subject ?? ''} ${e.textBody ?? ''}`
      return isRecruitingVip(e) || RECRUITING_KEYWORD_RE.test(text)
    })
    if (funnelEmails.length === 0) {
      return {
        synced: 0,
        created: 0,
        pending: 0,
        message: '邮件推断：无新邮件需分类（群发已预过滤）',
        cursor: {
          mail163LastUid: nextMail163Uid || undefined,
          gmailLastInternalDate: nextGmailInternalDate || undefined
        },
        newEmails: [...byMessageId.values()]
      }
    }

    let output: ClassifyApplicationEmailOutput
    try {
      output = (await agentRuntime.runAgentStep('classify_application_email', {
        emails: funnelEmails
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
        },
        newEmails: [...byMessageId.values()]
      }
    }

    // Auto-create routing. A non-untrusted result with company AND position
    // AND confidence high/medium: normalize-dedupe against existing apps —
    // hit → append event; miss → create application + seed event. Low
    // confidence OR missing company/position → pending queue (no identity to
    // dedupe/create on, or the signal is too weak to trust as a real
    // application the user actually submitted). Untrusted → skip (§17).
    const apps = this.store.listApplications()
    let synced = 0
    let created = 0
    let pending = 0
    let tasksCreated = 0
    for (const r of output.results) {
      if (r.untrusted) continue // §17
      const email = byMessageId.get(r.messageId)
      if (!email) continue

      // 增量读取防重：若本邮件在数据库中已有对应的投递记录或事件，彻底跳过且清理可能残留的待确认
      const alreadyHandled = apps.some((a) => {
        if (a.emailRefId === r.messageId) return true
        const evts = this.store.listApplicationEvents(a.id)
        return evts.some((e) => e.sourceRef === `email:${r.messageId}`)
      })
      if (alreadyHandled) {
        this.emailMatches.delete(r.messageId)
        continue
      }

      // 1. Verification codes / tokens are NEVER application progress events (even from a hiring portal)
      const isVerificationCode = /(验证码|verification code|动态验证码|校验码)/i.test(email.subject + ' ' + (email.textBody || ''))
      if (isVerificationCode) {
        this.emailMatches.delete(r.messageId)
        continue
      }

      // 2. Explicit non-job / non-recruiting emails must NEVER enter the recruiting funnel or pending queue!
      const emailFullText = (email.subject + ' ' + (email.textBody || '')).toLowerCase()
      const isExplicitlyNonJob =
        r.isJobRelated === false ||
        /非求职|非招聘/i.test(r.evidence || '') ||
        /(域名服务|ci 通知|instagram|fontawesome)/i.test(r.evidence || '') ||
        /(run failed:|run succeeded:|workflow run|is active \(free plan\)|在动态中查看)/i.test(emailFullText)
      if (isExplicitlyNonJob) {
        this.emailMatches.delete(r.messageId)
        continue
      }

      const isRecruiting =
        isRecruitingVip(email) ||
        /(招聘|校招|求职|投递|应聘|简历|application|interview|recruitment|job offer|assessment)/i.test(email.subject)

      // Company fallback: extract from subject bracket e.g. 【途游游戏校招】, 【深信服科技】, [Shopee] or sender name
      if (!r.company) {
        const subjMatch = (email.subject || '').match(/[【「\[]([^】」\]]+)[】」\]]/)
        if (subjMatch && subjMatch[1]) {
          const raw = subjMatch[1].trim()
          const cleaned = raw.replace(/(?:校招组|校招|校园招聘|社会招聘|招聘官网|招聘|HR团队|HR|人力|官方|Recruitment|Careers|Team)/gi, '').trim()
          if (cleaned.length >= 2 && !/^(通知|提醒|温馨提示|重要|公告|验证码|Notice|Alert)$/i.test(cleaned)) {
            r.company = cleaned
          }
        }
        if (!r.company && email.from.name) {
          const fromCleaned = email.from.name.replace(/(?:校招组|校招|校园招聘|社会招聘|招聘官网|招聘|HR团队|HR|人力|官方|Recruitment|Careers|Team)/gi, '').trim()
          if (fromCleaned.length >= 2 && !/^(通知|提醒|温馨提示|重要|公告|验证码|No[- ]?reply)$/i.test(fromCleaned)) {
            r.company = fromCleaned
          }
        }
      }

      // ATS fallback: if position is empty, attempt regex extraction from email body/subject
      if (!r.position) {
        const extracted = extractPositionFromText(email.subject + '\n' + (email.textBody || ''))
        if (extracted) {
          r.position = extracted
        }
      }

      // ATS fallback: if jobCode is empty, attempt regex extraction from email body/subject
      if (!r.jobCode) {
        const extractedCode = extractJobCodeFromText(email.subject + '\n' + (email.textBody || ''))
        if (extractedCode) {
          r.jobCode = extractedCode
        }
      }

      if (isRecruiting && r.confidence === 'low') {
        r.confidence = 'medium'
      }

      // ADR 0026 — Job 待办事项同步提取：当邮件属于面试、笔试、在线测评或包含行动项时，同步生成/更新 Job 待办
      const isActionableJobEvent =
        Boolean(r.todoTitle) ||
        r.eventType === 'interview' ||
        r.eventType === 'written_test' ||
        r.eventType === 'assessment'

      if (isActionableJobEvent && this.taskService && !r.isCancelled) {
        const eventLabel =
          r.eventType === 'interview'
            ? '面试'
            : r.eventType === 'written_test'
              ? '笔试'
              : r.eventType === 'assessment'
                ? '在线测评'
                : '求职跟进'
        const defaultTitle = `${r.company || '公司'} ${eventLabel}${r.position ? ` · ${r.position}` : ''}`
        const taskTitle = r.todoTitle || defaultTitle

        const task = this.taskService.create({
          title: taskTitle,
          description: [r.evidence, r.meetingInfo].filter(Boolean).join('\n') || undefined,
          priority:
            r.eventType === 'interview' || r.eventType === 'written_test' || r.eventType === 'assessment'
              ? 'urgent'
              : 'high',
          dueAt: r.dueDate,
          sourceType: 'email',
          sourceId: `email:${r.messageId}`,
          sourceProvider: email.provider,
          category: r.category ?? 'job',
          sourceLink: email.sourceUrl
        })
        if (task.updatedAt === task.createdAt) tasksCreated++
      }

      // ── Job Code Matching (highest-confidence deterministic requisition matching) ──
      const codeMatch = r.jobCode && r.company
        ? apps.find((a) => {
            if (!a.jobCode) return false
            if (a.jobCode.trim().toLowerCase() !== r.jobCode!.trim().toLowerCase()) return false
            if (!this.isSameCompany(a.company, r.company!)) return false
            if (!this.isPositionCompatible(a.position, r.position)) return false
            return true
          })
        : undefined

      const companyApps = this.findApplicationsByCompany(apps, r.company || codeMatch?.company || '')

      // ── Find matching application among existing applications ──
      let match = codeMatch
      if (!match && r.company && r.position) {
        match = this.findApplicationByNormalized(apps, r.company, r.position)
      }
      if (!match && companyApps.length === 1) {
        const singleApp = companyApps[0]
        const singlePosNorm = normalizePosition(singleApp.position)
        const emailPosNorm = r.position ? normalizePosition(r.position) : ''
        const isSubsequentRound =
          Boolean(r.round && /(?:2|3|4|5|二|三|四|五|终|复试|总监|hr|综合|加面)/i.test(r.round)) ||
          /(?:二面|三面|四面|终面|复试|终审|2nd round|final round|hr面)/i.test(email.subject + ' ' + (r.evidence || '')) ||
          Boolean(r.isReschedule || r.isCancelled)

        // 确定性归并硬逻辑：
        // 1) 岗位名称规范化一致 -> 归并到已有记录
        // 2) 已有记录为'未知岗位' -> 归并并补齐岗位名称
        // 3) 显式后续面试轮次 (二面/三面/终面/复试/HR面/改期/取消) -> 归并到已有记录
        if (
          (r.position && singlePosNorm === emailPosNorm) ||
          singleApp.position === '未知岗位' ||
          isSubsequentRound
        ) {
          match = singleApp
        }
      }

      // If no existing match, evaluate if it can auto-create or must escalate to human
      if (!match) {
        // 1. 公司主体缺失 -> 无法确定归属或新建 -> 进入待人工确认队列
        if (!r.company) {
          this.pushPending(r, email, undefined, companyApps)
          pending++
          continue
        }

        // 2. 缺失岗位信息 -> 信息不全，生成待确认候选记录，由人工决定归并已有记录或新建
        if (!r.position) {
          this.pushPending(r, email, companyApps.length === 1 ? companyApps[0].id : undefined, companyApps)
          pending++
          continue
        }

        // 3. 低置信度非招聘推广邮件
        if (r.confidence === 'low' && !isRecruiting) {
          this.pushPending(r, email, companyApps.length === 1 ? companyApps[0].id : undefined, companyApps)
          pending++
          continue
        }
      }

      // ── Scenario 12: 会前提醒防重 (1-hour before meeting reminder) ──
      if (/(会议即将开始|会议提醒|日程提醒|即将开始|reminder)/i.test(email.subject)) {
        const candidateApp = match || (companyApps.length > 0 ? companyApps[0] : undefined)
        if (candidateApp) {
          const events = this.store.listApplicationEvents(candidateApp.id)
          const hasRecentInterview = events.some(
            (e) =>
              e.type === 'interview' &&
              Math.abs(new Date(e.eventAt).getTime() - new Date(email.receivedAt).getTime()) < 24 * 3600 * 1000
          )
          if (hasRecentInterview) {
            continue
          }
        }
      }

      // ── Scenario 09: 面试改期 (Reschedule) ──
      if (r.isReschedule || /(改期|时间调整|重新安排|reschedule)/i.test(email.subject + ' ' + (r.evidence || ''))) {
        if (match) {
          const events = this.store.listApplicationEvents(match.id)
          const latestInterview = [...events].reverse().find((e) => e.type === 'interview')
          if (latestInterview) {
            this.store.deleteApplicationEvent(latestInterview.id)
            this.store.createApplicationEvent({
              ...latestInterview,
              eventAt: r.dueDate || email.receivedAt,
              evidence: `【改期】${r.evidence || email.subject}`
            })
            if (r.dueDate) {
              this.store.updateApplication(match.id, { stageDeadline: r.dueDate })
            }
            synced++
            continue
          }
        }
      }

      // ── Scenario 10: 面试取消 (Cancelled) ──
      if (r.isCancelled || /(取消面试|面试取消|行程取消)/i.test(email.subject + ' ' + (r.evidence || ''))) {
        if (match) {
          this.store.createApplicationEvent({
            id: newId('appevt'),
            applicationId: match.id,
            type: 'communicated',
            source: 'email',
            sourceRef: `email:${r.messageId}`,
            evidence: `【已取消】${r.evidence || email.subject}`,
            locked: true,
            eventAt: email.receivedAt,
            createdAt: nowIso()
          })
          synced++
          continue
        }
      }
      let appId: string
      if (match) {
        appId = match.id

        // Backfill jobCode if existing application lacked it
        if (!match.jobCode && r.jobCode) {
          match.jobCode = r.jobCode
          this.store.updateApplication(match.id, { jobCode: r.jobCode })
        }
        // Backfill position if existing application was '未知岗位'
        if ((!match.position || match.position === '未知岗位') && r.position && r.position !== '未知岗位') {
          match.position = r.position
          this.store.updateApplication(match.id, { position: r.position })
        }

        // Auto-enrich JD if existing application lacked it
        if (!match.jdText && this.jdFetcher && (match.company || r.company)) {
          const c = match.company || r.company!
          const p = match.position || r.position || ''
          const jc = match.jobCode || r.jobCode
          void this.jdFetcher(c, p, jc).then((text) => {
            if (text) this.updateJdText(match.id, text)
          }).catch(() => {})
        }

        // ── Scenario 08: 模糊轮次面试自动递进 ──
        if (r.eventType === 'interview') {
          const existingEvents = this.store.listApplicationEvents(match.id)
          const interviewCount = existingEvents.filter((e) => e.type === 'interview').length
          if (interviewCount > 0 && !r.round) {
            r.round = `${interviewCount + 1}面`
          }
        }
      } else {
        // high/medium confidence + company + position → create application.
        const isSuspendedJd = r.eventType === 'interview' && !r.jdExcerpt
        const view = this.create({
          company: r.company || '未知公司',
          position: r.position || '未知岗位',
          jobCode: r.jobCode,
          source: 'email',
          appliedAt: email.receivedAt,
          city: r.city,
          salaryRange: r.salary,
          jdText: r.jdExcerpt,
          stageDeadline: r.dueDate,
          interviewLink: r.meetingInfo,
          prepStatus: isSuspendedJd ? 'suspended_missing_jd' : 'none'
        })
        // Link the new application to this email so future mail in the thread
        // matches directly (mirrors confirmEmailMatch's direct-link seeding).
        this.store.updateApplication(view.application.id, { emailRefId: r.messageId })
        view.application.emailRefId = r.messageId
        appId = view.application.id
        created++
        apps.push(view.application)

        // Auto-enrich JD if new application lacks it
        if (!view.application.jdText && this.jdFetcher && r.company) {
          void this.jdFetcher(r.company, r.position || '', r.jobCode).then((text) => {
            if (text) this.updateJdText(view.application.id, text)
          }).catch(() => {})
        }
      }
      if (this.appendEmailEvent(appId, r, email)) synced++
      this.emailMatches.delete(r.messageId)
    }
    this.broadcastEmailMatches()
    if (tasksCreated > 0) this.onTasksChanged?.()
    this.activityService.record({
      type: 'tool_completed',
      summary: `邮件推断完成：${synced} 条事件、${created} 条新建、${pending} 条待确认`,
      metadata: { synced, created, pending, tasksCreated }
    })
    return {
      synced,
      created,
      pending,
      message: `邮件推断完成：${synced} 事件 / ${created} 新建 / ${pending} 待确认`,
      cursor: {
        mail163LastUid: nextMail163Uid || undefined,
        gmailLastInternalDate: nextGmailInternalDate || undefined
      },
      newEmails: [...byMessageId.values()]
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

  /** Find all applications for a given company (used for multi-job disambiguation). */
  private findApplicationsByCompany(apps: Application[], company: string): Application[] {
    const nc = normalizeCompany(company)
    if (!nc) return []
    return apps.filter((a) => normalizeCompany(a.company) === nc)
  }

  private isSameCompany(c1: string | undefined, c2: string | undefined): boolean {
    const n1 = normalizeCompany(c1)
    const n2 = normalizeCompany(c2)
    if (!n1 || !n2) return false
    return n1 === n2 || n1.includes(n2) || n2.includes(n1)
  }

  private isPositionCompatible(pos1: string | undefined, pos2: string | undefined): boolean {
    if (!pos1 || !pos2) return true
    if (pos1 === '未知岗位' || pos2 === '未知岗位') return true
    const n1 = normalizePosition(pos1)
    const n2 = normalizePosition(pos2)
    if (n1 === n2) return true
    if (n1.includes(n2) || n2.includes(n1)) return true
    return false
  }

  /**
   * Data repair migration:
   * 1. Detect applications with bogus jobCode (e.g. 'uirements' or blacklisted words) and clear them.
   * 2. Detect applications that erroneously merged multiple distinct job application events
   *    (e.g. distinct positions in applied events under the same company).
   * 3. Split them into separate clean application records, each retaining its own email event.
   */
  repairBogusJobCodeMerges(): { repaired: number; splitApps: number } {
    let repaired = 0
    let splitApps = 0

    const apps = this.store.listApplications()
    for (const app of apps) {
      // 1. Clear bogus jobCode
      if (
        app.jobCode &&
        (INVALID_JOB_CODES.has(app.jobCode.toLowerCase()) || app.jobCode.toLowerCase() === 'uirements')
      ) {
        this.store.updateApplication(app.id, { jobCode: undefined })
        app.jobCode = undefined
        repaired++
      }

      // 2. Check for erroneously merged multiple distinct email-applied events
      const events = this.store.listApplicationEvents(app.id)
      const emailAppliedEvents = events.filter((e) => e.type === 'applied' && e.sourceRef?.startsWith('email:'))

      if (emailAppliedEvents.length > 1) {
        // Parse position for each event
        const parsedPositions = emailAppliedEvents.map((evt) => {
          const evidence = evt.evidence || ''
          const pos = extractPositionFromText(evidence) || app.position
          return { evt, pos, evidence }
        })

        // Check if there are distinct positions
        const distinctPositions = new Set(parsedPositions.map((p) => normalizePosition(p.pos)))
        if (distinctPositions.size > 1) {
          // Erroneous multi-job merge detected!
          // Remove any redundant empty seed applied event (event without sourceRef or evidence)
          const emptySeedEvents = events.filter((e) => e.type === 'applied' && !e.sourceRef && !e.evidence)
          for (const emptyEvt of emptySeedEvents) {
            this.store.deleteApplicationEvent(emptyEvt.id)
          }

          // Keep the first email event with the existing app (updating position if appropriate)
          const first = parsedPositions[0]
          this.store.updateApplication(app.id, {
            position: first.pos,
            emailRefId: first.evt.sourceRef?.replace(/^email:/, '')
          })

          // For the remaining distinct email events, split each into its own Application
          for (let i = 1; i < parsedPositions.length; i++) {
            const item = parsedPositions[i]
            const newAppId = newId('app')
            const now = item.evt.eventAt || nowIso()
            const messageId = item.evt.sourceRef?.replace(/^email:/, '')

            const newApp: Application = {
              id: newAppId,
              company: app.company,
              position: item.pos,
              jobCode: undefined,
              source: 'email',
              appliedAt: now,
              emailRefId: messageId,
              notes: app.notes,
              city: app.city,
              salaryRange: app.salaryRange,
              jdText: undefined,
              stage: '已投递',
              prepStatus: 'none',
              priority: 'normal',
              createdAt: item.evt.createdAt || now,
              updatedAt: now
            }
            this.store.createApplication(newApp)

            // Rebind the event to the new application
            this.store.deleteApplicationEvent(item.evt.id)
            this.store.createApplicationEvent({
              ...item.evt,
              id: newId('appevt'),
              applicationId: newAppId
            })

            splitApps++
          }
          repaired++
        }
      }
    }

    if (repaired > 0 || splitApps > 0) {
      this.broadcastApplications()
      console.log(
        `[application-service] Repaired bogus job code merges: repaired ${repaired}, created ${splitApps} split applications`
      )
    }

    return { repaired, splitApps }
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
    // Verification codes and explicit non-job emails must NEVER be appended as application progress events
    if (
      r.isJobRelated === false ||
      /非求职|非招聘/i.test(r.evidence || '') ||
      /(验证码|verification code|动态验证码|校验码)/i.test(email.subject + ' ' + (email.textBody || ''))
    ) {
      return false
    }
    const sourceRef = `email:${r.messageId}`
    const existing = this.store.getApplicationEventBySourceRef(applicationId, sourceRef)
    if (existing) return false
    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId,
      type: r.eventType,
      source: 'email',
      sourceRef,
      evidence: [r.evidence || email.subject, r.meetingInfo].filter(Boolean).join(' ｜ '),
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
      if (!app.interviewLink && r.meetingInfo) patch.interviewLink = r.meetingInfo
      if (!app.stageDeadline && r.dueDate) patch.stageDeadline = r.dueDate
      if (Object.keys(patch).length > 0) this.store.updateApplication(applicationId, patch)
    }
    return true
  }

  /** Push a low-confidence / unmatched result into the manual-confirm queue. */
  private pushPending(
    r: ApplicationEmailResult,
    email: NormalizedEmail,
    applicationId?: string,
    candidateApps?: Application[]
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
      jobCode: r.jobCode,
      confidence: r.confidence,
      applicationId,
      applicationCompany: existing?.company,
      applicationPosition: existing?.position,
      applicationJobCode: existing?.jobCode,
      candidateApplications: candidateApps?.map((a) => ({
        id: a.id,
        company: a.company,
        position: a.position,
        jobCode: a.jobCode
      })),
      meetingInfo: r.meetingInfo,
      isReschedule: r.isReschedule,
      isCancelled: r.isCancelled,
      evidence: r.evidence
    })
  }

  /** The current pending-queue proposals (renderer sub-section, §3.3). */
  listPendingEmailMatches(): EmailMatchProposal[] {
    const apps = this.store.listApplications()
    // Purge non-job items or already-handled / uniquely-matched items on the fly
    for (const [id, p] of this.emailMatches.entries()) {
      if (
        /非求职|非招聘/i.test(p.evidence || '') ||
        /(域名服务|ci 通知|instagram|fontawesome|验证码)/i.test(p.evidence || '') ||
        /(run failed|is active \(free plan\)|在动态中查看)/i.test(p.subject.toLowerCase()) ||
        /(cloudflare|github|instagram|fontawesome)/i.test(p.from?.toLowerCase() || '')
      ) {
        this.emailMatches.delete(id)
        continue
      }
      // If already recorded in applications or events, remove from pending
      const handled = apps.some((a) => {
        if (a.emailRefId === id) return true
        const evts = this.store.listApplicationEvents(a.id)
        return evts.some((e) => e.sourceRef === `email:${id}`)
      })
      if (handled) {
        this.emailMatches.delete(id)
        continue
      }
      // If uniquely matched by jobCode in existing applications, remove from pending
      if (p.jobCode) {
        const codeMatch = apps.find(
          (a) => a.jobCode && a.jobCode.trim().toLowerCase() === p.jobCode!.trim().toLowerCase()
        )
        if (codeMatch) {
          this.emailMatches.delete(id)
          continue
        }
      }
    }
    return [...this.emailMatches.values()]
  }

  /**
   * Confirm a pending proposal: append the email event to the given application,
   * or to a freshly-created application (with `emailRefId` set so future mail in
   * the thread links directly). Removes the proposal from the queue.
   */
  confirmEmailMatch(
    messageId: string,
    applicationId?: string,
    options?: { company?: string; position?: string; eventType?: ApplicationEventType; jobCode?: string }
  ): void {
    const proposal = this.emailMatches.get(messageId)
    if (!proposal) return
    let appId = applicationId
    const jobCodeToSet = options?.jobCode?.trim() || proposal.jobCode
    if (!appId) {
      const company = options?.company?.trim() || proposal.company || '未知公司'
      const position = options?.position?.trim() || proposal.position || '未知岗位'
      const created = this.create({
        company,
        position,
        jobCode: jobCodeToSet,
        source: 'email'
      })
      appId = created.application.id
      // Link the new application to this email so future mail matches directly.
      this.store.updateApplication(appId, { emailRefId: messageId })
    } else {
      // If merging into an existing application, check if its position was '未知岗位' or if jobCode can be updated
      const app = this.store.getApplication(appId)
      if (app) {
        const patch: Partial<Application> = {}
        if (!app.position || app.position === '未知岗位') {
          const newPos = options?.position?.trim() || proposal.position
          if (newPos && newPos !== '未知岗位') {
            patch.position = newPos
          }
        }
        if (!app.jobCode && jobCodeToSet) {
          patch.jobCode = jobCodeToSet
        }
        if (Object.keys(patch).length > 0) {
          this.store.updateApplication(appId, patch)
        }
      }
    }
    const eventType = options?.eventType || proposal.eventType
    const sourceRef = `email:${messageId}`
    const existing = this.store.getApplicationEventBySourceRef(appId, sourceRef)
    if (!existing) {
      this.store.createApplicationEvent({
        id: newId('appevt'),
        applicationId: appId,
        type: eventType,
        source: 'email',
        sourceRef,
        evidence: proposal.evidence ?? proposal.subject,
        locked: true, // user-confirmed → locked (user truth)
        eventAt: nowIso(),
        createdAt: nowIso()
      })
    }

    // Synchronously ensure Job ToDo exists/updates with the user-confirmed details
    if (this.taskService) {
      const targetApp = this.store.getApplication(appId)
      const comp = options?.company?.trim() || targetApp?.company || proposal.company || '公司'
      const pos = options?.position?.trim() || targetApp?.position || proposal.position
      const finalEventType = options?.eventType || proposal.eventType
      if (
        finalEventType === 'interview' ||
        finalEventType === 'written_test' ||
        finalEventType === 'assessment'
      ) {
        const eventLabel =
          finalEventType === 'interview'
            ? '面试'
            : finalEventType === 'written_test'
              ? '笔试'
              : '在线测评'
        const expectedTitle = `${comp} ${eventLabel}${pos && pos !== '未知岗位' ? ` · ${pos}` : ''}`
        const existingTask = this.store.getTaskBySource('email', sourceRef)
        if (existingTask) {
          this.store.updateTask(existingTask.id, {
            title: expectedTitle,
            description: [proposal.evidence, proposal.meetingInfo].filter(Boolean).join('\n') || existingTask.description
          })
        } else {
          this.taskService.create({
            title: expectedTitle,
            description: [proposal.evidence, proposal.meetingInfo].filter(Boolean).join('\n') || undefined,
            priority: 'urgent',
            dueAt: targetApp?.stageDeadline,
            sourceType: 'email',
            sourceId: sourceRef,
            category: 'job'
          })
        }
        this.onTasksChanged?.()
      }
    }

    this.emailMatches.delete(messageId)
    this.broadcastEmailMatches()
  }

  /** Clear all non-job proposals from the pending queue. */
  cleanupPendingEmailMatches(): void {
    for (const [id, p] of this.emailMatches.entries()) {
      if (
        /非求职|非招聘/i.test(p.evidence || '') ||
        /(域名服务|ci 通知|instagram|fontawesome|验证码)/i.test(p.evidence || '') ||
        /(run failed|is active \(free plan\)|在动态中查看)/i.test(p.subject.toLowerCase()) ||
        /(cloudflare|github|instagram|fontawesome)/i.test(p.from?.toLowerCase() || '')
      ) {
        this.emailMatches.delete(id)
      }
    }
    this.broadcastEmailMatches()
  }

  /** Clear all proposals from the pending queue. */
  clearAllPendingEmailMatches(): void {
    this.emailMatches.clear()
    this.broadcastEmailMatches()
  }

  /** Dismiss a pending proposal without acting on it. */
  ignoreEmailMatch(messageId: string): void {
    this.emailMatches.delete(messageId)
    this.broadcastEmailMatches()
  }

  /**
   * Undo a previous email event match: removes the event from the application
   * timeline and restores it to the pending proposals queue so the user can
   * re-assign or split it (HITL safety lock).
   */
  undoEmailEvent(applicationId: string, eventId: string): boolean {
    const app = this.store.getApplication(applicationId)
    if (!app) return false
    const events = this.store.listApplicationEvents(applicationId)
    const target = events.find((e) => e.id === eventId)
    if (!target) return false

    this.store.deleteApplicationEvent(eventId)

    if (target.sourceRef?.startsWith('email:')) {
      const messageId = target.sourceRef.replace(/^email:/, '').replace(/:seed_applied$/, '')
      this.emailMatches.set(messageId, {
        id: newId('ematch'),
        messageId,
        subject: target.evidence || '已撤回事件 — 请重新确认归并',
        eventType: target.type,
        company: app.company,
        position: app.position,
        confidence: 'medium',
        evidence: target.evidence
      })
    }

    this.broadcastEmailMatches()
    this.broadcastApplications()
    return true
  }

  /**
   * Rebind an event from one application to another (e.g. user corrected a multi-job merge).
   */
  rebindEmailEvent(fromAppId: string, eventId: string, toAppId: string): boolean {
    const fromApp = this.store.getApplication(fromAppId)
    const toApp = this.store.getApplication(toAppId)
    if (!fromApp || !toApp) return false

    const events = this.store.listApplicationEvents(fromAppId)
    const target = events.find((e) => e.id === eventId)
    if (!target) return false

    this.store.deleteApplicationEvent(eventId)
    this.store.createApplicationEvent({
      ...target,
      id: newId('appevt'),
      applicationId: toAppId,
      createdAt: nowIso()
    })

    this.broadcastApplications()
    return true
  }

  /**
   * Delete a specific application event and recompute status.
   */
  deleteEvent(applicationId: string, eventId: string): ApplicationView {
    const app = this.store.getApplication(applicationId)
    if (!app) throw new Error(`未找到投递记录：${applicationId}`)
    this.store.deleteApplicationEvent(eventId)
    this.broadcastApplications()
    return this.toView(app)
  }

  /**
   * Manually update the current status/stage of an application.
   * Creates a locked manual event to pin the application status.
   */
  updateStatus(
    applicationId: string,
    status: ApplicationEventType,
    options?: { round?: number; evidence?: string; eventAt?: string }
  ): ApplicationView {
    const app = this.store.getApplication(applicationId)
    if (!app) throw new Error(`未找到投递记录：${applicationId}`)
    const now = nowIso()
    let defaultEvidence = options?.evidence
    if (!defaultEvidence) {
      if (status === 'rejected') defaultEvidence = '收到感谢信'
      else if (status === 'offer') defaultEvidence = '获得录用'
      else if (status === 'interview') defaultEvidence = options?.round ? `${options.round}面` : '面试'
      else if (status === 'written_test') defaultEvidence = '专业笔试'
      else if (status === 'assessment') defaultEvidence = '在线测评'
      else if (status === 'applied') defaultEvidence = '简历投递'
      else if (status === 'withdrawn') defaultEvidence = '已放弃/撤回'
      else defaultEvidence = '手动修改状态'
    }

    this.store.createApplicationEvent({
      id: newId('appevt'),
      applicationId,
      type: status,
      round: options?.round,
      source: 'manual',
      evidence: defaultEvidence,
      locked: true,
      eventAt: options?.eventAt || now,
      createdAt: now
    })

    const stageMap: Record<ApplicationEventType, string> = {
      applied: '已投递',
      communicated: '已沟通',
      assessment: '在线测评',
      written_test: '专业笔试',
      interview: options?.round ? `${options.round}面` : '面试',
      offer: '已录用',
      rejected: '流程结束',
      withdrawn: '已撤回'
    }
    this.store.updateApplication(applicationId, { stage: stageMap[status] })

    this.broadcastApplications()
    return this.toView(app)
  }

  /**
   * Update JD text on an application. If prepStatus was suspended due to missing JD,
   * it is automatically promoted to 'ready' to unlock interview prep generation.
   */
  updateJdText(applicationId: string, jdText: string): Application | undefined {
    const app = this.store.getApplication(applicationId)
    if (!app) return undefined
    const patch: ApplicationUpdateFields = {
      jdText,
      prepStatus: app.prepStatus === 'suspended_missing_jd' ? 'ready' : app.prepStatus
    }
    const updated = this.store.updateApplication(applicationId, patch)
    this.broadcastApplications()
    return updated ?? undefined
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Seed an `applied` event — idempotent by sourceRef / always for manual. */
  private seedAppliedEvent(
    applicationId: string,
    source: 'boss' | 'email' | 'manual',
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
   * Regenerate an interview transcript (prep material) for an application on
   * demand. Pulls the latest resume + 面经 notes for the company, runs the
   * `generate_interview_transcript` agent step, and saves a new prep version.
   * (The `interview_prep` routine is the auto-triggered equivalent; this is
   * the manual "重新生成" path.)
   */
  async generatePrepMaterial(applicationId: string, agentRuntime: AgentRuntime): Promise<PrepMaterial> {
    const app = this.store.getApplication(applicationId)
    if (!app) throw new Error(`未找到投递记录：${applicationId}`)

    // Anti-hallucination guard: if JD is missing, suspend generation and guide completion!
    if (!app.jdText || app.jdText.trim().length === 0) {
      this.store.updateApplication(applicationId, { prepStatus: 'suspended_missing_jd' })
      this.broadcastApplications()
      throw new Error(`当前投递记录（${app.company} · ${app.position}）缺失岗位 JD，已暂缓深度备战资料生成。请先补充 JD（手动粘贴或联网搜索）后再生成。`)
    }

    const notes = this.listInterviewNotes(app.company)
    const resume = this.getLatestResume(applicationId)
    let resumeText = resume?.html
    if (resumeText && (resumeText.startsWith('data:application/pdf;base64,') || resumeText.startsWith('JVBERi0'))) {
      try {
        const base64 = resumeText.startsWith('data:') ? resumeText.split(',')[1] : resumeText
        const buf = Buffer.from(base64, 'base64')
        const extracted = await extractTextFromPdf(buf)
        if (extracted) resumeText = extracted
      } catch {
        // keep fallback
      }
    }
    const output = (await agentRuntime.runAgentStep('generate_interview_transcript', {
      company: app.company,
      position: app.position,
      jdText: app.jdText,
      resume: resumeText,
      notes
    })) as InterviewTranscriptOutput
    this.store.updateApplication(applicationId, { prepStatus: 'ready' })
    this.broadcastApplications()
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
