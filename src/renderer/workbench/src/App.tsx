import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { WorkbenchPage } from '@shared/types'
import { HomePage } from './pages/Home'
import { RoutinesPage } from './pages/Routines'
import { ApprovalsPage } from './pages/Approvals'
import { NeedToKnowPage } from './pages/NeedToKnow'
import { IntegrationsPage } from './pages/Integrations'
import { MemoryPage } from './pages/Memory'
import { ApplicationsPage } from './pages/Applications'

// Workbench shell. Spec §4 IA. The nav was trimmed from 11 → 6: Assistant
// (empty placeholder), Tasks, Approvals, Activity, and InterviewNotes were
// removed at the user's request — the funnel is now email-driven (BOSS
// retired, ADR 0019), approvals never trigger (no R3 external-write routine
// is active), the Activity log is backend noise the user doesn't want to see,
// and 面经库 is unused. Tasks/Activity/InterviewNotes page files stay on disk
// as dormant exports (BOSS-retirement pattern); Approvals keeps its mount
// below as a dormant safety net — §15 approval gate stays in the backend, and
// `approval-from-robot` e2e still deep-links here.
//
// The NAV values are the canonical IPC page identifiers (passed over the wire
// via openWorkbenchAt / onNavigate) — they stay English. PAGE_LABELS maps each
// identifier to its Chinese display label so the UI is zh-CN.
const NAV = [
  'Home',
  'Need to Know',
  'Applications',
  'Routines',
  'Memory',
  'Integrations'
] as const

type NavName = (typeof NAV)[number]

const PAGE_LABELS: Record<NavName, string> = {
  Home: '首页',
  'Need to Know': '必读',
  Applications: '投递',
  Routines: '例程',
  Memory: '记忆',
  Integrations: '集成与设置'
}

export function Workbench(): ReactElement {
  // `active` is a WorkbenchPage (not the narrower NavName) so the dormant
  // Approvals mount — reachable only via the robot approval deep-link, not the
  // sidebar — can hold a value outside NAV.
  const [active, setActive] = useState<WorkbenchPage>('Home')

  // Robot deep-link: main tells the workbench which page to show (e.g. when the
  // user taps "Review" on an approval bubble → openWorkbenchAt('Approvals')).
  useEffect(() => {
    return window.daymate.onNavigate((page: WorkbenchPage) => setActive(page))
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
              {PAGE_LABELS[name]}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-auto p-8">
        {active === 'Home' && <HomePage />}
        {active === 'Need to Know' && <NeedToKnowPage />}
        {active === 'Applications' && <ApplicationsPage />}
        {active === 'Routines' && <RoutinesPage />}
        {active === 'Memory' && <MemoryPage />}
        {active === 'Integrations' && <IntegrationsPage />}
        {/* Dormant: reachable only via the robot approval deep-link
         * (openWorkbenchAt('Approvals')). No nav button — §15 gate stays in
         * the backend; nothing triggers it while no R3 routine is active. */}
        {active === 'Approvals' && <ApprovalsPage />}
      </main>
    </div>
  )
}
