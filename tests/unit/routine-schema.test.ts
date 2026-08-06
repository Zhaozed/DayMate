import { describe, it, expect } from 'vitest'
import { routineTemplateSchema, routineDefinitionSchema } from '@shared/schemas'
import { morningBriefTemplate } from '../../src/main/routines/templates/morning-brief'
import { nowIso } from '../../src/main/util/ids'

describe('routine schema', () => {
  it('accepts the Morning Brief template', () => {
    const parsed = routineTemplateSchema.parse(morningBriefTemplate)
    expect(parsed.id).toBe('morning_brief')
    expect(parsed.steps.length).toBe(7)
  })

  it('accepts a full RoutineDefinition with timestamps', () => {
    const def = { ...morningBriefTemplate, createdAt: nowIso(), updatedAt: nowIso() }
    expect(routineDefinitionSchema.parse(def).id).toBe('morning_brief')
  })

  it('rejects a malformed step (missing required field)', () => {
    const bad = {
      ...morningBriefTemplate,
      steps: [{ id: 'bad', type: 'tool' }] // missing tool name
    }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })

  it('rejects an unknown trigger type', () => {
    const bad = { ...morningBriefTemplate, trigger: { type: 'webhook' } }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })

  it('rejects an unknown step type', () => {
    const bad = {
      ...morningBriefTemplate,
      steps: [{ id: 'x', type: 'magic', tool: 'email.list' }]
    }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })
})
