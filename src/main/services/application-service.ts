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
import type { ActivityService } from './activity-service'
import type {
  Application,
  ApplicationEvent,
  ApplicationEventInput,
  ApplicationCreateInput,
  ApplicationView,
  ApplicationEventType,
  BossApplication,
  BossInterview,
  BossChat
} from '@shared/types'
import { newId, nowIso } from '../util/ids'

const TERMINAL: ApplicationEventType[] = ['offer', 'rejected', 'withdrawn']
// Non-terminal stages have a natural "how far along" ordering
// (applied < communicated < assessment < written_test < interview < offer),
// used by the P2 follow-up / skip-detection rules. Events are recorded as
// observed — this ordering never enforces a fixed ladder.

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

export class ApplicationService {
  constructor(
    private readonly store: RoutineStore,
    private readonly bossProvider: BossProvider,
    private readonly activityService: ActivityService
  ) {}

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
   * Current status = latest event; terminal (offer/rejected/withdrawn) wins
   * regardless of position (you don't "un-reject"). An application with no
   * events is implicitly `applied`. The lock-precedence-vs-auto rule (a locked
   * event pins status against auto-detected earlier events) is a P2 concern —
   * P1 stores `locked` and surfaces it; with no email-derived auto events yet,
   * latest-wins + terminal-wins is exactly correct.
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
    const terminals = events.filter((e) => TERMINAL.includes(e.type))
    if (terminals.length > 0) {
      const latestTerminal = terminals[terminals.length - 1]
      return {
        currentStatus: latestTerminal.type,
        isTerminal: true,
        lastEventAt: last.eventAt
      }
    }
    return {
      currentStatus: last.type,
      currentRound: last.round,
      isTerminal: false,
      lastEventAt: last.eventAt
    }
  }
}
