// Need to Know Service — surfaces important information the user should see
// without it necessarily becoming a Task (Spec §3, §8). Each item carries its
// source references (Spec §17.15: show source account/email references).

import type { RoutineStore } from '../db/store'
import type { NeedToKnow, SourceRef, SuggestedAction } from '@shared/types'
import { newId, nowIso } from '../util/ids'

export interface CreateNeedToKnowInput {
  title: string
  summary: string
  reason: string
  priority?: 'medium' | 'high' | 'urgent'
  sourceRefs?: SourceRef[]
  suggestedActions?: SuggestedAction[]
  routineRunId?: string
}

export class NeedToKnowService {
  constructor(private readonly store: RoutineStore) {}

  create(input: CreateNeedToKnowInput): NeedToKnow {
    const item: NeedToKnow = {
      id: newId('ntk'),
      title: input.title,
      summary: input.summary,
      reason: input.reason,
      priority: input.priority ?? 'medium',
      sourceRefs: input.sourceRefs ?? [],
      suggestedActions: input.suggestedActions ?? [],
      createdAt: nowIso()
    }
    this.store.createNeedToKnow(item)
    return item
  }

  list(): NeedToKnow[] {
    return this.store.listNeedToKnow()
  }

  dismiss(id: string): void {
    // Idempotent: marking an already-dismissed item dismissed is a no-op.
    this.store.dismissNeedToKnow(id)
  }
}
