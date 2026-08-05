import { describe, it, expect } from 'vitest'
import { robotStateSchema } from '@shared/schemas'

describe('robot state schema', () => {
  it('accepts all defined robot states', () => {
    const states = ['idle', 'observing', 'thinking', 'working', 'need_approval', 'done', 'error']
    for (const s of states) {
      expect(robotStateSchema.parse(s)).toBe(s)
    }
  })

  it('rejects unknown states', () => {
    expect(() => robotStateSchema.parse('sleeping')).toThrow()
  })
})
