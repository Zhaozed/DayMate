// Need to Know Service — surfaces important information the user should see
// without it necessarily becoming a Task (Spec §3, §8). Each item carries its
// source references (Spec §17.15: show source account/email references).

import type { RoutineStore } from '../db/store'
import type { BriefingCategory, NeedToKnow, SourceRef, SuggestedAction } from '@shared/types'
import { newId, nowIso } from '../util/ids'

export interface CreateNeedToKnowInput {
  title: string
  summary: string
  reason: string
  priority?: 'medium' | 'high' | 'urgent'
  sourceRefs?: SourceRef[]
  suggestedActions?: SuggestedAction[]
  routineRunId?: string
  /** 'morning_brief' → Home 晨报 carousel; null/omitted → 必读 page. ADR 0026. */
  kind?: 'morning_brief' | 'email' | null
  /** ADR 0029 — thread key (Gmail threadId / 163 synthesized). */
  threadId?: string
  /** ADR 0029 — 必读 top-level section tag (学校/求职/日常/其他). */
  briefingCategory?: BriefingCategory
  /** ADR 0029 — email source provider + deep link + account id. */
  sourceProvider?: 'gmail' | 'mail163'
  sourceAccountId?: string
  sourceLink?: string
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
      kind: input.kind ?? null,
      threadId: input.threadId,
      briefingCategory: input.briefingCategory,
      sourceProvider: input.sourceProvider,
      sourceAccountId: input.sourceAccountId,
      sourceLink: input.sourceLink,
      updatedAt: nowIso(),
      createdAt: nowIso()
    }
    this.store.createNeedToKnow(item)
    return item
  }

  list(): NeedToKnow[] {
    return this.store.listNeedToKnow()
  }

  /** Last `days` morning-brief NTKs for the Home 晨报 carousel. ADR 0026. */
  listMorningBriefs(days = 7): NeedToKnow[] {
    return this.store.listMorningBriefs(days)
  }

  /** Every NTK including dismissed ones. ADR 0028 purge — scans the full table
   *  so mock-calendar "Q3 roadmap" briefs a user dismissed before real providers
   *  connected (invisible to `list()`/`listMorningBriefs()`) can be cleared. */
  listAll(): NeedToKnow[] {
    return this.store.listAllNeedToKnow()
  }

  dismiss(id: string): void {
    // Idempotent: marking an already-dismissed item dismissed is a no-op.
    this.store.dismissNeedToKnow(id)
  }

  /** Delete every active NTK item. Used by the 必读 "清空全部" reset. */
  clearAll(): void {
    this.store.deleteAllNeedToKnow()
  }

  /** Delete active NTK items whose title matches exactly. One-time boot
   * migration: clears stale "收件箱已分类" noise after auto_inbox dropped its
   * publish step. */
  deleteByTitle(title: string): void {
    this.store.deleteNeedToKnowByTitle(title)
  }

  /** Hard-delete a single NTK item by id (ADR 0027 purge — clears stale
   *  email-origin 必读 so the re-backfill rebuilds a clean set). */
  deleteById(id: string): void {
    this.store.deleteNeedToKnowById(id)
  }

  /** Patch a persisted NTK (ADR 0029 thread-merge: append a new email's
   *  sourceRef, bump headline to latest, touch updatedAt). */
  update(id: string, patch: Partial<NeedToKnow>): void {
    this.store.updateNeedToKnow(id, patch)
  }
}
