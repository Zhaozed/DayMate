import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppInfo, ActivityEvent, RoutineDefinition } from '@shared/types'

// Home (Spec §18). Latest activity summary + a manual "Run Morning Brief"
// button. Keeps the M0 IPC health card.
export function HomePage(): ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [routines, setRoutines] = useState<RoutineDefinition[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void window.daymate.getAppInfo().then(setInfo).catch(() => setInfo(null))
    void window.daymate.listRoutines().then(setRoutines).catch(() => setRoutines([]))
    const refresh = (): void => {
      void window.daymate.listActivity().then(setActivity).catch(() => setActivity([]))
    }
    refresh()
    const off = window.daymate.onActivityChanged(() => refresh())
    return off
  }, [])

  const morningBrief = routines.find((r) => r.id === 'morning_brief')

  const runMorningBrief = async (): Promise<void> => {
    if (!morningBrief) return
    setRunning(true)
    try {
      await window.daymate.runRoutine(morningBrief.id)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Home</h1>
          <p className="mt-1 text-sm text-white/45">Start the day with a Morning Brief.</p>
        </div>
        {morningBrief && (
          <button
            onClick={() => runMorningBrief()}
            disabled={running}
            className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--dm-accent)' }}
          >
            {running ? 'Running Morning Brief…' : 'Run Morning Brief'}
          </button>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-xs uppercase tracking-wide text-white/40">Recent activity</div>
          <ol className="mt-3 space-y-2">
            {activity.slice(0, 6).map((e) => (
              <li key={e.id} className="text-sm text-white/75">
                {e.summary}
                <span className="ml-2 text-xs text-white/35">{new Date(e.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
            {activity.length === 0 && <li className="text-sm text-white/35">Nothing yet.</li>}
          </ol>
        </div>

        <div className="rounded-lg border border-white/5 p-4 text-sm" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-xs uppercase tracking-wide text-white/40">IPC health check</div>
          <div className="mt-3 grid grid-cols-[80px_1fr] gap-y-1 text-white/85">
            <span className="text-white/45">app.name</span>
            <span className="font-mono">{info?.name ?? '—'}</span>
            <span className="text-white/45">version</span>
            <span className="font-mono">{info?.version ?? '—'}</span>
            <span className="text-white/45">electron</span>
            <span className="font-mono">{info?.electron ?? '—'}</span>
            <span className="text-white/45">node</span>
            <span className="font-mono">{info?.node ?? '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
