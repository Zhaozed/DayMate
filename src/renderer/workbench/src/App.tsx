import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { WorkbenchPage } from '@shared/types'
import { HomePage } from './pages/Home'
import { TasksPage } from './pages/Tasks'
import { RoutinesPage } from './pages/Routines'
import { ActivityPage } from './pages/Activity'
import { ApprovalsPage } from './pages/Approvals'
import { NeedToKnowPage } from './pages/NeedToKnow'
import { IntegrationsPage } from './pages/Integrations'
import { MemoryPage } from './pages/Memory'
import { ApplicationsPage } from './pages/Applications'

// Workbench shell. Spec §4 IA. M2 wires Approvals, Need to Know and
// Integrations. Assistant and Memory remain placeholders (M4/M5). The robot
// deep-links here via onNavigate (M4 §18 — "Review" opens Approvals).
//
// The NAV values are the canonical IPC page identifiers (passed over the wire
// via openWorkbenchAt / onNavigate) — they stay English. PAGE_LABELS maps each
// identifier to its Chinese display label so the UI is zh-CN.
const NAV = [
  'Home',
  'Assistant',
  'Need to Know',
  'Tasks',
  'Applications',
  'Routines',
  'Approvals',
  'Activity',
  'Memory',
  'Integrations'
] as const

type NavName = (typeof NAV)[number]

const PAGE_LABELS: Record<NavName, string> = {
  Home: '首页',
  Assistant: '助手',
  'Need to Know': '必读',
  Tasks: '任务',
  Applications: '投递',
  Routines: '例程',
  Approvals: '审批',
  Activity: '动态',
  Memory: '记忆',
  Integrations: '集成'
}

export function Workbench(): ReactElement {
  const [active, setActive] = useState<NavName>('Home')

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
        {active === 'Tasks' && <TasksPage />}
        {active === 'Applications' && <ApplicationsPage />}
        {active === 'Routines' && <RoutinesPage />}
        {active === 'Approvals' && <ApprovalsPage />}
        {active === 'Activity' && <ActivityPage />}
        {active === 'Memory' && <MemoryPage />}
        {active === 'Integrations' && <IntegrationsPage />}
        {active === 'Assistant' && (
          <>
            <h1 className="text-xl font-semibold text-white">助手</h1>
            <p className="mt-1 text-sm text-white/45">
              完整的对话式助手（模型可调用工具 + 中止动作）推迟到后续里程碑实现。例程已覆盖无凭证的工作流。
            </p>
          </>
        )}
      </main>
    </div>
  )
}
