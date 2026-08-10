// Activity Service — the observable trace of Agent + Routine behavior (Spec §8).
// Every Routine step and tool call writes an Activity event. The renderer's
// Activity page reads this. Metadata is redacted before persistence so no
// token, authorization code or credential ever lands in the log (Spec §17.9).

import type { RoutineStore } from '../db/store'
import type { ActivityEvent, ActivityEventType } from '@shared/types'
import { newId, nowIso } from '../util/ids'

// Keys stripped (recursively) from any metadata before it is persisted.
const SENSITIVE_KEY_PATTERNS = [/token/i, /auth/i, /secret/i, /password/i, /code/i, /credential/i]

function redact(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(k))) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = redact(v)
      }
    }
    return out
  }
  return value
}

export interface RecordActivityInput {
  runId?: string
  type: ActivityEventType
  summary: string
  metadata?: Record<string, unknown>
}

export class ActivityService {
  private readonly listeners = new Set<(e: ActivityEvent) => void>()

  constructor(private readonly store: RoutineStore) {}

  record(input: RecordActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      id: newId('act'),
      runId: input.runId,
      type: input.type,
      summary: input.summary,
      metadata: redact(input.metadata ?? {}) as Record<string, unknown>,
      createdAt: nowIso()
    }
    this.store.createActivity(event)
    // Notify in-process subscribers (M4: the RobotStateController derives live
    // robot state from the latest activity event). Errors in a listener must
    // never break a routine run, so they are swallowed + logged.
    for (const cb of this.listeners) {
      try {
        cb(event)
      } catch (err) {
        console.error('[activity] subscriber threw:', err instanceof Error ? err.message : err)
      }
    }
    return event
  }

  /** Subscribe to every recorded event. Returns an unsubscribe function. */
  subscribe(cb: (e: ActivityEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  list(runId?: string): ActivityEvent[] {
    return this.store.listActivity(runId)
  }
}
