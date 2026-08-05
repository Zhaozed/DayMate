import { useEffect, useState, useCallback } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { RobotState } from '@shared/types'

// Ambient robot. Compact, transparent, draggable. Click → quick panel,
// double click → open workbench. Spec §4 / §18.
const STATE_LABEL: Record<RobotState, string> = {
  idle: 'idle',
  observing: 'observing',
  thinking: 'thinking',
  working: 'working',
  need_approval: 'need approval',
  done: 'done',
  error: 'error'
}

const STATE_COLOR: Record<RobotState, string> = {
  idle: '#5b8cff',
  observing: '#5b8cff',
  thinking: '#f5a623',
  working: '#7ed321',
  need_approval: '#ff5d5d',
  done: '#7ed321',
  error: '#ff5d5d'
}

export function Robot(): ReactElement {
  const [state, setState] = useState<RobotState>('idle')

  useEffect(() => {
    void window.daymate.getRobotState().then(setState)
    // Full push-subscription to main-side state changes lands in M1 when the
    // agent runtime owns the state. For M0, click cycles it explicitly.
  }, [])

  const openWorkbench = useCallback(() => {
    void window.daymate.openWindow('workbench')
  }, [])

  const cycleState = useCallback(async () => {
    const next = await window.daymate.setRobotState(state === 'idle' ? 'thinking' : 'idle')
    setState(next)
  }, [state])

  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      onDoubleClick={openWorkbench}
      onClick={cycleState}
      title={`Daymate — ${STATE_LABEL[state]} (double-click: workbench)`}
    >
      <div
        className="relative flex h-28 w-28 items-center justify-center rounded-full"
        style={{
          background: 'radial-gradient(circle at 30% 30%, #2a2f3a, #0f1115)',
          boxShadow: `0 0 24px 4px ${STATE_COLOR[state]}66`,
          border: '2px solid #2a2f3a'
        }}
      >
        <div
          className="h-16 w-16 rounded-full transition-all"
          style={{ background: STATE_COLOR[state], opacity: 0.9 }}
        />
      </div>
    </div>
  )
}
