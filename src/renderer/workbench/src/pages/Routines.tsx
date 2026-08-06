import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { RoutineDefinition, RoutineRun } from '@shared/types'

// Routines page (Spec §18). Lists preset/custom routines, shows trigger,
// next/last run, and a manual Run button.
export function RoutinesPage(): ReactElement {
  const [routines, setRoutines] = useState<RoutineDefinition[]>([])
  const [lastRuns, setLastRuns] = useState<Record<string, RoutineRun | undefined>>({})
  const [running, setRunning] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const list = await window.daymate.listRoutines()
    setRoutines(list)
    const runs: Record<string, RoutineRun | undefined> = {}
    for (const r of list) {
      const rlist = await window.daymate.listRoutineRuns(r.id)
      runs[r.id] = rlist[0]
    }
    setLastRuns(runs)
  }

  useEffect(() => {
    void refresh().catch(console.error)
  }, [])

  const run = async (id: string): Promise<void> => {
    setRunning(id)
    try {
      await window.daymate.runRoutine(id)
      await refresh()
    } catch (err) {
      console.error(err)
    } finally {
      setRunning(null)
    }
  }

  const toggle = async (r: RoutineDefinition): Promise<void> => {
    await window.daymate.setRoutineEnabled(r.id, !r.enabled)
    await refresh()
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-white">Routines</h1>
      <p className="mt-1 text-sm text-white/45">Configurable, schema-driven workflows.</p>

      <div className="mt-6 space-y-3">
        {routines.map((r) => {
          const last = lastRuns[r.id]
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
                    {last
                      ? `Last run: ${last.status} · ${new Date(last.startedAt).toLocaleString()}`
                      : 'Never run'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggle(r)}
                    className={`rounded px-2 py-1 text-xs ${r.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-white/50'}`}
                  >
                    {r.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    onClick={() => run(r.id)}
                    disabled={running === r.id}
                    className="rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--dm-accent)' }}
                  >
                    {running === r.id ? 'Running…' : 'Run'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
