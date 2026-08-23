import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, InputHTMLAttributes } from 'react'
import type {
  ApplicationView,
  ApplicationCreateInput,
  ApplicationSource,
  ApplicationEventType,
  EmailMatchProposal,
  SmartFunnelGroup,
  ApplicationFunnelStats,
  FunnelReviewOutput,
  JobIntent,
  JobSearchSettings,
  JobRecommendations,
  JobBucket,
  BossJob
} from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import {
  APPLICATION_SOURCE_LABEL,
  APPLICATION_EVENT_LABEL,
  APPLICATION_PRIORITY_LABEL,
  SMART_FUNNEL_GROUP_LABEL,
  JOB_TIER_LABEL,
  JOB_TIER_COLOR,
  JOB_BUCKET_LABEL,
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

const CONFIDENCE_LABEL: Record<EmailMatchProposal['confidence'], string> = {
  high: '高',
  medium: '中',
  low: '低'
}

const CONFIDENCE_COLOR: Record<EmailMatchProposal['confidence'], string> = {
  high: '#86efac',
  medium: '#fcd34d',
  low: '#fca5a5'
}

export function ApplicationsPage(): ReactElement {
  const { data: apps, loading, error, setData, refetch } = useAsync(
    () => window.daymate.listApplications()
  )
  const [syncing, setSyncing] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showReview, setShowReview] = useState(false)
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
          } catch (e) {
            console.error(e)
          } finally {
            setSyncing(false)
          }
        }}
      />

      <ReviewSection
        open={showReview}
        onToggle={() => setShowReview((v) => !v)}
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
          hint="点击「同步邮件」从 163 邮箱拉取招聘邮件自动汇总，或「新增投递」手动添加。"
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

const SOURCES_ORDER: ApplicationSource[] = ['boss', 'web', 'referral', 'email', 'manual', 'other']

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

// ── Job recommendation (DORMANT — BOSS search retired for anti-bot; UI
// unmounted in favor of email-driven funnel. Real component kept below for
// one-line re-mount if BOSS search is ever revived.) ──────────────────────

// Top-12 hot cities (boss-cli CITY_CODES) for the checkbox grid; the rest sit
// behind a 「更多」 expand so the grid stays compact. Wire values are Chinese
// city names — boss-cli maps them via CITY_CODES (mirrors how `JobIntent.cities`
// is a string[] of display names, kept Chinese per localization convention).
const POPULAR_CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '成都',
  '南京', '武汉', '西安', '苏州', '长沙', '天津'
]
const MORE_CITIES = [
  '重庆', '郑州', '东莞', '佛山', '合肥', '青岛',
  '宁波', '沈阳', '昆明', '大连', '厦门', '珠海',
  '无锡', '福州', '济南', '哈尔滨', '长春', '南昌',
  '贵阳', '南宁', '石家庄', '太原', '兰州', '海口',
  '常州', '温州', '嘉兴', '徐州', '香港'
]
// Degree dropdown options (boss-cli DEGREE_CODES). 校招生 realistically only
// need 大专/本科/硕士/博士; 「不限」 lets the user opt out of the filter.
const DEGREE_OPTIONS = ['不限', '大专', '本科', '硕士', '博士']

// DORMANT — BOSS search retired for anti-bot. Kept exported (not deleted) so
// re-mounting is a one-line change if BOSS search is ever revived.
export function JobRecommendationSection({
  open,
  onToggle,
  onConverted
}: {
  open: boolean
  onToggle: () => void
  onConverted: () => void
}): ReactElement {
  // Load the current jobSearch config (holds jobIntent).
  const { data: jobConfig, loading, error, refetch } = useAsync<JobSearchSettings | null>(
    () => window.daymate.getJobSearchConfig()
  )
  const intent: JobIntent | undefined = jobConfig?.jobIntent

  const [results, setResults] = useState<JobRecommendations | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchingMore, setFetchingMore] = useState<{ intern: boolean; campus: boolean }>({
    intern: false,
    campus: false
  })
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [relogging, setRelogging] = useState(false)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [tab, setTab] = useState<JobBucket>('intern')

  // Inline jobIntent form state (seeded from loaded config). `experience` is
  // intentionally NOT exposed — the bucket encodes it (校招桶=在校/应届, 实习桶=无).
  const [editing, setEditing] = useState(false)
  const [showMoreCities, setShowMoreCities] = useState(false)
  const [form, setForm] = useState<JobIntent>({
    keyword: '',
    cities: [],
    salaryMin: undefined,
    salaryMax: undefined,
    experience: undefined,
    degree: undefined
  })
  const [saving, setSaving] = useState(false)

  // Seed the form when config arrives.
  useEffect(() => {
    if (jobConfig?.jobIntent) setForm({ ...form, ...jobConfig.jobIntent })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobConfig])

  const fetchJobs = async (): Promise<void> => {
    setFetching(true)
    setFetchError(null)
    try {
      // Anti-bot: fetch ONLY the current tab's bucket per click (N city calls,
      // not 2N). The user switches tabs + clicks 抓取 again for the other bucket.
      const out = await window.daymate.fetchJobRecommendations({ bucket: tab })
      setResults(out)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  const loadMore = async (bucket: JobBucket): Promise<void> => {
    setFetchingMore((s) => ({ ...s, [bucket]: true }))
    setFetchError(null)
    try {
      const out = await window.daymate.fetchJobRecommendations({ bucket, append: true })
      setResults(out)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchingMore((s) => ({ ...s, [bucket]: false }))
    }
  }

  // stoken 过期时就地重新登录（不用切去集成页）：调用 loginBoss() 在系统
  // 预览弹二维码，扫完自动重抓当前桶。camoufox 自动刷新对 search 无效（BOSS
  // 反爬拒认 camoufox token），所以 search 报 stoken 过期时必须扫码补真实 token。
  const reloginAndFetch = async (): Promise<void> => {
    setRelogging(true)
    setFetchError(null)
    try {
      const r = await window.daymate.loginBoss()
      if (r.status === 'connected') {
        // re-fetch the current bucket after a fresh login
        const out = await window.daymate.fetchJobRecommendations({ bucket: tab })
        setResults(out)
      } else {
        setFetchError(r.message || '登录未完成，请重试')
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setRelogging(false)
    }
  }

  const convert = async (securityId: string): Promise<void> => {
    setConvertingId(securityId)
    try {
      await window.daymate.convertJobToApplication(securityId)
      onConverted()
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setConvertingId(null)
    }
  }

  // Job detail modal. The JD body (jobDescription) is untrusted boss data —
  // rendered as text via React (which escapes), never as HTML (§17.12/§17.13).
  const [detailJob, setDetailJob] = useState<BossJob | null>(null)
  const [detailSid, setDetailSid] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const openDetail = async (securityId: string): Promise<void> => {
    setDetailSid(securityId)
    setDetailLoading(true)
    setDetailError(null)
    setDetailJob(null)
    try {
      const job = await window.daymate.getJobDetail(securityId)
      setDetailJob(job)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetailLoading(false)
    }
  }
  const closeDetail = (): void => {
    setDetailJob(null)
    setDetailSid(null)
    setDetailError(null)
    setDetailLoading(false)
  }

  const saveIntent = async (): Promise<void> => {
    setSaving(true)
    try {
      const current = jobConfig ?? {}
      await window.daymate.setJobSearchConfig({
        ...current,
        jobIntent: {
          keyword: form.keyword.trim(),
          cities: form.cities ?? [],
          salaryMin: form.salaryMin ? Number(form.salaryMin) : undefined,
          salaryMax: form.salaryMax ? Number(form.salaryMax) : undefined,
          // experience is bucket-derived, not user-set; clear any stale value.
          experience: undefined,
          degree: form.degree && form.degree !== '不限' ? form.degree : undefined
        }
      })
      setEditing(false)
      refetch()
    } finally {
      setSaving(false)
    }
  }

  const toggleCity = (city: string): void => {
    const set = new Set(form.cities ?? [])
    if (set.has(city)) set.delete(city)
    else set.add(city)
    setForm({ ...form, cities: Array.from(set) })
  }

  const intentConfigured = !!intent?.keyword?.trim()
  const bucketList = results ? results[tab] : []
  const bucketHasMore = results ? results[tab === 'intern' ? 'internHasMore' : 'campusHasMore'] : false
  const bucketLoadingMore = fetchingMore[tab]

  return (
    <div className="mt-4 rounded-lg border border-white/5" style={{ background: 'var(--dm-panel)' }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-semibold text-white/80">
          岗位推荐
          {intentConfigured && (
            <span className="ml-1.5 text-white/40">
              · {intent!.keyword}
              {intent!.cities && intent!.cities.length > 0 ? ` / ${intent!.cities.join('/')}` : ''}
            </span>
          )}
        </span>
        <span className="text-xs text-white/40">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-white/5 px-4 py-3">
          {loading ? (
            <Loading label="正在加载意向配置…" />
          ) : error ? (
            <ErrorState message={error.message} onRetry={refetch} />
          ) : (
            <>
              {/* jobIntent config (inline, collapsible) */}
              {editing ? (
                <div className="space-y-3 rounded-lg border border-white/5 p-3" style={{ background: 'var(--dm-bg)' }}>
                  <div className="text-sm font-semibold text-white/80">求职意向</div>
                  <input
                    value={form.keyword}
                    onChange={(e) => setForm({ ...form, keyword: e.target.value })}
                    placeholder="目标岗位关键词（如 Go 后端）"
                    className="w-full rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
                  />
                  {/* City checkbox grid (top-12 + 更多 expand) */}
                  <div>
                    <div className="mb-1 text-xs text-white/50">意向城市（可多选）</div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {POPULAR_CITIES.map((c) => (
                        <label
                          key={c}
                          className="flex cursor-pointer items-center gap-1 rounded bg-white/5 px-1.5 py-1 text-xs text-white/80"
                        >
                          <input
                            type="checkbox"
                            checked={(form.cities ?? []).includes(c)}
                            onChange={() => toggleCity(c)}
                            className="accent-blue-500"
                          />
                          {c}
                        </label>
                      ))}
                      {showMoreCities &&
                        MORE_CITIES.map((c) => (
                          <label
                            key={c}
                            className="flex cursor-pointer items-center gap-1 rounded bg-white/5 px-1.5 py-1 text-xs text-white/80"
                          >
                            <input
                              type="checkbox"
                              checked={(form.cities ?? []).includes(c)}
                              onChange={() => toggleCity(c)}
                              className="accent-blue-500"
                            />
                            {c}
                          </label>
                        ))}
                    </div>
                    <button
                      onClick={() => setShowMoreCities((s) => !s)}
                      className="mt-1 text-xs text-blue-400/80 hover:text-blue-300"
                    >
                      {showMoreCities ? '收起更多城市' : '更多城市…'}
                    </button>
                  </div>
                  {/* Salary + degree */}
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={form.salaryMin ?? ''}
                      onChange={(e) =>
                        setForm({ ...form, salaryMin: e.target.value ? Number(e.target.value) : undefined })
                      }
                      placeholder="最低 K"
                      type="number"
                      className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
                    />
                    <input
                      value={form.salaryMax ?? ''}
                      onChange={(e) =>
                        setForm({ ...form, salaryMax: e.target.value ? Number(e.target.value) : undefined })
                      }
                      placeholder="最高 K"
                      type="number"
                      className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
                    />
                    <select
                      value={form.degree ?? '不限'}
                      onChange={(e) => setForm({ ...form, degree: e.target.value })}
                      className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
                    >
                      {DEGREE_OPTIONS.map((d) => (
                        <option key={d} value={d} className="bg-[var(--dm-bg)]">
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="text-xs text-white/40">
                    实习与秋招正职分桶抓取：实习桶仅筛实习岗；秋招正职桶筛应届全职岗。无需手填经验。
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={saveIntent}
                      disabled={saving || !form.keyword.trim()}
                      className="rounded bg-blue-500/80 px-3 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {saving ? '保存中…' : '保存意向'}
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false)
                        if (intent) setForm({ ...form, ...intent })
                      }}
                      className="rounded bg-white/5 px-3 py-1 text-xs text-white/70"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50">
                    {intentConfigured
                      ? `意向：${intent!.keyword}${intent!.cities?.length ? ' · ' + intent!.cities.join('/') : ''}${intent!.salaryMin ? ' · ' + intent!.salaryMin + '-' + (intent!.salaryMax ?? '') + 'K' : ''}${intent!.degree ? ' · ' + intent!.degree : ''}`
                      : '尚未配置求职意向 — 请先设置关键词与城市。'}
                  </span>
                  <button
                    onClick={() => setEditing(true)}
                    className="rounded bg-white/5 px-2 py-1 text-xs text-white/70"
                  >
                    {intentConfigured ? '修改意向' : '设置意向'}
                  </button>
                </div>
              )}

              {/* 抓取 button */}
              <div className="flex items-center gap-2">
                <button
                  onClick={fetchJobs}
                  disabled={fetching || !intentConfigured}
                  className="rounded bg-blue-500/80 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                >
                  {fetching ? '抓取中…（顺序抓取，稍候）' : '抓取岗位'}
                </button>
                {results && !fetching && (
                  <span className="text-xs text-white/50">{results.summary}</span>
                )}
              </div>

              {fetchError && (
                <div className="flex flex-wrap items-center gap-2">
                  <ErrorState message={fetchError} onRetry={fetchJobs} />
                  <button
                    onClick={reloginAndFetch}
                    disabled={relogging}
                    className="rounded bg-amber-600/80 px-3 py-1 text-xs text-white disabled:opacity-50"
                  >
                    {relogging ? '登录中… 请扫码' : '重新登录 BOSS（扫码）'}
                  </button>
                </div>
              )}

              {results?.error && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300/90">
                  <span>{results.error}</span>
                  <button
                    onClick={reloginAndFetch}
                    disabled={relogging}
                    className="rounded bg-amber-600/80 px-2 py-0.5 text-xs text-white disabled:opacity-50"
                  >
                    {relogging ? '登录中… 请扫码' : '重新登录 BOSS'}
                  </button>
                </div>
              )}

              {/* Bucket tabs */}
              {results && (
                <div className="flex items-center gap-1 border-b border-white/5">
                  {(['intern', 'campus'] as JobBucket[]).map((b) => (
                    <button
                      key={b}
                      onClick={() => setTab(b)}
                      className={`border-b-2 px-3 py-1.5 text-sm transition ${
                        tab === b
                          ? 'border-blue-400 text-white/90'
                          : 'border-transparent text-white/50 hover:text-white/70'
                      }`}
                    >
                      {JOB_BUCKET_LABEL[b]}（{results[b].length}）
                    </button>
                  ))}
                </div>
              )}

              {/* Scored job list (current bucket) — click a card for full detail */}
              {results && bucketList.length > 0 && (
                <div className="space-y-1.5">
                  {bucketList.map((r) => {
                    const lowMatch = r.tier === 'low' || r.tier === 'skip'
                    return (
                      <div
                        key={r.securityId}
                        onClick={() => openDetail(r.securityId)}
                        className="flex cursor-pointer items-center justify-between rounded border border-white/5 px-3 py-2 transition hover:border-white/15"
                        style={{ background: 'var(--dm-bg)' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm text-white/90">
                              {r.companyName} · {r.jobName}
                            </span>
                            <span
                              className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                              style={{
                                background: JOB_TIER_COLOR[r.tier] + '33',
                                color: JOB_TIER_COLOR[r.tier]
                              }}
                            >
                              {JOB_TIER_LABEL[r.tier]} {r.score}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-white/40">
                            {[r.salary, r.city].filter(Boolean).join(' · ')}
                            {r.reasons.length > 0 && ` · ${r.reasons.join('；')}`}
                          </div>
                        </div>
                        <div className="ml-2 flex shrink-0 items-center gap-2">
                          {lowMatch && <span className="text-[10px] text-white/30">低匹配</span>}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              convert(r.securityId)
                            }}
                            disabled={convertingId === r.securityId}
                            className="rounded bg-emerald-500/80 px-2 py-1 text-xs text-white disabled:opacity-40"
                          >
                            {convertingId === r.securityId ? '转投中…' : '转投递'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {bucketHasMore && (
                    <button
                      onClick={() => loadMore(tab)}
                      disabled={bucketLoadingMore}
                      className="w-full rounded border border-white/5 bg-white/5 py-1.5 text-xs text-white/70 disabled:opacity-40"
                    >
                      {bucketLoadingMore ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </div>
              )}

              {results && bucketList.length === 0 && !fetching && (
                <EmptyState
                  title={
                    results[tab === 'intern' ? 'internFetched' : 'campusFetched']
                      ? `${JOB_BUCKET_LABEL[tab]}暂无匹配岗位`
                      : `${JOB_BUCKET_LABEL[tab]}尚未抓取`
                  }
                  hint={
                    results[tab === 'intern' ? 'internFetched' : 'campusFetched']
                      ? '可放宽城市/学历条件后重试，或切换另一桶。'
                      : '点击上方「抓取岗位」获取本桶岗位。'
                  }
                />
              )}

              {/* Job detail modal. JD body (jobDescription) is untrusted boss
                  data — rendered as text (React escapes), never HTML (§17). */}
              {(detailLoading || detailJob || detailError) && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                  onClick={closeDetail}
                >
                  <div
                    className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-white/10 p-4"
                    style={{ background: 'var(--dm-panel)' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {detailLoading && <Loading label="正在加载职位详情…" />}
                    {detailError && (
                      <ErrorState
                        message={detailError}
                        onRetry={() => detailSid && openDetail(detailSid)}
                      />
                    )}
                    {detailJob && (
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-white/90">
                              {detailJob.jobName}
                            </div>
                            <div className="mt-0.5 text-sm text-white/60">
                              {detailJob.companyName}
                              {detailJob.brandName && detailJob.brandName !== detailJob.companyName
                                ? ` · ${detailJob.brandName}`
                                : ''}
                            </div>
                          </div>
                          <button
                            onClick={closeDetail}
                            className="shrink-0 rounded bg-white/5 px-2 py-1 text-xs text-white/60"
                          >
                            关闭
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-white/60">
                          {detailJob.salary && <span>💰 {detailJob.salary}</span>}
                          {detailJob.city && <span>📍 {detailJob.city}</span>}
                          {detailJob.experience && <span>经验：{detailJob.experience}</span>}
                          {detailJob.degree && <span>学历：{detailJob.degree}</span>}
                        </div>
                        {(detailJob.industry || detailJob.scale || detailJob.stage) && (
                          <div className="flex flex-wrap gap-2 text-xs text-white/50">
                            {detailJob.industry && <span>行业：{detailJob.industry}</span>}
                            {detailJob.scale && <span>规模：{detailJob.scale}</span>}
                            {detailJob.stage && <span>阶段：{detailJob.stage}</span>}
                          </div>
                        )}
                        {detailJob.jobLabels && detailJob.jobLabels.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {detailJob.jobLabels.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        {detailJob.hrName && (
                          <div className="text-xs text-white/50">
                            招聘者：{detailJob.hrName}
                            {detailJob.hrTitle ? `（${detailJob.hrTitle}）` : ''}
                          </div>
                        )}
                        {detailJob.jobDescription && (
                          <div>
                            <div className="mb-1 text-xs font-semibold text-white/70">
                              职位描述
                            </div>
                            {/* §17: JD body is untrusted boss data — text only,
                                never dangerouslySetInnerHTML. React escapes. */}
                            <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-white/70">
                              {detailJob.jobDescription}
                            </div>
                          </div>
                        )}
                        <div className="flex justify-end gap-2 border-t border-white/5 pt-2">
                          <button
                            onClick={() => {
                              convert(detailJob.securityId)
                            }}
                            disabled={convertingId === detailJob.securityId}
                            className="rounded bg-emerald-500/80 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                          >
                            {convertingId === detailJob.securityId ? '转投中…' : '转投递'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
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
  open,
  onToggle,
  emailSyncing,
  onSyncEmail
}: {
  open: boolean
  onToggle: () => void
  emailSyncing: boolean
  onSyncEmail: () => Promise<void>
}): ReactElement {
  const { data, loading, error, setData, refetch } = useAsync<EmailMatchProposal[]>(
    () => window.daymate.listPendingEmailMatches()
  )

  // Live push: main updates the pending queue after a sync or a match.
  useEffect(() => {
    return window.daymate.onEmailMatchesChanged((matches) => setData(matches))
  }, [setData])

  const proposals = data ?? []

  const confirm = async (messageId: string): Promise<void> => {
    try {
      await window.daymate.confirmEmailMatch(messageId)
      refetch()
    } catch (e) {
      console.error(e)
    }
  }

  const ignore = async (messageId: string): Promise<void> => {
    try {
      await window.daymate.ignoreEmailMatch(messageId)
      refetch()
    } catch (e) {
      console.error(e)
    }
  }

  const sync = async (): Promise<void> => {
    await onSyncEmail()
    refetch()
  }

  return (
    <div className="mt-4 rounded-lg border border-white/5" style={{ background: 'var(--dm-panel)' }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-semibold text-white/80">
          邮件待确认{proposals.length > 0 && (
            <span className="ml-1.5 text-amber-300/70">· {proposals.length}</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              void sync()
            }}
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
          >
            {emailSyncing ? '同步中…' : '同步邮件'}
          </span>
          <span className="text-xs text-white/40">{open ? '收起' : '展开'}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-white/5 px-4 py-3">
          {loading ? (
            <Loading label="正在加载邮件匹配…" />
          ) : error ? (
            <ErrorState message={error.message} onRetry={refetch} />
          ) : proposals.length === 0 ? (
            <p className="text-sm text-white/40">无待确认邮件。点击「同步邮件」扫描收件箱。</p>
          ) : (
            <div className="space-y-2">
              {proposals.map((p) => (
                <EmailMatchCard
                  key={p.id}
                  proposal={p}
                  onConfirm={() => confirm(p.messageId)}
                  onIgnore={() => ignore(p.messageId)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EmailMatchCard({
  proposal,
  onConfirm,
  onIgnore
}: {
  proposal: EmailMatchProposal
  onConfirm: () => void
  onIgnore: () => void
}): ReactElement {
  return (
    <div className="rounded bg-white/5 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-sm text-white/90">{proposal.subject}</div>
          {proposal.from && (
            <div className="mt-0.5 text-xs text-white/40">来自 {proposal.from}</div>
          )}
          {(proposal.company || proposal.position || proposal.applicationCompany) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-white/55">
              <span>{statusLabel(APPLICATION_EVENT_LABEL, proposal.eventType)}</span>
              <span>·</span>
              <span>
                {proposal.company ?? proposal.applicationCompany}
                {proposal.position ? ` / ${proposal.position}` : proposal.applicationPosition ? ` / ${proposal.applicationPosition}` : ''}
              </span>
            </div>
          )}
          {proposal.evidence && (
            <div className="mt-0.5 text-xs text-white/35">{proposal.evidence}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              background: `${CONFIDENCE_COLOR[proposal.confidence]}1f`,
              color: CONFIDENCE_COLOR[proposal.confidence]
            }}
          >
            置信度 {CONFIDENCE_LABEL[proposal.confidence]}
          </span>
          <div className="flex gap-1.5">
            <button
              onClick={onConfirm}
              className="rounded bg-white/10 px-2 py-1 text-xs text-white/90 hover:bg-white/20"
            >
              确认
            </button>
            <button
              onClick={onIgnore}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/55 hover:bg-white/10"
            >
              忽略
            </button>
          </div>
        </div>
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

  return (
    <div className="rounded-lg border border-white/5 p-3" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-start gap-3">
        <button
          onClick={onSelect}
          className="flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            {/* Position first — the user may apply to several positions at one
             * company; position is the primary identity. */}
            <span className="text-sm font-medium text-white/90">{view.application.position}</span>
            <span className="text-xs text-white/40">·</span>
            <span className="text-xs text-white/55">{view.application.company}</span>
            {view.application.city && (
              <>
                <span className="text-xs text-white/40">·</span>
                <span className="text-xs text-white/55">{view.application.city}</span>
              </>
            )}
            {view.application.salaryRange && (
              <>
                <span className="text-xs text-white/40">·</span>
                <span className="text-xs text-white/55">薪资 {view.application.salaryRange}</span>
              </>
            )}
            {view.application.priority === 'back' && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">
                {statusLabel(APPLICATION_PRIORITY_LABEL, view.application.priority ?? 'normal')}
              </span>
            )}
          </div>
          {/* JD snippet — truncated; click the card to see the full JD in the
           * detail view (where 搜索 JD can enrich it). */}
          {view.application.jdText && (
            <div className="mt-0.5 line-clamp-1 text-xs text-white/40">
              {view.application.jdText}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-xs text-white/35">
            <span>{statusLabel(APPLICATION_SOURCE_LABEL, view.application.source)}</span>
            <span>·</span>
            <span>投递于 {new Date(view.application.appliedAt).toLocaleDateString('zh-CN')}</span>
            {view.application.stage && (
              <>
                <span>·</span>
                <span className="text-white/50">{view.application.stage}</span>
              </>
            )}
            {view.daysSinceLastEvent !== undefined && view.daysSinceLastEvent >= 3 && !view.isTerminal && view.currentStatus !== 'offer' && (
              <>
                <span>·</span>
                <span className="text-amber-300/70">{view.daysSinceLastEvent} 天无进展</span>
              </>
            )}
          </div>
        </button>
        <button
          onClick={() => setShowEvent((v) => !v)}
          className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
        >
          追加进展
        </button>
      </div>

      {/* Timeline chips */}
      {view.events.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {view.events.map((e) => (
            <span
              key={e.id}
              className="rounded px-1.5 py-0.5 text-xs"
              style={{
                background: e.locked ? 'rgba(250,204,21,0.12)' : 'rgba(255,255,255,0.05)',
                color: e.locked ? '#fcd34d' : 'rgba(255,255,255,0.6)'
              }}
              title={e.evidence}
            >
              {statusLabel(APPLICATION_EVENT_LABEL, e.type)}
              {e.type === 'interview' && e.round ? ` ${e.round}面` : ''}
              {e.locked ? ' 🔒' : ''}
            </span>
          ))}
        </div>
      )}

      {showEvent && (
        <div className="mt-2 grid grid-cols-4 gap-2 border-t border-white/5 pt-2">
          <select
            value={ev.type}
            onChange={(e) => setEv({ ...ev, type: e.target.value as ApplicationEventType })}
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
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
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
            />
          )}
          <input
            type="date"
            value={ev.eventAt}
            onChange={(e) => setEv({ ...ev, eventAt: e.target.value })}
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
          />
          <input
            value={ev.evidence}
            onChange={(e) => setEv({ ...ev, evidence: e.target.value })}
            placeholder="备注"
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
          />
          <button
            onClick={submitEvent}
            className="col-span-4 rounded bg-white/10 px-2 py-1 text-xs text-white/90 hover:bg-white/20"
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
  onSyncEmail
}: {
  onAdd: () => void
  syncing: boolean
  onSyncEmail: () => Promise<void>
}): ReactElement {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-white">投递</h1>
        <p className="mt-1 text-sm text-white/45">邮件自动汇总 + 手动录入（官网/内推/线下）。</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => void onSyncEmail()}
          disabled={syncing}
          className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          {syncing ? '同步中…' : '同步邮件'}
        </button>
        <button
          onClick={onAdd}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20"
        >
          新增投递
        </button>
      </div>
    </div>
  )
}
