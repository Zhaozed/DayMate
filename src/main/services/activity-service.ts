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
    return event
  }

  list(runId?: string): ActivityEvent[] {
    return this.store.listActivity(runId)
  }
}
