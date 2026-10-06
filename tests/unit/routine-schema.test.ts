import { describe, it, expect } from 'vitest'
import { routineTemplateSchema, routineDefinitionSchema } from '@shared/schemas'
import { interviewPrepTemplate } from '../../src/main/routines/templates/interview-prep'
import { nowIso } from '../../src/main/util/ids'

describe('routine schema', () => {
  it('accepts the Interview Prep template', () => {
    const parsed = routineTemplateSchema.parse(interviewPrepTemplate)
    expect(parsed.id).toBe('interview_prep')
    expect(parsed.steps.length).toBeGreaterThan(0)
  })

  it('accepts every seeded preset (a malformed preset must fail loudly)', () => {
    for (const template of [interviewPrepTemplate]) {
      expect(() => routineTemplateSchema.parse(template)).not.toThrow()
    }
  })

  it('accepts a full RoutineDefinition with timestamps', () => {
    const def = { ...interviewPrepTemplate, createdAt: nowIso(), updatedAt: nowIso() }
    expect(routineDefinitionSchema.parse(def).id).toBe('interview_prep')
  })

  it('rejects a malformed step (missing required field)', () => {
    const bad = {
      ...interviewPrepTemplate,
      steps: [{ id: 'bad', type: 'tool' }] // missing tool name
    }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })

  it('rejects an unknown trigger type', () => {
    const bad = { ...interviewPrepTemplate, trigger: { type: 'webhook' } }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })

  it('rejects an unknown step type', () => {
    const bad = {
      ...interviewPrepTemplate,
      steps: [{ id: 'x', type: 'magic', tool: 'email.list' }]
    }
    expect(() => routineTemplateSchema.parse(bad)).toThrow()
  })
})
