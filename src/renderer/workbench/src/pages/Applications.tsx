import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ApplicationView,
  ApplicationEventType,
  ApplicationSource,
  BossStatus
} from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import {
  APPLICATION_SOURCE_LABEL,
  APPLICATION_EVENT_LABEL,
  statusLabel
} from '../labels'

// 投递漏斗 (Spec §3, §5) — cross-channel single source of truth: BOSS 直聘
// (boss-cli sync) + manual 官网/内推/线下 entries. Each card shows the
// company, current stage (latest event; offer/rejected terminal), and the full
// event timeline. Manual entries + manual events are local writes (no
// approval); "同步 BOSS" pulls boss.applied/interviews/chat.

// Group order for the funnel — active stages first, terminals last.
const STATUS_ORDER: ApplicationEventType[] = [
  'applied',
  'communicated',
  'assessment',
  'written_test',
  'interview',
  'offer',
  'rejected',
  'withdrawn'
]

const EVENT_TYPES: ApplicationEventType[] = [
  'communicated',
  'assessment',
  'written_test',
  'interview',
  'offer',
  'rejected',
  'withdrawn'
]

export function ApplicationsPage(): ReactElement {
  const { data: apps, loading, error, setData, refetch } = useAsync(
    () => window.daymate.listApplications()
  )
  const [bossStatus, setBossStatus] = useState<BossStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({
    company: '',
    position: '',
    source: 'manual' as ApplicationSource,
    appliedAt: '',
    channelRef: '',
    notes: ''
  })

  // Live updates: main pushes the latest funnel views after a create/sync.
  useEffect(() => {
    return window.daymate.onApplicationChanged((views) => setData(views))
  }, [setData])

  // Boss health banner.
  useEffect(() => {
    void window.daymate.getBossStatus().then(setBossStatus)
  }, [])

  const syncBoss = async (): Promise<void> => {
    setSyncing(true)
    try {
      await window.daymate.syncBossApplications()
      const s = await window.daymate.getBossStatus()
      setBossStatus(s)
      refetch()
    } catch (e) {
      console.error(e)
    } finally {
      setSyncing(false)
    }
  }

  const submitAdd = async (): Promise<void> => {
    if (!addForm.company.trim() || !addForm.position.trim()) return
    try {
      await window.daymate.createApplication({
        company: addForm.company.trim(),
        position: addForm.position.trim(),
        source: addForm.source,
        appliedAt: addForm.appliedAt ? new Date(addForm.appliedAt).toISOString() : undefined,
        channelRef: addForm.channelRef.trim() || undefined,
        notes: addForm.notes.trim() || undefined
      })
      setAddForm({ company: '', position: '', source: 'manual', appliedAt: '', channelRef: '', notes: '' })
      setShowAdd(false)
      refetch()
    } catch (e) {
      console.error(e)
    }
  }

  if (loading) return <Loading label="正在加载投递…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = apps ?? []

  return (
    <div>
      <Header
        onSync={syncBoss}
        syncing={syncing}
        onAdd={() => setShowAdd((v) => !v)}
      />

      {bossStatus && (
        <div
          className="mt-4 rounded-lg border p-3 text-xs"
          style={{
            background: 'var(--dm-panel)',
            borderColor: bossStatus.authenticated ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.25)',
            color: bossStatus.authenticated ? '#86efac' : '#fcd34d'
          }}
        >
          BOSS 直聘：{bossStatus.message}
        </div>
      )}

      {showAdd && (
        <div className="mt-4 space-y-2 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-sm font-semibold text-white/80">新增投递</div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={addForm.company}
              onChange={(e) => setAddForm({ ...addForm, company: e.target.value })}
              placeholder="公司"
              className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
            />
            <input
              value={addForm.position}
              onChange={(e) => setAddForm({ ...addForm, position: e.target.value })}
              placeholder="职位"
              className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={addForm.source}
              onChange={(e) => setAddForm({ ...addForm, source: e.target.value as ApplicationSource })}
              className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
            >
              {(['manual', 'web', 'referral', 'other'] as ApplicationSource[]).map((s) => (
                <option key={s} value={s} className="bg-zinc-800">
                  {statusLabel(APPLICATION_SOURCE_LABEL, s)}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={addForm.appliedAt}
              onChange={(e) => setAddForm({ ...addForm, appliedAt: e.target.value })}
              className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
            />
            <input
              value={addForm.channelRef}
              onChange={(e) => setAddForm({ ...addForm, channelRef: e.target.value })}
              placeholder="内推人/链接（可选）"
              className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
            />
          </div>
          <input
            value={addForm.notes}
            onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
            placeholder="备注（可选）"
            className="w-full rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
          />
          <div className="flex gap-2">
            <button
              onClick={submitAdd}
              className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20"
            >
              保存
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/60 hover:bg-white/10"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState
          title="暂无投递记录"
          hint="点击「新增投递」手动添加，或「同步 BOSS」从 BOSS 直聘拉取。"
        />
      ) : (
        <div className="mt-6 space-y-6">
          {STATUS_ORDER.map((status) => {
            const group = list.filter((v) => v.currentStatus === status)
            if (group.length === 0) return null
            return (
              <section key={status}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
                  {statusLabel(APPLICATION_EVENT_LABEL, status)} · {group.length}
                </h2>
                <div className="space-y-2">
                  {group.map((v) => (
                    <ApplicationCard key={v.application.id} view={v} onChanged={refetch} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ApplicationCard({
  view,
  onChanged
}: {
  view: ApplicationView
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
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-white/90">{view.application.company}</span>
            <span className="text-xs text-white/40">·</span>
            <span className="text-sm text-white/70">{view.application.position}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-white/35">
            <span>{statusLabel(APPLICATION_SOURCE_LABEL, view.application.source)}</span>
            <span>·</span>
            <span>投递于 {new Date(view.application.appliedAt).toLocaleDateString('zh-CN')}</span>
            {view.daysSinceLastEvent !== undefined && view.daysSinceLastEvent >= 3 && !view.isTerminal && (
              <>
                <span>·</span>
                <span className="text-amber-300/70">{view.daysSinceLastEvent} 天无进展</span>
              </>
            )}
          </div>
        </div>
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
  onSync,
  syncing,
  onAdd
}: {
  onSync: () => void
  syncing: boolean
  onAdd: () => void
}): ReactElement {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-white">投递</h1>
        <p className="mt-1 text-sm text-white/45">跨渠道投递漏斗——BOSS 直聘 + 官网/内推。</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onSync}
          disabled={syncing}
          className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 disabled:opacity-50"
        >
          {syncing ? '同步中…' : '同步 BOSS'}
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
