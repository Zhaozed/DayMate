import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppInfo, ActivityEvent, RoutineDefinition } from '@shared/types'
import { useAsync } from '../hooks/useAsync'

// Home (Spec §18). Latest activity summary + a manual "Run Morning Brief"
// button. Keeps the M0 IPC health card.
export function HomePage(): ReactElement {
  const { data: info } = useAsync<AppInfo | null>(async () => {
    try {
      return await window.daymate.getAppInfo()
    } catch {
      return null
    }
  })
  const { data: routines } = useAsync<RoutineDefinition[]>(() => window.daymate.listRoutines())
  const { data: activity, loading: activityLoading, error: activityError, setData: setActivity } =
    useAsync<ActivityEvent[]>(() => window.daymate.listActivity())
  const [running, setRunning] = useState(false)

  // Live push: a running Routine updates the recent-activity card in real time.
  useEffect(() => {
    return window.daymate.onActivityChanged((next) => setActivity(next))
  }, [setActivity])

  const morningBrief = (routines ?? []).find((r) => r.id === 'morning_brief')

  const runMorningBrief = async (): Promise<void> => {
    if (!morningBrief) return
    setRunning(true)
    try {
      await window.daymate.runRoutine(morningBrief.id)
    } finally {
      setRunning(false)
    }
  }

  const recent = activity ?? []
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">首页</h1>
          <p className="mt-1 text-sm text-white/45">用一份晨报开启新的一天。</p>
        </div>
        {morningBrief && (
          <button
            onClick={() => runMorningBrief()}
            disabled={running}
            className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--dm-accent)' }}
          >
            {running ? '正在生成晨报…' : '运行晨报'}
          </button>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-xs uppercase tracking-wide text-white/40">近期动态</div>
          {activityLoading ? (
            <div className="mt-3 text-sm text-white/35">加载中…</div>
          ) : activityError ? (
            <div className="mt-3 text-sm text-rose-300/80">无法加载动态。</div>
          ) : (
            <ol className="mt-3 space-y-2">
              {recent.slice(0, 6).map((e) => (
                <li key={e.id} className="text-sm text-white/75">
                  {e.summary}
                  <span className="ml-2 text-xs text-white/35">{new Date(e.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
              {recent.length === 0 && <li className="text-sm text-white/35">暂无内容。</li>}
            </ol>
          )}
        </div>

        <div className="rounded-lg border border-white/5 p-4 text-sm" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-xs uppercase tracking-wide text-white/40">IPC 健康检查</div>
          <div className="mt-3 grid grid-cols-[80px_1fr] gap-y-1 text-white/85">
            <span className="text-white/45">应用名</span>
            <span className="font-mono">{info?.name ?? '—'}</span>
            <span className="text-white/45">版本</span>
            <span className="font-mono">{info?.version ?? '—'}</span>
            <span className="text-white/45">Electron</span>
            <span className="font-mono">{info?.electron ?? '—'}</span>
            <span className="text-white/45">Node</span>
            <span className="font-mono">{info?.node ?? '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
