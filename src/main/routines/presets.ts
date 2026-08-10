// Preset Routine loader. Seeds the built-in Routine templates into the store
// if they are not already present (idempotent — safe on every launch). A real
// user-edited Routine with the same id is preserved (upsert only on absence).

import type { RoutineStore } from '../db/store'
import type { RoutineDefinition } from '@shared/types'
import { routineTemplateSchema } from '@shared/schemas'
import { morningBriefTemplate } from './templates/morning-brief'
import { autoInboxTemplate } from './templates/auto-inbox'
import { draftReviewTemplate } from './templates/draft-review'
import { meetingPrepTemplate } from './templates/meeting-prep'
import { dailyWorkSummaryTemplate } from './templates/daily-work-summary'
import { nowIso } from '../util/ids'

const PRESETS = [
  morningBriefTemplate,
  autoInboxTemplate,
  draftReviewTemplate,
  meetingPrepTemplate,
  dailyWorkSummaryTemplate
]

/** IDs of built-in preset routines — they cannot be deleted (M5 §14). Mirrors
 *  `PRESET_ROUTINE_IDS` in shared/constants so the renderer can hide Delete. */
export const PRESET_IDS: readonly string[] = PRESETS.map((p) => p.id)

/** Seed presets; return all routines after seeding. */
export function seedPresets(store: RoutineStore): RoutineDefinition[] {
  const now = nowIso()
  for (const template of PRESETS) {
    // Validate the template against the Routine Schema before seeding — a
    // malformed preset fails loudly (Spec §12, rule 5: typed schemas).
    const parsed = routineTemplateSchema.parse(template)
    const existing = store.getRoutine(parsed.id)
    if (!existing) {
      // First launch: seed the preset fresh.
      store.saveRoutine({ ...parsed, createdAt: now, updatedAt: now })
      continue
    }
    // Re-sync the canonical preset definition (steps, inputs, name,
    // description, version, approvalPolicy, output) on each boot so template
    // fixes propagate to already-seeded rows. Presets are not user-editable in
    // the builder (§14), so overwriting their step graph is safe; we preserve
    // only the user-mutable config (enabled, trigger) and createdAt.
    store.saveRoutine({
      ...parsed,
      enabled: existing.enabled,
      trigger: existing.trigger,
      createdAt: existing.createdAt,
      updatedAt: now
    })
  }
  return store.listRoutines()
}
