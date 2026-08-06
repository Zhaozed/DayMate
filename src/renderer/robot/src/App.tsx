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
  idle: '#ff3b3b',
  observing: '#ff8a3b',
  thinking: '#ffb020',
  working: '#7ed321',
  need_approval: '#ff3b3b',
  done: '#3bd671',
  error: '#ff3b3b'
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
          background: '#1a1d24',
          boxShadow: `0 6px 20px 2px ${STATE_COLOR[state]}aa, 0 0 0 2px #00000033`,
          border: `3px solid ${STATE_COLOR[state]}`
        }}
      >
        <div
          className="h-14 w-14 rounded-full transition-all"
          style={{ background: STATE_COLOR[state], opacity: 1 }}
        />
      </div>
    </div>
  )
}
