import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { WorkbenchPage } from '@shared/types'
import { HomePage } from './pages/Home'
import { TasksPage } from './pages/Tasks'
import { ApprovalsPage } from './pages/Approvals'
import { IntegrationsPage } from './pages/Integrations'
import { ApplicationsPage } from './pages/Applications'

// Workbench shell. Nav focused strictly on the 4 core views:
// 首页 (Home - 邮件智能聚合), 待办 (Tasks - 我的ToDo), 投递 (Applications - 求职追踪), 集成与设置 (Integrations).
const NAV = [
  'Home',
  'Tasks',
  'Applications',
  'Integrations'
] as const

type NavName = (typeof NAV)[number]

const PAGE_LABELS: Record<NavName, string> = {
  Home: '首页',
  Tasks: '待办',
  Applications: '投递',
  Integrations: '集成与设置'
}

const PAGE_ICONS: Record<NavName, (active: boolean) => ReactElement> = {
  Home: (active) => (
    <svg className={`h-4 w-4 transition-colors ${active ? 'text-sky-400' : 'text-white/45'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  ),
  Tasks: (active) => (
    <svg className={`h-4 w-4 transition-colors ${active ? 'text-sky-400' : 'text-white/45'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  Applications: (active) => (
    <svg className={`h-4 w-4 transition-colors ${active ? 'text-sky-400' : 'text-white/45'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ),
  Integrations: (active) => (
    <svg className={`h-4 w-4 transition-colors ${active ? 'text-sky-400' : 'text-white/45'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

export function Workbench(): ReactElement {
  const [active, setActive] = useState<WorkbenchPage>('Home')

  useEffect(() => {
    return window.daymate.onNavigate((page: WorkbenchPage) => setActive(page))
  }, [])

  return (
    <div className="flex h-full w-full" style={{ background: 'var(--dm-bg)' }}>
      <aside
        className="flex w-60 shrink-0 flex-col border-r border-white/[0.06] select-none"
        style={{ background: 'var(--dm-panel)' }}
      >
        {/* macOS traffic light spacer / window drag region */}
        <div
          className="h-10 w-full shrink-0"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />

        {/* Brand header */}
        <div className="flex items-center justify-between px-5 pb-4.5 pt-1 border-b border-white/[0.05]">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-500 shadow-sm shadow-sky-500/20">
              <span className="text-xs font-bold text-white tracking-wider">D</span>
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white/95">Daymate</div>
              <div className="text-[10px] text-white/40 tracking-wider">AI WORK AGENT</div>
            </div>
          </div>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-mono text-sky-400">
            PRO
          </span>
        </div>

        {/* Navigation list */}
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((name) => {
            const isSelected = active === name || (name === 'Tasks' && active === 'Need to Know')
            return (
              <button
                key={name}
                onClick={() => setActive(name)}
                className={`group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-all ${
                  isSelected
                    ? 'bg-white/[0.08] text-white shadow-sm shadow-black/20 border border-white/[0.08]'
                    : 'text-white/60 hover:bg-white/[0.04] hover:text-white/90 border border-transparent'
                }`}
              >
                {PAGE_ICONS[name](isSelected)}
                <span className="flex-1 tracking-tight">{PAGE_LABELS[name]}</span>
                {isSelected && (
                  <div className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                )}
              </button>
            )
          })}
        </nav>

        {/* Footer info */}
        <div className="p-3 border-t border-white/[0.05]">
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] p-2.5 text-xs">
            <div className="flex items-center gap-2 text-white/70">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-[11px] font-medium text-white/75">增量同步运行中</span>
            </div>
            <div className="mt-1 text-[10px] text-white/35">
              双邮箱 (Gmail & 163) · 自动归并就绪
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8 pt-9" style={{ background: 'var(--dm-bg)' }}>
        {active === 'Home' && <HomePage />}
        {(active === 'Tasks' || active === 'Need to Know') && <TasksPage />}
        {active === 'Applications' && <ApplicationsPage />}
        {active === 'Integrations' && <IntegrationsPage />}
        {/* Dormant: reachable only via the robot approval deep-link */}
        {active === 'Approvals' && <ApprovalsPage />}
      </main>
    </div>
  )
}
