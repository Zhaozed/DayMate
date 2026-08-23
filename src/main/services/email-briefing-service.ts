// Email Briefing Service — surfaces important incoming mail as Need-to-Know
// (urgent / high) and auto-drafts replies, both driven by the container's
// real-time email sync loop (~3-min per-provider cursor delta). This is the
// "必读 = 邮件驱动" path: a recruiting / 账单 / 导师 / 会议 email lands and,
// within one sync tick, appears in 必读 (and, if it needs a reply, gets a
// tone-mirrored draft saved to the Drafts folder — no approval, per the user's
// §15 opt-out, ADR 0022; sending stays R3/forbidden, the user sends manually
// from their mail client).
//
// classify_inbox (NOT classify_application_email) is used here because it
// carries the topic dimension (fees_billing / recruiting / meeting) and the
// action bucket (reply / follow_up) — the signals that make an email "必读-
// worthy". The sync loop already ran classify_application_email on the same
// delta for the application funnel; the two classifiers serve different
// purposes and the delta is small (cursor-gated), so the double pass is cheap.
//
// Idempotency: the sync cursor means each email is processed once; we also
// de-dupe by `email:<messageId>` sourceRef against existing NTK so a retried
// tick never double-writes. Untrusted mail (§17) is skipped entirely — never
// a 必读 item, never a draft.

import type {
  NormalizedEmail,
  EmailClassificationResult,
  EmailClassification,
  EmailTopic,
  MemoryItem,
  TaskPriority,
  BriefingCategory
} from '@shared/types'
import type { AgentRuntime, ClassifyInboxOutput, DraftReplyOutput } from '../agent/agent-runtime'
import type { NeedToKnowService } from './need-to-know-service'
import type { TaskService } from './task-service'
import type { ToolRegistry, ToolContext } from '../agent/tool-registry'
import type { MemoryService } from './memory-service'
import type { EmailProvider } from '../providers/email/email-provider'
import type { ActivityService } from './activity-service'
import { isSchoolSpam, shouldSkipBriefing } from '../util/bulk-mail'

const IMPORTANT_TOPICS = new Set(['recruiting', 'fees_billing', 'meeting'])

/** Deterministic fallback for the 4-value 必读 section tag when the model /
 *  stub omits `briefingCategory` (ADR 0029). 账单/会议/动态 collapse into
 *  'daily'; recruiting → 'job'; ads → 'other'. */
const TOPIC_TO_BRIEFING: Record<EmailTopic, BriefingCategory> = {
  fees_billing: 'daily',
  recruiting: 'job',
  ads: 'other',
  meeting: 'daily',
  general: 'daily'
}

/** Deterministic priority for an auto-extracted mail ToDo (ADR 0026). Stable +
 *  predictable; the model only judges "useful" (via todoTitle) + dates. */
function todoPriority(topic: EmailTopic, classification: EmailClassification): TaskPriority {
  if (topic === 'recruiting' || topic === 'fees_billing') return 'urgent'
  if (topic === 'meeting' || classification === 'follow_up') return 'high'
  return 'medium'
}

function snippet(text: string, max = 120): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export interface EmailBriefingDeps {
  agentRuntime: AgentRuntime
  needToKnowService: NeedToKnowService
  toolRegistry: ToolRegistry
  memoryService: MemoryService
  emailProviders: EmailProvider[]
  activityService: ActivityService
  /** A base ToolContext for the auto-draft's `email.create_draft` call.
   *  Built once by the container (mirrors the on-demand IPC handler pattern). */
  toolContext: ToolContext
  /** Task service for auto-extracted mail ToDos (ADR 0026). Absent on test
   *  runtimes that don't exercise ToDo extraction. */
  taskService?: TaskService
  /** Fired when a ToDo is created so the container can broadcast
   *  TASKS_CHANGED → Home refreshes. ADR 0026. */
  onTasksChanged?: () => void
  /** Subject-substring tokens treated as school-wide broadcast spam (ADR 0027).
   *  Mail whose subject matches is skipped BEFORE any LLM call — never a 必读
   *  item, never a ToDo. Defaults to `['[student_ips]']`. */
  skipTokens?: string[]
}

export class EmailBriefingService {
  constructor(private readonly deps: EmailBriefingDeps) {}

  /** ADR 0027 — mutable school-spam skip tokens (wired asynchronously from
   *  settings at boot + on IPC change; the deps field is the initial value). */
  private skipTokens?: string[] = undefined

  setSkipTokens(tokens: string[] | undefined): void {
    this.skipTokens = tokens
  }

  /** Classify a delta of new emails, publish urgent/high NTK for the
   *  important ones, and auto-draft replies for reply-needed important mail.
   *  Returns counts for the Activity log. Idempotent by sourceRef.
   *
   *  Pre-LLM filter (ADR 0023 + ADR 0027 fix): bulk mail is dropped BEFORE
   *  any LLM call — never a 必读 item, never a ToDo, zero LLM cost. Bulk
   *  (LinkedIn recruiting ads / game notifications / platform digests /
   *  system auto-notifications / mailing-list broadcasts) is exactly the junk
   *  the user wants OUT; only real-person 学院/专业/私人 mail is 必读-worthy.
   *  Non-bulk (real-person) mail → classify_inbox (LLM) → urgent/high +
   *  auto-draft for reply-needed important mail. */
  async briefNewEmails(
    newEmails: NormalizedEmail[],
    opts: { skipDrafts?: boolean } = {}
  ): Promise<{ surfaced: number; drafted: number; tasksCreated: number }> {
    if (newEmails.length === 0) return { surfaced: 0, drafted: 0, tasksCreated: 0 }

    // ADR 0027 — school-wide broadcast spam (subject prefix like [student_ips])
    // is dropped BEFORE any LLM call and never surfaces. The user explicitly
    // considers such mail noise to hide, not ToDo-able. 学院/专业/私人 mail
    // (no skip token) flows on normally.
    const skipTokens = this.skipTokens ?? this.deps.skipTokens
    const realEmails = skipTokens
      ? newEmails.filter((e) => !isSchoolSpam(e, skipTokens))
      : newEmails
    if (realEmails.length === 0) return { surfaced: 0, drafted: 0, tasksCreated: 0 }

    // De-dupe against existing NTK sourceRefs so a retried tick never
    // double-writes (the cursor is the primary gate; this is the safety net).
    const seen = new Set(
      this.deps.needToKnowService
        .list()
        .flatMap((n) => n.sourceRefs.map((s) => s.id))
    )

    let surfaced = 0
    let drafted = 0
    let tasksCreated = 0

    // ADR 0029 — relaxed 必读 filter. Pure ads, verification codes, security
    // alerts, and school-spam are dropped pre-LLM (shouldSkipBriefing). Bulk
    // mail that is NOT any of those is OPERATION-TRIGGERED (投递确认 / 面试通知
    // / 报名成功 / 收据 / 发送回执 / opted-in deploy-status) — the user wants
    // these KEPT, so they flow on to classify_inbox (NOT dropped pre-LLM like
    // ADR 0027/0028 did). This replaces the old "drop ALL bulk" strict bar.
    //
    // ADR 0029 fix — surfacing still requires an IMPORTANT topic (recruiting /
    // fees_billing / meeting) or an ACTIONABLE bucket (reply / follow_up). The
    // earlier draft surfaced ANY bulk that cleared the pre-filter as `medium`,
    // which let Grab / Malay promo marketing the narrow ADS_KEYWORD_RE missed
    // flood 必读 (the pre-filter can't deterministically tell "Flash Sale" from
    // "投递成功"). Operation-triggered mail the user actually cares about all
    // lands on an important topic anyway (投递/面试→recruiting, 账单/收据→
    // fees_billing, 会议/邀请→meeting), so the topic gate catches it without the
    // blanket bulk override that let marketing through. The LLM `ignore` verdict
    // is ALWAYS respected — unsolicited marketing the pre-filter missed is
    // dropped here, not force-surfaced.
    const humanEmails = realEmails.filter((e) => !shouldSkipBriefing(e, skipTokens))
    if (humanEmails.length > 0) {
      let cls: ClassifyInboxOutput
      try {
        cls = (await this.deps.agentRuntime.runAgentStep('classify_inbox', {
          emails: humanEmails
        })) as ClassifyInboxOutput
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.activityService.record({
          type: 'agent_failed',
          summary: `必读邮件分类失败：${message}`,
          metadata: { error: message }
        })
        if (surfaced > 0) {
          this.deps.activityService.record({
            type: 'tool_completed',
            summary: `必读新增 ${surfaced} 项`,
            metadata: { surfaced, drafted }
          })
        }
        if (tasksCreated > 0) this.deps.onTasksChanged?.()
        return { surfaced, drafted, tasksCreated }
      }
      for (const r of cls.results as EmailClassificationResult[]) {
        if (r.untrusted) continue // §17 — never a 必读 item from untrusted mail
        const email = humanEmails.find((e) => e.messageId === r.messageId)
        // Always respect the LLM `ignore` verdict — even for bulk. Unsolicited
        // marketing the pre-LLM gate can't catch deterministically (Grab / Malay
        // promo "Flash Sale", "Deals", "Diskaun" the narrow ADS_KEYWORD_RE misses)
        // is dropped here instead of force-surfaced. Operation-triggered mail
        // the user wants surfaces via the important-topic gate below.
        if (r.classification === 'ignore') continue

        // ADR 0026 — auto-extract a ToDo when the model judged there is a
        // concrete, useful next step (todoTitle present). No new LLM call:
        // this rides on the classify_inbox pass already running on humanEmails.
        // Idempotent by sourceId (`email:<messageId>`). Created BEFORE the
        // important/actionable NTK check so a todoTitle-only mail still lands
        // a ToDo even when it isn't 必读-worthy.
        if (r.todoTitle && email && this.deps.taskService) {
          const created = this.deps.taskService.create({
            title: r.todoTitle,
            description: r.reason || undefined,
            priority: todoPriority(r.topic, r.classification),
            dueAt: r.dueDate,
            sourceType: 'email',
            sourceId: `email:${r.messageId}`,
            sourceProvider: email.provider,
            // ADR 0027 — coarse domain tag + deep link back to the source mail
            // (Gmail only; 163 has no web deep link → sourceLink undefined).
            category: r.category,
            sourceLink: email.sourceUrl
          })
          // create() returns the existing task on a (sourceType,sourceId) hit;
          // only count genuinely new ones.
          if (created.updatedAt === created.createdAt) tasksCreated++
        }

        const important = IMPORTANT_TOPICS.has(r.topic)
        const actionable = r.classification === 'reply' || r.classification === 'follow_up'
        if (!important && !actionable) continue
        if (!email) continue

        const sourceRefId = `email:${r.messageId}`
        if (seen.has(sourceRefId)) continue
        const priority = r.topic === 'recruiting' || r.topic === 'fees_billing' ? 'urgent' : 'high'
        const briefingCat = r.briefingCategory ?? TOPIC_TO_BRIEFING[r.topic] ?? 'other'

        // ADR 0029 — thread merge: collapse same-thread emails into ONE 必读
        // item. If an active NTK exists for this threadId (+provider+account),
        // append this email's sourceRef + bump the headline to the latest;
        // else create a new thread-NTK. Title is the bare subject (no 【topic】
        // prefix — the section header already labels the 4 classes).
        const existingThread = email.threadId
          ? this.deps.needToKnowService
              .list()
              .find(
                (n) =>
                  n.threadId === email.threadId &&
                  n.sourceProvider === email.provider &&
                  n.sourceAccountId === email.accountId
              )
          : undefined
        if (existingThread) {
          const hasRef = existingThread.sourceRefs.some((s) => s.id === sourceRefId)
          this.deps.needToKnowService.update(existingThread.id, {
            title: r.reason || email.subject,
            summary: snippet(email.textBody),
            sourceRefs: hasRef
              ? existingThread.sourceRefs
              : [...existingThread.sourceRefs, { type: 'email', id: sourceRefId, label: email.subject }],
            briefingCategory: briefingCat
          })
        } else {
          this.deps.needToKnowService.create({
            title: r.reason || email.subject,
            summary: snippet(email.textBody),
            reason: r.reason || '',
            priority,
            sourceRefs: [{ type: 'email', id: sourceRefId, label: email.subject }],
            threadId: email.threadId,
            briefingCategory: briefingCat,
            sourceProvider: email.provider,
            sourceAccountId: email.accountId,
            sourceLink: email.sourceUrl
          })
        }
        seen.add(sourceRefId)
        surfaced++

        // Auto-draft a reply for reply-needed IMPORTANT mail only (not every
        // actionable email — drafts are for the categories the user named).
        // Skipped during cold-start backfill (cost control — drafts would burn
        // a generate_draft_reply LLM call each; the user can draft on demand).
        if (!opts.skipDrafts && r.classification === 'reply' && important) {
          if (await this.autoDraftReply(email, sourceRefId, seen)) drafted++
        }
      }
    }

    if (surfaced > 0) {
      // The Activity record is also the 必读 page's refetch signal (it
      // subscribes to onActivityChanged — NTK has no dedicated push channel).
      this.deps.activityService.record({
        type: 'tool_completed',
        summary: `必读新增 ${surfaced} 项${drafted ? `、草稿 ${drafted} 份` : ''}`,
        metadata: { surfaced, drafted }
      })
    }
    if (tasksCreated > 0) this.deps.onTasksChanged?.()
    return { surfaced, drafted, tasksCreated }
  }

  /** ADR 0027 — one-time cold-start backfill for a single account. Fetches
   *  `days` of history (default 60) via the provider's `listBackfill`, then
   *  runs the same briefNewEmails pipeline (bulk + school-spam + untrusted
   *  pre-filter, classify_inbox, ToDo extraction, 必读 surface) in
   *  `batchSize`-sized batches — ONE classify call per batch (cost control).
   *  Drafts are skipped (skipDrafts) so a 60-day scan doesn't burn a
   *  generate_draft_reply call per reply-needed mail. Idempotent: re-running
   *  re-touches already-processed mail as a no-op (sourceRef / sourceId dedup).
   *
   *  Scope: ONLY the 必读 path (classify_inbox). The funnel (投递) path stays
   *  incremental — the user asked for a ToDo cold-start, and recruiting mail
   *  is captured here via the recruiting topic + reply bucket anyway. */
  async backfillAccount(
    provider: EmailProvider,
    opts: { days?: number; batchSize?: number } = {}
  ): Promise<{ scanned: number; surfaced: number; tasksCreated: number; capped: boolean }> {
    const days = opts.days ?? 60
    const batchSize = opts.batchSize ?? 20
    const sinceDate = new Date(Date.now() - days * 86_400_000)
    let emails: NormalizedEmail[] = []
    try {
      const fn = provider.listBackfill?.bind(provider)
      emails = fn ? await fn(sinceDate) : await provider.listMessages({ sinceHours: days * 24, limit: 500 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        type: 'provider_unavailable',
        summary: `冷启动回填失败 ${provider.accountId}：${message}`,
        metadata: { accountId: provider.accountId, error: message }
      })
      return { scanned: 0, surfaced: 0, tasksCreated: 0, capped: false }
    }
    // Cost control: the provider already caps pages; chunk into batchSize so
    // each LLM classify call stays small.
    let surfaced = 0
    let tasksCreated = 0
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize)
      const r = await this.briefNewEmails(batch, { skipDrafts: true })
      surfaced += r.surfaced
      tasksCreated += r.tasksCreated
    }
    this.deps.activityService.record({
      type: 'tool_completed',
      summary: `冷启动回填 ${provider.accountId}：扫描 ${emails.length} 封 / 必读 ${surfaced} / 待办 ${tasksCreated}`,
      metadata: { accountId: provider.accountId, scanned: emails.length, surfaced, tasksCreated }
    })
    if (tasksCreated > 0) this.deps.onTasksChanged?.()
    return { scanned: emails.length, surfaced, tasksCreated, capped: false }
  }

  /** Generate a tone-mirrored reply draft and save it to the Drafts folder
   *  (R1, no approval — §15 exception, ADR 0022). Best-effort: prior-replies
   *  fetch + draft generation failures are logged and never kill the loop. */
  private async autoDraftReply(
    email: NormalizedEmail,
    sourceRefId: string,
    seen: Set<string>
  ): Promise<boolean> {
    const provider =
      this.deps.emailProviders.find((p) => p.accountId === email.accountId) ??
      this.deps.emailProviders[0]
    let priorReplies: NormalizedEmail[] = []
    if (provider) {
      try {
        priorReplies = await provider.listSent({
          toAddress: email.from.address,
          sinceHours: 720,
          limit: 5
        })
      } catch {
        // Degrade to a generic (non-tone-mirrored) draft — don't block.
      }
    }
    let memory: MemoryItem[] = []
    try {
      memory = this.deps.memoryService.list()
    } catch {
      // no profile → generic draft
    }

    let draft: DraftReplyOutput
    try {
      draft = (await this.deps.agentRuntime.runAgentStep('generate_draft_reply', {
        email,
        priorReplies,
        memory
      })) as DraftReplyOutput
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        type: 'agent_failed',
        summary: `草稿生成失败（${email.subject}）：${message}`,
        metadata: { error: message, messageId: email.messageId }
      })
      return false
    }

    let result
    try {
      result = await this.deps.toolRegistry.execute(
        'email.create_draft',
        {
          accountId: email.accountId,
          threadId: email.threadId,
          to: draft.to,
          subject: draft.subject,
          body: draft.body
        },
        this.deps.toolContext
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        type: 'tool_failed',
        summary: `草稿保存失败（${email.subject}）：${message}`,
        metadata: { error: message, messageId: email.messageId }
      })
      return false
    }
    if (result.status !== 'ok') {
      const message = result.status === 'error' ? result.error : result.status
      this.deps.activityService.record({
        type: 'tool_failed',
        summary: `草稿保存失败（${email.subject}）：${message}`,
        metadata: { messageId: email.messageId }
      })
      return false
    }

    // Surface a 必读 item so the user knows a draft is waiting in their
    // Drafts folder — they review + send manually from the mail client.
    const draftNtkId = `${sourceRefId}:draft`
    if (!seen.has(draftNtkId)) {
      this.deps.needToKnowService.create({
        title: `已草拟回复：${email.subject}`,
        summary: snippet(draft.body, 160),
        reason: '系统已为你生成回复草稿并存入草稿箱 —— 请到邮件客户端审阅后发送。',
        priority: 'high',
        sourceRefs: [{ type: 'email', id: draftNtkId, label: email.subject }]
      })
      seen.add(draftNtkId)
    }
    return true
  }
}
