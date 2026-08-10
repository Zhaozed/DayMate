import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { RoutineDefinition, RoutineRun, RoutineTrigger } from '@shared/types'
import { PRESET_ROUTINE_IDS } from '@shared/constants'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import { RoutineBuilder } from '../components/RoutineBuilder'
import { RUN_STATUS_LABEL, statusLabel } from '../labels'

// Routines page (Spec §18). Lists preset/custom routines: trigger + next run,
// run history (expandable), manual Run, enable/disable, and inline trigger
// editing via updateRoutine. Step editing stays M5.
export function RoutinesPage(): ReactElement {
  const { data: routines, loading, error, setData, refetch } = useAsync<RoutineDefinition[]>(
    () => window.daymate.listRoutines()
  )
  const [lastRuns, setLastRuns] = useState<Record<string, RoutineRun | undefined>>({})
  const [running, setRunning] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [history, setHistory] = useState<RoutineRun[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  // After the routine list loads, fetch the latest run per routine.
  useEffect(() => {
    if (!routines) return
    let cancelled = false
    void (async (): Promise<void> => {
      const runs: Record<string, RoutineRun | undefined> = {}
      for (const r of routines) {
        const rlist = await window.daymate.listRoutineRuns(r.id)
        runs[r.id] = rlist[0]
      }
      if (!cancelled) setLastRuns(runs)
    })()
    return () => {
      cancelled = true
    }
  }, [routines])

  const run = async (id: string): Promise<void> => {
    setRunning(id)
    try {
      await window.daymate.runRoutine(id)
      await refetch()
    } catch (err) {
      console.error(err)
    } finally {
      setRunning(null)
    }
  }

  const toggle = async (r: RoutineDefinition): Promise<void> => {
    const next = await window.daymate.setRoutineEnabled(r.id, !r.enabled)
    setData((prev) => (prev ?? []).map((x) => (x.id === r.id ? next : x)))
  }

  const remove = async (r: RoutineDefinition): Promise<void> => {
    setDeleting(r.id)
    try {
      await window.daymate.deleteRoutine(r.id)
      setData((prev) => (prev ?? []).filter((x) => x.id !== r.id))
    } catch (err) {
      console.error(err)
    } finally {
      setDeleting(null)
    }
  }

  const showHistory = async (id: string): Promise<void> => {
    if (historyId === id) {
      setHistoryId(null)
      return
    }
    setHistoryId(id)
    try {
      setHistory(await window.daymate.listRoutineRuns(id))
    } catch (err) {
      console.error(err)
      setHistory([])
    }
  }

  if (loading) return <Loading label="正在加载例程…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = routines ?? []
  if (list.length === 0) {
    return (
      <div>
        <Header onNew={() => setBuilding((v) => !v)} />
        {building && (
          <RoutineBuilder
            onClose={() => setBuilding(false)}
            onCreated={(r) => {
              setData((prev) => [...(prev ?? []), r])
              setBuilding(false)
            }}
          />
        )}
        <EmptyState title="无例程" hint="预设例程会在首次启动时植入。" />
      </div>
    )
  }

  return (
    <div>
      <Header onNew={() => setBuilding((v) => !v)} />
      {building && (
        <RoutineBuilder
          onClose={() => setBuilding(false)}
          onCreated={(r) => {
            setData((prev) => [...(prev ?? []), r])
            setBuilding(false)
          }}
        />
      )}
      <div className="mt-6 space-y-3">
        {list.map((r) => {
          const last = lastRuns[r.id]
          const isEditing = editId === r.id
          const isHistory = historyId === r.id
          const isPreset = (PRESET_ROUTINE_IDS as readonly string[]).includes(r.id)
          return (
            <div key={r.id} className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/90">{r.name}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/50">
                      {r.trigger.type}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-white/45">{r.description}</p>
                  <div className="mt-2 text-xs text-white/35">
                    <span>{describeTrigger(r.trigger)}</span>
                    <span className="mx-2 text-white/20">·</span>
                    <span>{nextRun(r.trigger, last)}</span>
                    <span className="mx-2 text-white/20">·</span>
                    <span>{last ? `上次：${statusLabel(RUN_STATUS_LABEL, last.status)}` : '从未运行'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggle(r)}
                    className={`rounded px-2 py-1 text-xs ${r.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-white/50'}`}
                  >
                    {r.enabled ? '已启用' : '已禁用'}
                  </button>
                  <button
                    onClick={() => showHistory(r.id)}
                    className="rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10"
                  >
                    {isHistory ? '收起' : '历史'}
                  </button>
                  <button
                    onClick={() => setEditId(isEditing ? null : r.id)}
                    className="rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10"
                  >
                    {isEditing ? '关闭' : '编辑'}
                  </button>
                  <button
                    onClick={() => run(r.id)}
                    disabled={running === r.id}
                    className="rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--dm-accent)' }}
                  >
                    {running === r.id ? '运行中…' : '运行'}
                  </button>
                  {!isPreset && (
                    <button
                      onClick={() => remove(r)}
                      disabled={deleting === r.id}
                      className="rounded bg-white/5 px-2 py-1 text-xs text-rose-300/70 hover:bg-white/10 disabled:opacity-50"
                    >
                      {deleting === r.id ? '…' : '删除'}
                    </button>
                  )}
                </div>
              </div>

              {isHistory && (
                <RunHistory routineId={r.id} runs={history} />
              )}

              {isEditing && (
                <TriggerEditor
                  routine={r}
                  onClose={() => setEditId(null)}
                  onSaved={(next) => {
                    setData((prev) => (prev ?? []).map((x) => (x.id === r.id ? next : x)))
                    setEditId(null)
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Header({ onNew }: { onNew: () => void }): ReactElement {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-white">例程</h1>
        <p className="mt-1 text-sm text-white/45">可配置、由 schema 驱动的工作流。</p>
      </div>
      <button
        onClick={onNew}
        className="rounded px-3 py-1.5 text-xs font-medium text-white"
        style={{ background: 'var(--dm-accent)' }}
      >
        新建例程
      </button>
    </div>
  )
}

// Human-readable trigger summary.
function describeTrigger(t: RoutineTrigger): string {
  switch (t.type) {
    case 'manual':
      return '手动'
    case 'schedule':
      return `定时：${t.cron}（${t.timezone}）`
    case 'email_poll':
      return `每 ${t.intervalMinutes} 分钟`
    case 'calendar_before':
      return `会议前 ${t.minutesBefore} 分钟`
  }
}

// Rough next-run hint. For poll we can compute from the last run + interval;
// cron next-fire needs a parser (out of scope for MVP), so we just surface the
// schedule. Never claim precision we don't have.
function nextRun(t: RoutineTrigger, last: RoutineRun | undefined): string {
  if (t.type === 'manual') return '按需运行'
  if (t.type === 'schedule') return '见计划'
  if (t.type === 'calendar_before') return '下次会议前'
  if (t.type === 'email_poll') {
    const intervalMs = t.intervalMinutes * 60_000
    const base = last ? Date.parse(last.startedAt) : Date.now()
    if (Number.isNaN(base)) return '即将'
    return `下次 ≈ ${new Date(base + intervalMs).toLocaleString()}`
  }
  return '—'
}

function RunHistory({ routineId, runs }: { routineId: string; runs: RoutineRun[] }): ReactElement {
  return (
    <div className="mt-3 rounded border border-white/5 p-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide text-white/40">运行历史 — {routineId}</div>
      {runs.length === 0 ? (
        <div className="mt-2 text-xs text-white/35">暂无运行记录。</div>
      ) : (
        <ol className="mt-2 space-y-1">
          {runs.slice(0, 10).map((run) => (
            <li key={run.id} className="flex items-center gap-2 text-xs text-white/65">
              <span className={`rounded px-1.5 py-0.5 ${runStatusClass(run.status)}`}>
                {statusLabel(RUN_STATUS_LABEL, run.status)}
              </span>
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span className="font-mono text-white/30">{run.id}</span>
              {run.error && <span className="text-rose-300/70">— {run.error}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function runStatusClass(status: RoutineRun['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/15 text-emerald-300'
    case 'failed':
    case 'cancelled':
      return 'bg-rose-500/15 text-rose-300'
    case 'waiting_approval':
      return 'bg-amber-500/15 text-amber-300'
    default:
      return 'bg-white/5 text-white/50'
  }
}

// Inline trigger editor. Patches trigger + enabled via updateRoutine; steps are
// not editable here (M5).
function TriggerEditor({
  routine,
  onClose,
  onSaved
}: {
  routine: RoutineDefinition
  onClose: () => void
  onSaved: (next: RoutineDefinition) => void
}): ReactElement {
  const t = routine.trigger
  const [type, setType] = useState<RoutineTrigger['type']>(t.type)
  const [cron, setCron] = useState(t.type === 'schedule' ? t.cron : '0 9 * * 1-5')
  const [timezone, setTimezone] = useState(t.type === 'schedule' ? t.timezone : 'Asia/Shanghai')
  const [intervalMinutes, setIntervalMinutes] = useState(
    t.type === 'email_poll' ? t.intervalMinutes : 10
  )
  const [minutesBefore, setMinutesBefore] = useState(t.type === 'calendar_before' ? t.minutesBefore : 15)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const buildTrigger = (): RoutineTrigger => {
    switch (type) {
      case 'manual':
        return { type: 'manual' }
      case 'schedule':
        return { type: 'schedule', cron, timezone }
      case 'email_poll':
        return { type: 'email_poll', intervalMinutes }
      case 'calendar_before':
        return { type: 'calendar_before', minutesBefore }
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const next = await window.daymate.updateRoutine(routine.id, { trigger: buildTrigger() })
      onSaved(next)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded border border-white/5 p-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide text-white/40">编辑触发方式</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-xs text-white/50">
          类型
          <select
            value={type}
            onChange={(e) => setType(e.target.value as RoutineTrigger['type'])}
            className="ml-2 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          >
            <option value="manual">手动</option>
            <option value="schedule">定时（cron）</option>
            <option value="email_poll">邮件轮询（间隔）</option>
            <option value="calendar_before">会议提前</option>
          </select>
        </label>

        {type === 'schedule' && (
          <>
            <label className="text-xs text-white/50">
              Cron
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className="ml-2 w-40 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
              />
            </label>
            <label className="text-xs text-white/50">
              时区
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="ml-2 w-40 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
              />
            </label>
          </>
        )}
        {type === 'email_poll' && (
          <label className="text-xs text-white/50">
            间隔（分钟）
            <input
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
        )}
        {type === 'calendar_before' && (
          <label className="text-xs text-white/50">
            提前（分钟）
            <input
              type="number"
              min={1}
              value={minutesBefore}
              onChange={(e) => setMinutesBefore(Number(e.target.value))}
              className="ml-2 w-24 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
        )}
      </div>

      {err && <div className="mt-2 text-xs text-rose-300/80">{err}</div>}

      <div className="mt-3 flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button onClick={onClose} className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 hover:bg-white/10">
          取消
        </button>
      </div>
    </div>
  )
}
