import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, InputHTMLAttributes } from 'react'
import type {
  ApplicationView,
  ApplicationEvent,
  ApplicationCreateInput,
  ApplicationSource,
  ApplicationEventType,
  EmailMatchProposal,
  SmartFunnelGroup,
  ApplicationFunnelStats,
  FunnelReviewOutput
} from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import {
  APPLICATION_SOURCE_LABEL,
  APPLICATION_EVENT_LABEL,
  APPLICATION_PRIORITY_LABEL,
  SMART_FUNNEL_GROUP_LABEL,
  statusLabel
} from '../labels'
import { ApplicationDetail } from './ApplicationDetail'

// 投递漏斗 (Spec §3, §5). Email-driven: 163 mail is auto-aggregated into the
// funnel (回执→建 item，面试/测评/笔试→追加事件); manual 官网/内推/线下 entries
// coexist. BOSS 直聘 is retired (ADR 0019 — anti-bot wall; UI hidden, backend
// dormant), so it no longer appears here. Smart-sort grouping mirrors the
// backend smartSortedViews (urgent → active → stale → offered → ended).
// A collapsible 回收站 (soft-deleted) sits below. Clicking a card opens the
// detail view (rich fields, resume upload, 逐字稿 generator, event timeline).
//
// The 邮件待确认 queue (low-confidence email→app inference) is unmounted from
// this page — its home is TBD (discussed separately). The component is kept
// `export`ed below (dormant) so re-mounting is a one-line change.

const EVENT_TYPES: ApplicationEventType[] = [
  'assessment',
  'written_test',
  'interview',
  'offer',
  'rejected',
  'withdrawn'
]

const STALE_DAYS = 14
const URGENT_WINDOW_MS = 3 * 86_400_000

// Smart-funnel group order (mirrors backend SmartFunnelGroup order).
const GROUP_ORDER: SmartFunnelGroup[] = ['urgent', 'active', 'stale', 'offered', 'ended']

export function ApplicationsPage(): ReactElement {
  const { data: apps, loading, error, setData, refetch } = useAsync(
    () => window.daymate.listApplications()
  )
  const [syncing, setSyncing] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [showEmailQueue, setShowEmailQueue] = useState(true)
  const [showRecycle, setShowRecycle] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  // Live updates: main pushes the latest funnel views after a create/sync.
  useEffect(() => {
    return window.daymate.onApplicationChanged((views) => {
      setData(views)
      // If the selected app was removed from the active list (soft-deleted),
      // drop the selection so the user returns to the list.
      if (selectedId && !views.some((v) => v.application.id === selectedId)) {
        setSelectedId(undefined)
      }
    })
  }, [setData, selectedId])

  if (loading) return <Loading label="正在加载投递…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  // Detail view replaces the list when a card is selected.
  if (selectedId) {
    return (
      <ApplicationDetail
        applicationId={selectedId}
        onBack={() => setSelectedId(undefined)}
        onChanged={refetch}
      />
    )
  }

  const list = apps ?? []

  return (
    <div>
      <Header
        onAdd={() => setShowAdd((v) => !v)}
        syncing={syncing}
        onSyncEmail={async () => {
          setSyncing(true)
          try {
            await window.daymate.syncEmailApplications()
            refetch()
          } catch (e) {
            console.error(e)
          } finally {
            setSyncing(false)
          }
        }}
        totalCount={list.length}
        activeCount={list.filter((v) => !v.isTerminal).length}
      />

      <ReviewSection
        open={showReview}
        onToggle={() => setShowReview((v) => !v)}
        onChanged={refetch}
      />

      <EmailQueueSection
        open={showEmailQueue}
        onToggle={() => setShowEmailQueue((v) => !v)}
        emailSyncing={syncing}
        existingApps={list}
        onSyncEmail={async () => {
          setSyncing(true)
          try {
            await window.daymate.syncEmailApplications()
            refetch()
          } catch (e) {
            console.error(e)
          } finally {
            setSyncing(false)
          }
        }}
        onChanged={refetch}
      />

      {showAdd && (
        <AddApplicationForm
          onSubmit={async (input) => {
            await window.daymate.createApplication(input)
            setShowAdd(false)
            refetch()
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {list.length === 0 ? (
        <EmptyState
          title="暂无投递记录"
          hint="点击「同步邮箱」从 Gmail 与 163 邮箱拉取招聘邮件自动汇总，或「新增投递」手动添加。"
        />
      ) : (
        <FunnelList
          list={list}
          onSelect={(id) => setSelectedId(id)}
          onChanged={refetch}
        />
      )}

      <RecycleBinSection
        open={showRecycle}
        onToggle={() => setShowRecycle((v) => !v)}
        onChanged={refetch}
      />
    </div>
  )
}

// ── Milestone B: 复盘看板 (KPI tiles + funnel conversion bars + source
// donut + AI 复盘 panel). Collapsible, lives inside the 投递 page (no new nav).
// §13.4: stats are DESCRIPTIVE only — no productivity/slacking score. The AI
// 复盘 is an on-demand snapshot (not persisted); suggestedActions are plain
// text labels with no one-click follow-up (this milestone has no external write).

// `communicated` is a retired BOSS-only stage (HR replied on BOSS); the
// email-driven funnel never produces it, so it is not a funnel-conversion
// stage. The wire value stays in APPLICATION_EVENT_LABEL (dormant).
const FUNNEL_STAGES = [
  'applied',
  'assessment',
  'written_test',
  'interview',
  'offer'
] as const

const SOURCE_COLORS: Record<ApplicationSource, string> = {
  boss: '#60a5fa',
  web: '#34d399',
  referral: '#a78bfa',
  email: '#fbbf24',
  manual: '#f87171',
  other: '#94a3b8'
}

const SOURCES_ORDER: ApplicationSource[] = ['email', 'web', 'referral', 'manual', 'other']

function ReviewSection({
  open,
  onToggle,
  onChanged
}: {
  open: boolean
  onToggle: () => void
  onChanged: () => void
}): ReactElement {
  const { data: stats, loading, error, refetch } = useAsync<ApplicationFunnelStats | null>(
    () => window.daymate.getApplicationStats()
  )

  // Live: when applications change (create/sync/event), stats are stale → refetch.
  useEffect(() => {
    return window.daymate.onApplicationChanged(() => refetch())
  }, [refetch])

  const [review, setReview] = useState<FunnelReviewOutput | null>(null)
  const [generating, setGenerating] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    setGenerating(true)
    setReviewError(null)
    try {
      const out = await window.daymate.generateFunnelReview()
      setReview(out)
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  // Stats changed → drop any stale recap.
  useEffect(() => {
    setReview(null)
  }, [stats])

  const s = stats ?? null
  // Inform the parent that data may have been touched (keeps the funnel list
  // in sync if a generation side-effect ever mutates apps; today it does not,
  // but the hook costs nothing).
  void onChanged

  return (
    <div className="mt-4 rounded-lg border border-white/5" style={{ background: 'var(--dm-panel)' }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-semibold text-white/80">
          复盘看板
          {s && (
            <span className="ml-1.5 text-white/40">· {s.total} 投递 / {s.active} 进行中</span>
          )}
        </span>
        <span className="text-xs text-white/40">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="border-t border-white/5 px-4 py-3 space-y-5">
          {loading ? (
            <Loading label="正在加载统计…" />
          ) : error ? (
            <ErrorState message={error.message} onRetry={refetch} />
          ) : !s || s.total === 0 ? (
            <p className="text-sm text-white/40">暂无投递数据，无法生成复盘。</p>
          ) : (
            <>
              {/* KPI tiles */}
              <div className="grid grid-cols-4 gap-2">
                <KpiTile label="投递总数" value={s.total} color="#e5e7eb" />
                <KpiTile label="面试中" value={s.byStatus.interview ?? 0} color="#fcd34d" />
                <KpiTile label="已录用" value={s.terminal.offer} color="#86efac" />
                <KpiTile label="停滞" value={s.stale} color="#fca5a5" />
              </div>

              {/* Funnel conversion bars */}
              <div>
                <div className="mb-2 text-xs font-semibold text-white/60">漏斗转化</div>
                <div className="space-y-1.5">
                  {FUNNEL_STAGES.map((stage) => {
                    const reached = s.reachedStage[stage] ?? 0
                    const applied = s.reachedStage.applied ?? 0
                    const pct = applied > 0 ? Math.round((reached / applied) * 100) : 0
                    return (
                      <div key={stage} className="flex items-center gap-2 text-xs">
                        <span className="w-16 shrink-0 text-white/50">
                          {APPLICATION_EVENT_LABEL[stage]}
                        </span>
                        <div className="relative h-4 flex-1 overflow-hidden rounded bg-white/5">
                          <div
                            className="h-full rounded"
                            style={{
                              width: `${pct}%`,
                              background: stage === 'offer' ? '#86efac' : '#60a5fa'
                            }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-right text-white/50">
                          {reached} · {pct}%
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2 text-xs text-white/40">
                  已结束 {s.terminal.rejected + s.terminal.withdrawn}（拒 {s.terminal.rejected} / 放弃 {s.terminal.withdrawn}）
                  {s.avgDaysSinceLastEvent != null && (
                    <span className="ml-2">· 进行中平均 {Math.round(s.avgDaysSinceLastEvent)} 天未更新</span>
                  )}
                </div>
              </div>

              {/* Source distribution donut */}
              <SourceDonut stats={s} />
            </>
          )}

          {/* AI 复盘 panel */}
          <div className="border-t border-white/5 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white/60">AI 复盘</span>
              <button
                onClick={() => void generate()}
                disabled={generating || !s || s.total === 0}
                className="rounded bg-white/5 px-2.5 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-40"
              >
                {generating ? '生成中…' : review ? '重新生成' : '生成复盘'}
              </button>
            </div>
            {reviewError && (
              <p className="text-xs text-red-300/80">{reviewError}</p>
            )}
            {review ? (
              <div className="space-y-2 text-sm">
                <div>
                  <div className="font-semibold text-white/85">{review.title}</div>
                  <div className="text-white/60">{review.summary}</div>
                  <div className="mt-0.5 text-xs text-white/40">{review.reason}</div>
                </div>
                {review.highlights.length > 0 && (
                  <div>
                    <div className="text-xs text-white/50">亮点</div>
                    <ul className="ml-4 list-disc text-white/70">
                      {review.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {review.riskApps.length > 0 && (
                  <div>
                    <div className="text-xs text-white/50">风险投递</div>
                    <ul className="ml-4 list-disc text-white/70">
                      {review.riskApps.map((r, i) => (
                        <li key={i}>
                          <span className="text-white/85">{r.company}</span>
                          {r.position && <span className="text-white/50"> · {r.position}</span>}
                          <span className="text-white/60"> — {r.issue}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {review.suggestedActions.length > 0 && (
                  <div>
                    <div className="text-xs text-white/50">建议</div>
                    <ul className="ml-4 list-disc text-white/70">
                      {review.suggestedActions.map((a, i) => (
                        <li key={i}>{a.label}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              !reviewError && (
                <p className="text-xs text-white/40">
                  点击「生成复盘」基于当前投递数据生成描述性复盘建议（不打效率分）。
                </p>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function KpiTile({ label, value, color }: { label: string; value: number; color: string }): ReactElement {
  return (
    <div className="rounded-lg bg-white/5 p-3 text-center">
      <div className="text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-white/50">{label}</div>
    </div>
  )
}

function SourceDonut({ stats }: { stats: ApplicationFunnelStats }): ReactElement {
  const segments = SOURCES_ORDER.map((src) => ({
    src,
    count: stats.bySource[src] ?? 0,
    color: SOURCE_COLORS[src]
  })).filter((s) => s.count > 0)

  const total = segments.reduce((sum, s) => sum + s.count, 0)
  if (total === 0) return <div className="text-xs text-white/40">无来源数据</div>

  const radius = 36
  const circ = 2 * Math.PI * radius
  let acc = 0
  const arcs = segments.map((seg, i) => {
    const len = (seg.count / total) * circ
    const dash = String(len) + ' ' + String(circ - len)
    const off = -acc
    acc += len
    return { i, color: seg.color, dash, off }
  })

  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-white/60">来源分布</div>
      <div className="flex items-center gap-4">
        <svg width={96} height={96} viewBox="0 0 96 96" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="48" cy="48" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={10} />
          {arcs.map((a) => (
            <circle
              key={a.i}
              cx="48"
              cy="48"
              r={radius}
              fill="none"
              stroke={a.color}
              strokeWidth={10}
              strokeDasharray={a.dash}
              strokeDashoffset={a.off}
            />
          ))}
        </svg>
        <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {segments.map((seg) => (
            <div key={seg.src} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: seg.color }} />
              <span className="text-white/60">{APPLICATION_SOURCE_LABEL[seg.src]}</span>
              <span className="ml-auto text-white/50">{seg.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Smart-funnel grouping (mirrors backend smartSortedViews) ──────────────

function nextInterviewTime(view: ApplicationView): string | undefined {
  return view.events.find((e) => e.type === 'interview')?.eventAt
}

function isUrgent(view: ApplicationView, now: number): boolean {
  const deadline = view.application.stageDeadline ?? nextInterviewTime(view)
  if (!deadline) return false
  const ms = new Date(deadline).getTime() - now
  return ms <= URGENT_WINDOW_MS // ≤3d away (or already past)
}

function classifyGroup(view: ApplicationView, now: number): SmartFunnelGroup {
  if (view.currentStatus === 'offer') return 'offered'
  if (view.isTerminal) return 'ended'
  if (view.application.priority === 'back' || (view.daysSinceLastEvent ?? 0) >= STALE_DAYS) {
    return 'stale'
  }
  if (isUrgent(view, now)) return 'urgent'
  return 'active'
}

function FunnelList({
  list,
  onSelect,
  onChanged
}: {
  list: ApplicationView[]
  onSelect: (id: string) => void
  onChanged: () => void
}): ReactElement {
  const now = Date.now()
  const buckets = useMemo(() => {
    const map: Record<SmartFunnelGroup, ApplicationView[]> = {
      urgent: [],
      active: [],
      stale: [],
      offered: [],
      ended: [],
      archived: []
    }
    for (const v of list) {
      map[classifyGroup(v, now)].push(v)
    }
    // Sort within: urgent by soonest deadline first; others by most-recent
    // lastEventAt first (mirrors backend sortWithin comment + intent).
    map.urgent.sort((a, b) => {
      const da = a.application.stageDeadline ?? nextInterviewTime(a) ?? ''
      const db = b.application.stageDeadline ?? nextInterviewTime(b) ?? ''
      return da < db ? -1 : da > db ? 1 : 0
    })
    for (const g of ['active', 'stale', 'offered', 'ended'] as SmartFunnelGroup[]) {
      map[g].sort((a, b) => {
        const da = a.lastEventAt ?? ''
        const db = b.lastEventAt ?? ''
        return da < db ? 1 : da > db ? -1 : 0
      })
    }
    return map
  }, [list, now])

  return (
    <div className="mt-6 space-y-6">
      {GROUP_ORDER.map((group) => {
        const views = buckets[group]
        if (views.length === 0) return null
        return (
          <section key={group}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
              {SMART_FUNNEL_GROUP_LABEL[group]} · {views.length}
            </h2>
            <div className="space-y-2">
              {views.map((v) => (
                <ApplicationCard
                  key={v.application.id}
                  view={v}
                  onSelect={() => onSelect(v.application.id)}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// ── Email pending-queue section (DORMANT — unmounted from the 投递 page; its
// home is TBD. Kept `export`ed so re-mounting is a one-line change once a new
// surface is decided.) ─────────────────────────────────────────────────────

export function EmailQueueSection({
  existingApps = [],
  onChanged
}: {
  open?: boolean
  onToggle?: () => void
  emailSyncing?: boolean
  existingApps?: ApplicationView[]
  onSyncEmail?: () => Promise<void>
  onChanged?: () => void
}): ReactElement | null {
  const { data, setData, refetch } = useAsync<EmailMatchProposal[]>(
    () => window.daymate.listPendingEmailMatches()
  )

  // Live push: main updates the pending queue after a sync or a match.
  useEffect(() => {
    return window.daymate.onEmailMatchesChanged((matches) => setData(matches))
  }, [setData])

  const proposals = data ?? []

  const confirm = async (
    messageId: string,
    chosenApplicationId?: string,
    options?: { company?: string; position?: string; eventType?: ApplicationEventType }
  ): Promise<void> => {
    try {
      await window.daymate.confirmEmailMatch(messageId, chosenApplicationId, options)
      refetch()
      onChanged?.()
    } catch (e) {
      console.error(e)
    }
  }

  const ignore = async (messageId: string): Promise<void> => {
    try {
      await window.daymate.ignoreEmailMatch(messageId)
      refetch()
      onChanged?.()
    } catch (e) {
      console.error(e)
    }
  }

  const ignoreAll = async (): Promise<void> => {
    try {
      for (const p of proposals) {
        await window.daymate.ignoreEmailMatch(p.messageId)
      }
      refetch()
      onChanged?.()
    } catch (e) {
      console.error(e)
    }
  }

  if (proposals.length === 0) return null

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 shadow-lg shadow-black/20">
      <div className="flex items-center justify-between pb-3 border-b border-amber-500/20">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/20 text-amber-300 text-xs">
            ⚠️
          </span>
          <div>
            <span className="text-sm font-semibold text-white/95">
              待人工归并
            </span>
            <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
              {proposals.length} 封邮件存在多岗位歧义
            </span>
          </div>
        </div>
        <button
          onClick={() => void ignoreAll()}
          className="rounded-lg bg-white/5 hover:bg-rose-500/20 border border-white/10 px-2.5 py-1 text-xs text-white/60 hover:text-rose-300 transition-colors"
        >
          全部忽略
        </button>
      </div>
      <div className="mt-3 space-y-3">
        {proposals.map((p) => (
          <EmailMatchCard
            key={p.id}
            proposal={p}
            existingApps={existingApps}
            onConfirm={(chosenId, options) => confirm(p.messageId, chosenId, options)}
            onIgnore={() => ignore(p.messageId)}
          />
        ))}
      </div>
    </div>
  )
}

function EmailMatchCard({
  proposal,
  existingApps = [],
  onConfirm,
  onIgnore
}: {
  proposal: EmailMatchProposal
  existingApps?: ApplicationView[]
  onConfirm: (
    chosenApplicationId?: string,
    options?: { company?: string; position?: string; jobCode?: string; eventType?: ApplicationEventType }
  ) => void
  onIgnore: () => void
}): ReactElement {
  const hasCandidates = proposal.candidateApplications && proposal.candidateApplications.length > 0

  // Matching options state: user can choose whether to merge into existing or create new
  const [mode, setMode] = useState<'existing' | 'new'>(
    existingApps.length > 0 ? 'existing' : 'new'
  )
  const [selectedAppId, setSelectedAppId] = useState<string>(() => {
    // 1. Match by jobCode first (100% deterministic ATS requisition match)
    if (proposal.jobCode) {
      const codeMatch = existingApps.find(
        (a) => a.application.jobCode && a.application.jobCode.toLowerCase() === proposal.jobCode!.toLowerCase()
      )
      if (codeMatch) return codeMatch.application.id
    }
    if (proposal.applicationId && existingApps.some((a) => a.application.id === proposal.applicationId)) {
      return proposal.applicationId
    }
    if (hasCandidates && proposal.candidateApplications![0]) {
      return proposal.candidateApplications![0].id
    }
    // Match by company name
    const match = existingApps.find(
      (a) =>
        proposal.company &&
        a.application.company.toLowerCase().includes(proposal.company.toLowerCase())
    )
    if (match) return match.application.id
    return existingApps[0]?.application.id ?? ''
  })

  const [companyInput, setCompanyInput] = useState(
    proposal.company ?? proposal.applicationCompany ?? ''
  )
  const [positionInput, setPositionInput] = useState(
    proposal.position ?? proposal.applicationPosition ?? ''
  )
  const [jobCodeInput, setJobCodeInput] = useState(
    proposal.jobCode ?? ''
  )
  const [eventTypeInput, setEventTypeInput] = useState<ApplicationEventType>(proposal.eventType)

  const handleConfirmExisting = (): void => {
    if (!selectedAppId) return
    onConfirm(selectedAppId, {
      position: positionInput.trim() || undefined,
      jobCode: (proposal.jobCode || jobCodeInput).trim() || undefined,
      eventType: eventTypeInput
    })
  }

  const handleConfirmNew = (): void => {
    onConfirm(undefined, {
      company: companyInput.trim() || '未知公司',
      position: positionInput.trim() || '未知岗位',
      jobCode: jobCodeInput.trim() || proposal.jobCode || undefined,
      eventType: eventTypeInput
    })
  }

  return (
    <div className="rounded border border-white/10 bg-white/5 p-3.5 space-y-3">
      {/* 头部信息 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white/95">{proposal.subject}</span>
            {proposal.jobCode && (
              <span className="rounded border border-indigo-400/40 bg-indigo-500/20 px-2 py-0.5 text-xs font-mono font-medium text-indigo-200">
                🔖 岗位编号: {proposal.jobCode}
              </span>
            )}
            {proposal.isReschedule && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-300">
                改期通知
              </span>
            )}
            {proposal.isCancelled && (
              <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-xs font-medium text-rose-300">
                已取消
              </span>
            )}
          </div>

          {proposal.from && (
            <div className="text-xs text-white/40">发件人：{proposal.from}</div>
          )}

          {(proposal.company || proposal.position || proposal.applicationCompany) && (
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-200">
                推断阶段：{statusLabel(APPLICATION_EVENT_LABEL, proposal.eventType)}
              </span>
              <span className="font-medium text-white/80">
                {proposal.company ?? proposal.applicationCompany}
                {proposal.position ? ` / ${proposal.position}` : proposal.applicationPosition ? ` / ${proposal.applicationPosition}` : ''}
              </span>
            </div>
          )}

          {proposal.meetingInfo && (
            <div className="mt-1 rounded bg-black/25 p-2 text-xs text-sky-200/90">
              📅 会议/面试信息：{proposal.meetingInfo}
            </div>
          )}

          {proposal.evidence && (
            <div className="text-xs text-white/40">依据：{proposal.evidence}</div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            onClick={onIgnore}
            className="rounded-lg bg-white/[0.06] hover:bg-white/[0.12] px-3 py-1.5 text-xs text-white/50 hover:text-white/80 transition-colors"
          >
            忽略此邮件
          </button>
        </div>
      </div>

      {/* 同公司多岗位防串岗快捷选项 */}
      {hasCandidates && (
        <div className="rounded border border-amber-500/25 bg-amber-500/10 p-2 text-xs space-y-1.5">
          <div className="font-semibold text-amber-200">
            ⚠️ 快捷选项：同公司存在多个岗位，可直接点击一键归并：
          </div>
          <div className="flex flex-wrap gap-2">
            {proposal.candidateApplications!.map((cand) => (
              <button
                key={cand.id}
                onClick={() => onConfirm(cand.id, { eventType: proposal.eventType, jobCode: cand.jobCode || proposal.jobCode })}
                className="rounded border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                归并至：{cand.company} · {cand.position} {cand.jobCode ? `[#${cand.jobCode}]` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 归并目标选择区 */}
      <div className="rounded border border-white/5 bg-black/20 p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-white/75">
            请选择归并目标与方式：
          </div>
          <div className="flex rounded border border-white/10 p-0.5 text-xs">
            {existingApps.length > 0 && (
              <button
                onClick={() => setMode('existing')}
                className={`rounded px-2.5 py-0.5 transition-colors ${
                  mode === 'existing'
                    ? 'bg-white/15 text-white font-medium'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                归并到已有投递
              </button>
            )}
            <button
              onClick={() => setMode('new')}
              className={`rounded px-2.5 py-0.5 transition-colors ${
                mode === 'new'
                  ? 'bg-white/15 text-white font-medium'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              作为新投递创建
            </button>
          </div>
        </div>

        {mode === 'existing' && existingApps.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={selectedAppId}
              onChange={(e) => setSelectedAppId(e.target.value)}
              className="flex-1 min-w-[200px] rounded border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-white outline-none focus:border-white/30"
            >
              <option value="" disabled>
                -- 请选择归并到的投递目标 --
              </option>
              {existingApps.map((a) => (
                <option key={a.application.id} value={a.application.id} className="bg-zinc-900">
                  {a.application.company} · {a.application.position} {a.application.jobCode ? `[#${a.application.jobCode}]` : ''}
                </option>
              ))}
            </select>

            <select
              value={eventTypeInput}
              onChange={(e) => setEventTypeInput(e.target.value as ApplicationEventType)}
              className="rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-white outline-none focus:border-white/30"
            >
              {(['applied', 'communicated', 'assessment', 'written_test', 'interview', 'offer', 'rejected'] as ApplicationEventType[]).map(
                (et) => (
                  <option key={et} value={et} className="bg-zinc-900">
                    阶段：{statusLabel(APPLICATION_EVENT_LABEL, et)}
                  </option>
                )
              )}
            </select>

            <button
              onClick={handleConfirmExisting}
              disabled={!selectedAppId}
              className="rounded bg-sky-600/80 hover:bg-sky-500 px-3 py-1.5 font-medium text-white transition-colors disabled:opacity-40"
            >
              确认归并至该投递
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              placeholder="公司名称"
              value={companyInput}
              onChange={(e) => setCompanyInput(e.target.value)}
              className="w-28 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-white outline-none focus:border-white/30 placeholder:text-white/30"
            />
            <input
              placeholder="岗位名称（如：产品经理）"
              value={positionInput}
              onChange={(e) => setPositionInput(e.target.value)}
              className="flex-1 min-w-[130px] rounded border border-white/10 bg-black/30 px-2 py-1.5 text-white outline-none focus:border-white/30 placeholder:text-white/30"
            />
            <input
              placeholder="岗位编号 (选填)"
              value={jobCodeInput}
              onChange={(e) => setJobCodeInput(e.target.value)}
              className="w-28 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-white outline-none focus:border-white/30 placeholder:text-white/30 font-mono"
            />
            <select
              value={eventTypeInput}
              onChange={(e) => setEventTypeInput(e.target.value as ApplicationEventType)}
              className="rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-white outline-none focus:border-white/30"
            >
              {(['applied', 'communicated', 'assessment', 'written_test', 'interview', 'offer', 'rejected'] as ApplicationEventType[]).map(
                (et) => (
                  <option key={et} value={et} className="bg-zinc-900">
                    阶段：{statusLabel(APPLICATION_EVENT_LABEL, et)}
                  </option>
                )
              )}
            </select>

            <button
              onClick={handleConfirmNew}
              className="rounded px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--dm-accent)' }}
            >
              + 建立新投递并归并
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Recycle-bin section ───────────────────────────────────────────────────

function RecycleBinSection({
  open,
  onToggle,
  onChanged
}: {
  open: boolean
  onToggle: () => void
  onChanged: () => void
}): ReactElement {
  const { data, loading, error, refetch } = useAsync<ApplicationView[]>(
    () => window.daymate.listDeletedApplications()
  )

  const restore = async (id: string): Promise<void> => {
    try {
      await window.daymate.restoreApplication(id)
      refetch()
      onChanged()
    } catch (e) {
      console.error(e)
    }
  }

  const purge = async (id: string): Promise<void> => {
    if (!window.confirm('永久删除后无法恢复，确认？')) return
    try {
      await window.daymate.purgeApplication(id)
      refetch()
      onChanged()
    } catch (e) {
      console.error(e)
    }
  }

  const deleted = data ?? []

  return (
    <div className="mt-6 rounded-lg border border-white/5" style={{ background: 'var(--dm-panel)' }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-semibold text-white/80">
          回收站{deleted.length > 0 && (
            <span className="ml-1.5 text-white/40">· {deleted.length}</span>
          )}
        </span>
        <span className="text-xs text-white/40">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="border-t border-white/5 px-4 py-3">
          {loading ? (
            <Loading label="正在加载回收站…" />
          ) : error ? (
            <ErrorState message={error.message} onRetry={refetch} />
          ) : deleted.length === 0 ? (
            <p className="text-sm text-white/40">回收站为空。</p>
          ) : (
            <div className="space-y-2">
              {deleted.map((v) => (
                <div
                  key={v.application.id}
                  className="flex items-center justify-between rounded bg-white/5 p-2.5"
                >
                  <div className="flex-1">
                    <span className="text-sm text-white/85">{v.application.company}</span>
                    <span className="ml-1.5 text-xs text-white/45">{v.application.position}</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => restore(v.application.id)}
                      className="rounded bg-white/10 px-2 py-1 text-xs text-white/90 hover:bg-white/20"
                    >
                      恢复
                    </button>
                    <button
                      onClick={() => purge(v.application.id)}
                      className="rounded bg-white/5 px-2 py-1 text-xs text-rose-300/70 hover:bg-white/10"
                    >
                      永久删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add-application form (rich fields) ────────────────────────────────────

function AddApplicationForm({
  onSubmit,
  onCancel
}: {
  onSubmit: (input: ApplicationCreateInput) => Promise<void>
  onCancel: () => void
}): ReactElement {
  const [form, setForm] = useState({
    company: '',
    position: '',
    source: 'manual' as ApplicationSource,
    appliedAt: '',
    channelRef: '',
    notes: '',
    city: '',
    salaryRange: '',
    jdText: '',
    stage: '',
    stageDeadline: '',
    interviewLink: ''
  })
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!form.company.trim() || !form.position.trim()) return
    setBusy(true)
    try {
      await onSubmit({
        company: form.company.trim(),
        position: form.position.trim(),
        source: form.source,
        appliedAt: form.appliedAt ? new Date(form.appliedAt).toISOString() : undefined,
        channelRef: form.channelRef.trim() || undefined,
        notes: form.notes.trim() || undefined,
        city: form.city.trim() || undefined,
        salaryRange: form.salaryRange.trim() || undefined,
        jdText: form.jdText.trim() || undefined,
        stage: form.stage.trim() || undefined,
        stageDeadline: form.stageDeadline ? new Date(form.stageDeadline).toISOString() : undefined,
        interviewLink: form.interviewLink.trim() || undefined
      })
    } catch (e) {
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof typeof form, placeholder: string, extra?: InputHTMLAttributes<HTMLInputElement>): ReactElement => (
    <input
      value={form[key] as string}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      placeholder={placeholder}
      className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
      {...extra}
    />
  )

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="text-sm font-semibold text-white/80">新增投递</div>
      <div className="grid grid-cols-2 gap-2">
        {field('company', '公司')}
        {field('position', '职位')}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <select
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value as ApplicationSource })}
          className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
        >
          {(['manual', 'web', 'referral', 'other'] as ApplicationSource[]).map((s) => (
            <option key={s} value={s} className="bg-zinc-800">
              {statusLabel(APPLICATION_SOURCE_LABEL, s)}
            </option>
          ))}
        </select>
        {field('appliedAt', '', { type: 'date' })}
        {field('channelRef', '内推人/链接')}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {field('city', '城市')}
        {field('salaryRange', '薪资范围')}
        {field('stage', '阶段')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {field('stageDeadline', '阶段截止', { type: 'date' })}
        {field('interviewLink', '面试链接')}
      </div>
      <textarea
        value={form.jdText}
        onChange={(e) => setForm({ ...form, jdText: e.target.value })}
        placeholder="JD 原文（可选）"
        rows={3}
        className="w-full rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
      />
      <input
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        placeholder="备注（可选）"
        className="w-full rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={busy || !form.company.trim() || !form.position.trim()}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button
          onClick={onCancel}
          className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/60 hover:bg-white/10"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ── Application pipeline stepper (流水线) ──────────────────────────────────

function ApplicationPipelineFlow({
  events,
  trailingAction
}: {
  events: ApplicationEvent[]
  trailingAction?: React.ReactNode
}): ReactElement {
  // Deduplicate consecutive identical events and map to sequential pipeline stages
  const steps: {
    key: string
    label: string
    date?: string
    isCurrent: boolean
    isTerminal?: boolean
    type: ApplicationEventType
    evidence?: string
  }[] = []

  const rawEvents: (Partial<ApplicationEvent> & { type: ApplicationEventType })[] =
    events.length > 0
      ? events
      : [{ id: 'init', type: 'applied', eventAt: '', locked: false }]

  // Campus hiring pipeline only displays genuine hiring milestones (applied -> assessment -> written_test -> interview -> offer/rejected).
  // Verification codes, non-job notices, and legacy 'communicated' events are filtered out.
  const sourceEvents = rawEvents.filter(
    (e) => e.type !== 'communicated' && !/非求职|非招聘|验证码|verification/i.test(e.evidence || '')
  )
  const effectiveEvents = sourceEvents.length > 0
    ? sourceEvents
    : [{ id: 'init', type: 'applied' as ApplicationEventType, eventAt: '', locked: false }]

  for (let i = 0; i < effectiveEvents.length; i++) {
    const ev = effectiveEvents[i]
    let label = statusLabel(APPLICATION_EVENT_LABEL, ev.type)
    if (ev.type === 'interview' && ev.round) {
      label = `${ev.round}面`
    } else if (ev.type === 'written_test') {
      label = '专业笔试'
    } else if (ev.type === 'assessment') {
      label = '在线测评'
    } else if (ev.type === 'applied') {
      label = '简历投递'
    } else if (ev.type === 'rejected') {
      if (/感谢信/i.test(ev.evidence || '')) {
        label = '感谢信'
      } else if (/未通过|不匹配|遗憾|未录用|未能录用/i.test(ev.evidence || '')) {
        label = '未通过'
      } else {
        label = '感谢信'
      }
    } else if (ev.type === 'withdrawn') {
      label = '已撤回'
    }

    // Deduplicate identical consecutive event types (e.g. multiple 'applied' become 1)
    const prev = steps[steps.length - 1]
    if (prev && prev.type === ev.type && prev.label === label) {
      if (ev.eventAt && !prev.date) {
        prev.date = new Date(ev.eventAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      }
      continue
    }

    const isTerminal = ev.type === 'rejected' || ev.type === 'withdrawn'

    steps.push({
      key: ev.id || `${ev.type}-${i}`,
      label,
      date: ev.eventAt
        ? new Date(ev.eventAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
        : undefined,
      isCurrent: false,
      isTerminal,
      type: ev.type,
      evidence: ev.evidence
    })
  }

  // Ensure last item is marked as current active step
  if (steps.length > 0) {
    steps[steps.length - 1].isCurrent = true
  }

  return (
    <div className="mt-3 flex items-center justify-between flex-wrap gap-2 pt-2.5 border-t border-white/[0.04]">
      <div className="flex items-center flex-wrap gap-1.5">
        <span className="text-[11px] font-medium text-white/35 select-none shrink-0 flex items-center gap-1">
          <span>流水线</span>
          <span>:</span>
        </span>
        <div className="flex items-center flex-wrap gap-1.5">
          {steps.map((step, idx) => (
            <div key={step.key} className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                  step.type === 'rejected'
                    ? 'bg-rose-500/20 border border-rose-500/40 text-rose-300 shadow-sm shadow-rose-500/10'
                    : step.type === 'withdrawn'
                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                    : step.type === 'offer'
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 shadow-sm shadow-emerald-500/10'
                    : step.isCurrent
                    ? 'bg-sky-500/15 border border-sky-400/30 text-sky-200 shadow-sm shadow-sky-500/10'
                    : 'bg-white/[0.04] border border-white/[0.08] text-white/70 hover:bg-white/[0.08]'
                }`}
                title={step.evidence}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    step.type === 'rejected'
                      ? 'bg-rose-400 ring-2 ring-rose-500/30'
                      : step.type === 'withdrawn'
                      ? 'bg-amber-400'
                      : step.type === 'offer'
                      ? 'bg-emerald-400 animate-pulse'
                      : step.isCurrent
                      ? 'bg-sky-400'
                      : 'bg-white/30'
                  }`}
                />
                <span>{step.label}</span>
                {step.date && (
                  <span className="text-[10px] text-white/35 font-mono">({step.date})</span>
                )}
              </span>

              {/* Stepper Arrow to next node */}
              {idx < steps.length - 1 && (
                <span className="text-white/25 text-xs font-semibold select-none px-0.5">
                  →
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {trailingAction && (
        <div className="shrink-0 ml-auto flex items-center">
          {trailingAction}
        </div>
      )}
    </div>
  )
}

// ── Application card (funnel row) ─────────────────────────────────────────

function ApplicationCard({
  view,
  onSelect,
  onChanged
}: {
  view: ApplicationView
  onSelect: () => void
  onChanged: () => void
}): ReactElement {
  const [showEvent, setShowEvent] = useState(false)
  const [ev, setEv] = useState({
    type: 'interview' as ApplicationEventType,
    round: '',
    eventAt: '',
    evidence: ''
  })

  const submitEvent = async (): Promise<void> => {
    try {
      await window.daymate.addApplicationEvent({
        applicationId: view.application.id,
        type: ev.type,
        round: ev.round ? Number(ev.round) : undefined,
        eventAt: ev.eventAt ? new Date(ev.eventAt).toISOString() : undefined,
        evidence: ev.evidence.trim() || undefined,
        locked: true
      })
      setEv({ type: 'interview', round: '', eventAt: '', evidence: '' })
      setShowEvent(false)
      onChanged()
    } catch (e) {
      console.error(e)
    }
  }

  // Consistent company monogram avatar gradient
  const companyName = view.application.company || '企'
  const companyChar = companyName.slice(0, 1)
  const GRADIENTS = [
    'from-sky-500 to-blue-600',
    'from-violet-500 to-indigo-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-rose-500 to-pink-600',
    'from-cyan-500 to-sky-600'
  ]
  const hash = companyName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const grad = GRADIENTS[hash % GRADIENTS.length]

  return (
    <div className="group rounded-xl border border-white/[0.07] bg-[#12151c]/80 hover:bg-[#151922] p-4 transition-all duration-200 hover:border-white/[0.18] hover:shadow-lg hover:shadow-black/30">
      <div className="flex items-start justify-between gap-4">
        {/* Left: Avatar + Details */}
        <div className="flex items-start gap-3.5 flex-1 min-w-0 cursor-pointer" onClick={onSelect}>
          {/* Company Avatar Monogram */}
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${grad} text-sm font-bold text-white shadow-sm ring-1 ring-white/20 select-none`}
          >
            {companyChar}
          </div>

          <div className="min-w-0 flex-1">
            {/* Row 1: Position Title, Job Code, Company, Stage Badge */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-white tracking-tight group-hover:text-sky-300 transition-colors">
                {view.application.position}
              </span>
              {view.application.jobCode && (
                <span className="rounded-md border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-sky-300">
                  #{view.application.jobCode}
                </span>
              )}
              <span className="text-xs text-white/30">·</span>
              <span className="text-xs font-medium text-white/80">{view.application.company}</span>
              {view.application.city && (
                <>
                  <span className="text-xs text-white/30">·</span>
                  <span className="text-xs text-white/55">{view.application.city}</span>
                </>
              )}
              {view.application.salaryRange && (
                <>
                  <span className="text-xs text-white/30">·</span>
                  <span className="text-xs text-emerald-400/90 font-medium">{view.application.salaryRange}</span>
                </>
              )}
              {view.application.priority === 'back' && (
                <span className="rounded bg-white/5 border border-white/10 px-1.5 py-0.5 text-[10px] text-white/40">
                  {statusLabel(APPLICATION_PRIORITY_LABEL, view.application.priority)}
                </span>
              )}
            </div>

            {/* Row 2: JD snippet */}
            {view.application.jdText && (
              <p className="mt-1.5 line-clamp-1 text-xs text-white/45 leading-relaxed">
                {view.application.jdText}
              </p>
            )}

            {/* Row 3: Meta & Timing */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-white/40">
              <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/60 border border-white/[0.06]">
                {statusLabel(APPLICATION_SOURCE_LABEL, view.application.source)}
              </span>
              <span>·</span>
              <span>投递于 {new Date(view.application.appliedAt).toLocaleDateString('zh-CN')}</span>
              {view.application.stage && (
                <>
                  <span>·</span>
                  <span className="rounded bg-sky-500/15 border border-sky-400/20 px-2 py-0.5 text-[11px] text-sky-200 font-medium">
                    {view.application.stage}
                  </span>
                </>
              )}
              {view.currentStatus === 'rejected' && (
                <>
                  <span>·</span>
                  <span className="rounded bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] text-rose-300 font-medium">
                    {view.events.some((e) => /感谢信/i.test(e.evidence || '')) ? '感谢信' : '已淘汰'}
                  </span>
                </>
              )}
              {view.daysSinceLastEvent !== undefined && view.daysSinceLastEvent >= 3 && !view.isTerminal && view.currentStatus !== 'offer' && (
                <>
                  <span>·</span>
                  <span className="rounded bg-amber-500/15 border border-amber-500/25 px-2 py-0.5 text-[11px] text-amber-300 font-medium flex items-center gap-1">
                    <span>⏱</span>
                    <span>{view.daysSinceLastEvent} 天无进展</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <button
            onClick={() => setShowEvent((v) => !v)}
            className="rounded-lg border border-white/10 bg-white/[0.05] hover:bg-white/[0.1] px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white transition-all shadow-sm"
          >
            + 进展
          </button>
          <button
            onClick={onSelect}
            className="rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 px-3 py-1.5 text-xs font-medium text-sky-300 hover:text-sky-200 transition-all shadow-sm"
          >
            详情 →
          </button>
        </div>
      </div>

      {/* Pipeline Flow Stepper */}
      <ApplicationPipelineFlow
        events={view.events}
        trailingAction={
          view.currentStatus !== 'rejected' && (
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (window.confirm(`确定将「${view.application.company} · ${view.application.position}」标记为收到感谢信/已淘汰？`)) {
                  try {
                    await window.daymate.updateApplicationStatus(view.application.id, 'rejected', { evidence: '收到感谢信' })
                    onChanged()
                  } catch (err) {
                    console.error('Failed to update application status:', err)
                    alert(`标记失败: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }
              }}
              className="rounded-lg border border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-300/70 hover:text-rose-200 transition-all select-none shadow-sm"
              title="一键标记为收到感谢信/淘汰"
            >
              标为感谢信
            </button>
          )
        }
      />

      {showEvent && (
        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-white/[0.08] pt-3">
          <select
            value={ev.type}
            onChange={(e) => {
              const newType = e.target.value as ApplicationEventType
              setEv({
                ...ev,
                type: newType,
                evidence: newType === 'rejected' && !ev.evidence ? '收到感谢信' : ev.evidence
              })
            }}
            className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white/90 outline-none"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t} className="bg-zinc-800">
                {statusLabel(APPLICATION_EVENT_LABEL, t)}
              </option>
            ))}
          </select>
          {ev.type === 'interview' && (
            <input
              value={ev.round}
              onChange={(e) => setEv({ ...ev, round: e.target.value })}
              placeholder="第几轮"
              type="number"
              min={1}
              className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white/90 outline-none"
            />
          )}
          <input
            type="date"
            value={ev.eventAt}
            onChange={(e) => setEv({ ...ev, eventAt: e.target.value })}
            className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white/90 outline-none"
          />
          <input
            value={ev.evidence}
            onChange={(e) => setEv({ ...ev, evidence: e.target.value })}
            placeholder={ev.type === 'rejected' ? '备注（如：收到感谢信）' : '备注'}
            className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white/90 outline-none"
          />
          <button
            onClick={submitEvent}
            className="col-span-4 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/30 py-1.5 text-xs font-semibold text-sky-200 transition-colors"
          >
            保存进展
          </button>
        </div>
      )}
    </div>
  )
}

function Header({
  onAdd,
  syncing,
  onSyncEmail,
  totalCount,
  activeCount
}: {
  onAdd: () => void
  syncing: boolean
  onSyncEmail: () => Promise<void>
  totalCount: number
  activeCount: number
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] pb-6 mb-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-white">求职投递</h1>
          <span className="rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-300">
            共 {totalCount} 个投递 · {activeCount} 进行中
          </span>
        </div>
        <p className="mt-1 text-xs text-white/50">
          全自动双邮箱（Gmail & 163）增量解析 · JD 联网与智库补全 · 智能规避歧义与串岗
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => void onSyncEmail()}
          disabled={syncing}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/[0.1] px-4 py-2 text-xs font-medium text-white/90 transition-all disabled:opacity-50 shadow-sm"
        >
          <span className={syncing ? 'animate-spin' : ''}>⟳</span>
          <span>{syncing ? '正在拉取新邮件…' : '同步邮箱'}</span>
        </button>
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 hover:from-sky-400 hover:to-indigo-400 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-sky-500/20 transition-all hover:scale-[1.02]"
        >
          <span>+</span>
          <span>新增投递</span>
        </button>
      </div>
    </div>
  )
}
