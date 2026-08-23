// Preset Routine loader. Seeds the built-in Routine templates into the store
// if they are not already present (idempotent — safe on every launch). A real
// user-edited Routine with the same id is preserved (upsert only on absence).

import type { RoutineStore } from '../db/store'
import type { RoutineDefinition } from '@shared/types'
import { routineTemplateSchema } from '@shared/schemas'
import { morningBriefTemplate } from './templates/morning-brief'
import { interviewPrepTemplate } from './templates/interview-prep'
import { nowIso } from '../util/ids'

const PRESETS = [morningBriefTemplate, interviewPrepTemplate]

/** IDs of built-in preset routines — they cannot be deleted (M5 §14). Mirrors
 *  `PRESET_ROUTINE_IDS` in shared/constants so the renderer can hide Delete. */
export const PRESET_IDS: readonly string[] = PRESETS.map((p) => p.id)

/** Preset ids that have been retired from the product. Their seeded DB rows
 *  would otherwise keep being scheduled after the template is removed from
 *  PRESETS, so seedPresets deletes them on every boot (directly via the store,
 *  bypassing engine-level preset protection, which only covers current
 *  PRESET_IDS — the same store-direct delete pattern ADR 0020 used for
 *  `deleteByTitle`). Safe to re-run; deleting a missing id is a no-op. */
const RETIRED_PRESET_IDS = [
  'draft_review',
  'meeting_prep',
  'daily_work_summary',
  'job_recommendation',
  // auto_inbox was retired (ADR 0024): its 30-min full-inbox classify_inbox
  // pass duplicated the container's real-time email sync loop (ADR 0022/0023),
  // burning LLM tokens for output that landed on the dormant Tasks page. The
  // sync loop now owns mail-driven 必读 + 投递 funnel; this row is purged on
  // boot so its stale schedule stops firing.
  'auto_inbox'
]

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
  // Purge retired presets so their stale seeded rows don't keep being
  // scheduled after the template left PRESETS.
  for (const id of RETIRED_PRESET_IDS) {
    if (store.getRoutine(id)) store.deleteRoutine(id)
  }
  return store.listRoutines()
}
