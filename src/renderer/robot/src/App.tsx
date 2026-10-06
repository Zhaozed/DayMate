import { useEffect, useState, useRef, useCallback } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { RobotState, RobotView, RobotNotify, NeedToKnow, ApprovalRequest } from '@shared/types'
import { Bubble } from './Bubble'
import { QuickPanel } from './QuickPanel'

// Ambient robot (Spec §4 / §18). Reflects live runtime state (pushed from main
// via onRobotStateChanged), surfaces proactive bubbles (onRobotNotify), and on
// click opens a quick panel. Double-click opens the workbench. The window
// resizes between orb / bubble / panel views; main owns the geometry and the
// renderer asks it to switch via setRobotView.

const STATE_COLOR: Record<RobotState, string> = {
  idle: '#3a3f4a',
  observing: '#ff8a3b',
  thinking: '#ffb020',
  working: '#7ed321',
  need_approval: '#ff3b3b',
  done: '#3bd671',
  error: '#ff3b3b'
}

const BUBBLE_MS = 5000

export function Robot(): ReactElement {
  const [state, setState] = useState<RobotState>('idle')
  const [view, setView] = useState<RobotView>('orb')
  const [notify, setNotify] = useState<RobotNotify | null>(null)
  const [latestNtk, setLatestNtk] = useState<NeedToKnow | null>(null)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])

  // Timers: bubble auto-dismiss + the single-vs-double click discriminator.
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Reflect view changes into the main-side window geometry.
  useEffect(() => {
    void window.daymate.setRobotView(view)
  }, [view])

  // Initial fetch + push subscriptions.
  useEffect(() => {
    void window.daymate.getRobotState().then(setState)
    void window.daymate.listNeedToKnow().then((items) => setLatestNtk(items[0] ?? null))
    void window.daymate.listApprovals().then(setApprovals)

    const offState = window.daymate.onRobotStateChanged(setState)
    const offNotify = window.daymate.onRobotNotify((msg) => {
      setNotify(msg)
      // A notify while the panel is open stays as an in-panel banner (don't
      // shrink the panel). Otherwise show the transient bubble.
      setView((cur) => (cur === 'panel' ? cur : 'bubble'))
      clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => {
        setNotify(null)
        setView('orb')
      }, BUBBLE_MS)
    })
    // Activity changes imply new NTK / approvals may exist — refresh panel data.
    const offActivity = window.daymate.onActivityChanged(() => {
      void window.daymate.listNeedToKnow().then((items) => setLatestNtk(items[0] ?? null))
      void window.daymate.listApprovals().then(setApprovals)
    })
    const offApprovals = window.daymate.onApprovalChanged(setApprovals)
    return () => {
      offState()
      offNotify()
      offActivity()
      offApprovals()
      clearTimeout(bubbleTimer.current)
      clearTimeout(clickTimer.current)
    }
  }, [])

  const pendingApprovalCount = approvals.filter((a) => a.status === 'pending').length

  const dismissBubble = useCallback(() => {
    clearTimeout(bubbleTimer.current)
    setNotify(null)
    setView('orb')
  }, [])

  const reviewNotify = useCallback(() => {
    const target = notify?.navigateTo ?? 'Approvals'
    void window.daymate.openWorkbenchAt(target)
    dismissBubble()
  }, [notify, dismissBubble])

  // Single click toggles the panel; but wait briefly so a double-click (open
  // workbench) can cancel it. The orb region is draggable (WebkitAppRegion
  // drag); a clean click still fires onClick.
  const onClick = useCallback(() => {
    clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      setView((cur) => (cur === 'panel' ? 'orb' : 'panel'))
    }, 220)
  }, [])

  const onDoubleClick = useCallback(() => {
    clearTimeout(clickTimer.current)
    setView('orb')
    void window.daymate.openWindow('workbench')
  }, [])

  const openWorkbenchFromPanel = useCallback(() => {
    setView('orb')
    void window.daymate.openWindow('workbench')
  }, [])

  const closePanel = useCallback(() => setView('orb'), [])

  return (
    <div
      className="flex h-full w-full items-end justify-end"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
      title="Daymate — 单击：面板，双击：工作台，拖拽：移动"
    >
      {view === 'orb' && <Orb state={state} />}
      {view === 'bubble' && (
        <div className="mb-3 mr-3 w-[calc(100%-1.5rem)]">
          <Bubble
            message={notify?.message ?? ''}
            reviewLabel={notify?.approvalId || notify?.navigateTo ? '去审批' : undefined}
            onReview={reviewNotify}
            onDismiss={dismissBubble}
          />
        </div>
      )}
      {view === 'panel' && (
        <div
          className="mr-3 mb-3 h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)]"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <QuickPanel
            state={state}
            latestNtk={latestNtk}
            pendingApprovalCount={pendingApprovalCount}
            onReview={() => {
              setView('orb')
              void window.daymate.openWorkbenchAt('Approvals')
            }}
            onOpenWorkbench={openWorkbenchFromPanel}
            onClose={closePanel}
          />
        </div>
      )}
    </div>
  )
}

function Orb({ state }: { state: RobotState }): ReactElement {
  return (
    <div className="mr-3 mb-3 flex h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] items-center justify-center">
      <div
        className="relative flex items-center justify-center rounded-full"
        style={{
          width: 144,
          height: 144,
          background: '#1a1d24',
          boxShadow: `0 6px 20px 2px ${STATE_COLOR[state]}aa, 0 0 0 2px #00000033`,
          border: `3px solid ${STATE_COLOR[state]}`
        }}
      >
        <div
          className="h-16 w-16 rounded-full"
          style={{ background: STATE_COLOR[state] }}
        />
      </div>
    </div>
  )
}
