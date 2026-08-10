// RobotStateController (Spec §18: "robot reflects real runtime state"). It
// subscribes to Activity events and derives the ambient robot's state from
// the latest event — the robot never claims a state it did not observe.
//
// This is a deterministic mapping of Activity event → RobotState; the agent's
// reasoning stays separate (Spec §12). The controller owns only the visual
// state. It is framework-agnostic: it takes an `onChange` callback (the
// container wires the real `setRobotState` that pushes to the robot window;
// tests pass a spy).
//
// `done` auto-resets to `idle` after `resetDelayMs` (so the orb doesn't stay
// green forever). Any newer event cancels the reset. `need_approval` is sticky
// — it is only cleared by an `approval_resolved` event (approve or reject),
// never by the idle timer.

import type { ActivityEvent, RobotState } from '@shared/types'

export interface RobotStateControllerDeps {
  /** Called whenever the derived state changes. */
  onChange: (state: RobotState) => void
  /** Delay before `done` → `idle` (ms). Default 6000. */
  resetDelayMs?: number
  /** Injected so tests can use fake timers; defaults to the global setTimeout/clearTimeout. */
  timer?: {
    setTimeout: (handler: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const DEFAULT_RESET_DELAY = 6000

export class RobotStateController {
  private state: RobotState = 'idle'
  private resetHandle: unknown | undefined
  private readonly resetDelayMs: number
  private readonly timer: NonNullable<RobotStateControllerDeps['timer']>
  private readonly onChange: (state: RobotState) => void

  constructor(deps: RobotStateControllerDeps) {
    this.onChange = deps.onChange
    this.resetDelayMs = deps.resetDelayMs ?? DEFAULT_RESET_DELAY
    this.timer = deps.timer ?? {
      setTimeout: (h, ms) => setTimeout(h, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    }
  }

  getState(): RobotState {
    return this.state
  }

  /** Activity-event subscriber. Maps the event to a state and emits on change. */
  onEvent(e: ActivityEvent): void {
    const next = this.derive(e)
    if (next === undefined) return
    this.setState(next)
  }

  private derive(e: ActivityEvent): RobotState | undefined {
    switch (e.type) {
      case 'routine_started':
        return 'working'
      case 'agent_started':
        return 'thinking'
      case 'agent_completed':
        // After thinking, the run is still working through later steps.
        return this.state === 'need_approval' ? undefined : 'working'
      case 'agent_failed':
      case 'routine_failed':
        return 'error'
      case 'approval_requested':
        return 'need_approval'
      case 'approval_resolved':
        // Approved → resuming (working); rejected → the run ends, but treat
        // as working until the routine_completed/failed event lands.
        return 'working'
      case 'routine_completed':
        return 'done'
      // tool_* / provider_unavailable / approval_requested (handled above)
      // don't change the visual state on their own.
      default:
        return undefined
    }
  }

  private setState(next: RobotState): void {
    // Cancel any pending done→idle reset: a newer event supersedes it.
    this.clearReset()
    this.state = next
    this.onChange(next)
    if (next === 'done') {
      // Schedule the idle reset. `need_approval` is sticky and never set here.
      this.resetHandle = this.timer.setTimeout(() => {
        this.resetHandle = undefined
        if (this.state === 'done') this.setState('idle')
      }, this.resetDelayMs)
    }
  }

  private clearReset(): void {
    if (this.resetHandle !== undefined) {
      this.timer.clearTimeout(this.resetHandle)
      this.resetHandle = undefined
    }
  }
}
