import { useEffect } from 'react'
import type { ReactElement } from 'react'
import type { ActivityEvent } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'

// Activity timeline (Spec §18). Lists every Routine step and tool call,
// grouped by run. Subscribes to live push so a running Routine updates the
// page in real time. (M1 exit criterion: "Activity page shows every step".)
export function ActivityPage(): ReactElement {
  const { data: events, loading, error, setData, refetch } = useAsync<ActivityEvent[]>(
    () => window.daymate.listActivity()
  )

  // Live push: main sends the full event list whenever it changes.
  useEffect(() => {
    return window.daymate.onActivityChanged((next) => setData(next))
  }, [setData])

  if (loading) return <Loading label="正在加载动态…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = events ?? []
  if (list.length === 0) {
    return (
      <div>
        <Header />
        <EmptyState title="暂无活动" hint="运行一个例程即可在此查看步骤。" />
      </div>
    )
  }

  const byRun = new Map<string, ActivityEvent[]>()
  for (const e of list) {
    const key = e.runId ?? 'system'
    const arr = byRun.get(key) ?? []
    arr.push(e)
    byRun.set(key, arr)
  }

  return (
    <div>
      <Header />
      <div className="mt-6 space-y-6">
        {[...byRun.entries()].map(([runId, evs]) => (
          <div key={runId} className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
            <div className="mb-3 text-xs font-mono text-white/40">{runId}</div>
            <ol className="space-y-2">
              {[...evs].reverse().map((e) => (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 w-2.5 shrink-0 rounded-full" style={{ background: dotColor(e.type) }} />
                  <div className="flex-1">
                    <div className="text-white/85">{e.summary}</div>
                    <div className="text-xs text-white/35">
                      {e.type} · {new Date(e.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">动态</h1>
      <p className="mt-1 text-sm text-white/45">每个例程步骤与工具调用，最新优先。</p>
    </div>
  )
}

function dotColor(type: ActivityEvent['type']): string {
  if (type.startsWith('failed')) return '#ef4444'
  if (type.startsWith('approval')) return '#f59e0b'
  if (type === 'routine_completed') return '#22c55e'
  if (type === 'routine_started') return '#5b8cff'
  return '#6b7280'
}
