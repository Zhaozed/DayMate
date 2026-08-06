import { useState } from 'react'
import type { ReactElement } from 'react'
import { HomePage } from './pages/Home'
import { TasksPage } from './pages/Tasks'
import { RoutinesPage } from './pages/Routines'
import { ActivityPage } from './pages/Activity'

// Workbench shell. Spec §4 IA. Real pages land M1-M4; M1 wires Home, Tasks,
// Routines and Activity. The remaining nav entries are placeholders.
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
      </aside>

      <main className="flex-1 overflow-auto p-8">
        {active === 'Home' && <HomePage />}
        {active === 'Tasks' && <TasksPage />}
        {active === 'Routines' && <RoutinesPage />}
        {active === 'Activity' && <ActivityPage />}
        {active !== 'Home' && active !== 'Tasks' && active !== 'Routines' && active !== 'Activity' && (
          <>
            <h1 className="text-xl font-semibold text-white">{active}</h1>
            <p className="mt-1 text-sm text-white/45">
              This page is a placeholder; real content lands in a later milestone.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
