import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppInfo } from '@shared/types'

// Workbench shell. M0 ships only the scaffolded nav + a Home view that proves
// typed IPC end-to-end. Real pages land M1-M4.
const NAV = [
  'Home',
  'Assistant',
  'Need to Know',
  'Tasks',
  'Routines',
  'Approvals',
  'Activity',
  'Memory',
  'Integrations'
] as const

type NavName = (typeof NAV)[number]

export function Workbench(): ReactElement {
  const [active, setActive] = useState<NavName>('Home')
  const [ping, setPing] = useState<string>('…')
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.daymate.ping().then(setPing).catch(() => setPing('error'))
    void window.daymate.getAppInfo().then(setInfo).catch(() => setInfo(null))
  }, [])

  return (
    <div className="flex h-full w-full" style={{ background: 'var(--dm-bg)' }}>
      <aside className="flex w-56 shrink-0 flex-col border-r border-white/5" style={{ background: 'var(--dm-panel)' }}>
        <div className="px-5 py-5 text-sm font-semibold tracking-wide text-white/90">
          Daymate
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {NAV.map((name) => (
            <button
              key={name}
              onClick={() => setActive(name)}
              className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                active === name ? 'bg-white/10 text-white' : 'text-white/55 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="border-t border-white/5 px-4 py-3 text-xs text-white/40">
          {info ? `v${info.version}` : '—'}
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8">
        <h1 className="text-xl font-semibold text-white">{active}</h1>
        <p className="mt-1 text-sm text-white/45">
          Milestone 0 scaffold. This page is a placeholder; real content lands in later milestones.
        </p>

        <div className="mt-6 rounded-lg border border-white/5 p-4 text-sm" style={{ background: 'var(--dm-panel)' }}>
          <div className="text-white/55">IPC health check</div>
          <div className="mt-2 grid grid-cols-[120px_1fr] gap-y-1 text-white/85">
            <span className="text-white/45">ping()</span>
            <span className="font-mono">{ping}</span>
            <span className="text-white/45">app.name</span>
            <span className="font-mono">{info?.name ?? '—'}</span>
            <span className="text-white/45">electron</span>
            <span className="font-mono">{info?.electron ?? '—'}</span>
            <span className="text-white/45">node</span>
            <span className="font-mono">{info?.node ?? '—'}</span>
          </div>
        </div>
      </main>
    </div>
  )
}
