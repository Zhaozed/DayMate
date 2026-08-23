import { describe, it, expect } from 'vitest'
import { RobotStateController } from '../../src/main/services/robot-state-service'
import type { ActivityEvent, RobotState } from '@shared/types'

// RobotStateController — the deterministic Activity→RobotState mapping that
// drives the ambient orb (Spec §18 "robot reflects real runtime state"). Pure
// (no Electron); a fake timer exercises the done→idle auto-reset and the
// stickiness of need_approval.

function fakeTimer() {
  let handle = 0
  const jobs = new Map<number, () => void>()
  return {
    setTimeout(h: () => void, _ms: number) {
      const id = ++handle
      jobs.set(id, h)
      return id
    },
    clearTimeout(id: unknown) {
      jobs.delete(id as number)
    },
    flush() {
      for (const h of [...jobs.values()]) h()
    },
    pending() {
      return jobs.size
    }
  }
}

function evt(type: ActivityEvent['type'], runId = 'run-1'): ActivityEvent {
  return {
    id: `${type}-1`,
    runId,
    type,
    summary: type,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function controller() {
  const emitted: RobotState[] = []
  const timer = fakeTimer()
  const ctrl = new RobotStateController({
    onChange: (s) => emitted.push(s),
    resetDelayMs: 6000,
    timer
  })
  return { ctrl, emitted, timer }
}

describe('RobotStateController', () => {
  it('maps routine_started → working, agent_started → thinking, agent_completed → working', () => {
    const { ctrl, emitted } = controller()
    ctrl.onEvent(evt('routine_started'))
    ctrl.onEvent(evt('agent_started'))
    ctrl.onEvent(evt('agent_completed'))
    expect(ctrl.getState()).toBe('working')
    expect(emitted).toEqual(['working', 'thinking', 'working'])
  })

  it('maps agent_failed / routine_failed → error', () => {
    const { ctrl } = controller()
    ctrl.onEvent(evt('agent_failed'))
    expect(ctrl.getState()).toBe('error')
    ctrl.onEvent(evt('routine_failed'))
    expect(ctrl.getState()).toBe('error')
  })

  it('error auto-resets to idle after the delay (a single classify_inbox failure must not pin the orb red forever)', () => {
    const { ctrl, timer } = controller()
    ctrl.onEvent(evt('agent_failed'))
    expect(ctrl.getState()).toBe('error')
    timer.flush()
    expect(ctrl.getState()).toBe('idle')
  })

  it('maps routine_completed → done and auto-resets to idle after the delay', () => {
    const { ctrl, timer } = controller()
    ctrl.onEvent(evt('routine_completed'))
    expect(ctrl.getState()).toBe('done')
    timer.flush()
    expect(ctrl.getState()).toBe('idle')
  })

  it('cancels the done→idle reset when a newer event arrives first', () => {
    const { ctrl, timer } = controller()
    ctrl.onEvent(evt('routine_completed')) // done, schedules reset
    ctrl.onEvent(evt('routine_started')) // working, cancels the reset
    expect(ctrl.getState()).toBe('working')
    timer.flush() // no pending reset to fire
    expect(ctrl.getState()).toBe('working')
  })

  it('need_approval is sticky — agent_completed after approval_requested does not clear it', () => {
    const { ctrl } = controller()
    ctrl.onEvent(evt('approval_requested'))
    expect(ctrl.getState()).toBe('need_approval')
    // An agent_completed event while waiting must NOT drop back to working.
    ctrl.onEvent(evt('agent_completed'))
    expect(ctrl.getState()).toBe('need_approval')
  })

  it('need_approval is only cleared by approval_resolved (working)', () => {
    const { ctrl } = controller()
    ctrl.onEvent(evt('approval_requested'))
    ctrl.onEvent(evt('approval_resolved'))
    expect(ctrl.getState()).toBe('working')
  })

  it('need_approval survives the done→idle reset (sticky, never auto-cleared)', () => {
    const { ctrl, timer } = controller()
    ctrl.onEvent(evt('approval_requested'))
    // done would schedule a reset, but we never reach done while stuck on
    // need_approval; flushing pending timers must not drop to idle.
    timer.flush()
    expect(ctrl.getState()).toBe('need_approval')
  })

  it('tool_* / provider_unavailable events do not change the visual state', () => {
    const { ctrl, emitted } = controller()
    ctrl.onEvent(evt('routine_started'))
    const before = emitted.length
    ctrl.onEvent(evt('tool_requested'))
    ctrl.onEvent(evt('tool_completed'))
    ctrl.onEvent(evt('provider_unavailable'))
    expect(ctrl.getState()).toBe('working')
    expect(emitted.length).toBe(before) // no onChange for these
  })
})
