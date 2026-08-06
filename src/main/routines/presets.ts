// Preset Routine loader. Seeds the built-in Routine templates into the store
// if they are not already present (idempotent — safe on every launch). A real
// user-edited Routine with the same id is preserved (upsert only on absence).

import type { RoutineStore } from '../db/store'
import type { RoutineDefinition } from '@shared/types'
import { routineTemplateSchema } from '@shared/schemas'
import { morningBriefTemplate } from './templates/morning-brief'
import { nowIso } from '../util/ids'

const PRESETS = [morningBriefTemplate]

/** Seed presets; return all routines after seeding. */
export function seedPresets(store: RoutineStore): RoutineDefinition[] {
  const now = nowIso()
  for (const template of PRESETS) {
    // Validate the template against the Routine Schema before seeding — a
    // malformed preset fails loudly (Spec §12, rule 5: typed schemas).
    const parsed = routineTemplateSchema.parse(template)
    const existing = store.getRoutine(parsed.id)
    if (existing) continue // never clobber a (possibly user-edited) routine
    store.saveRoutine({
      ...parsed,
      createdAt: now,
      updatedAt: now
    })
  }
  return store.listRoutines()
}
