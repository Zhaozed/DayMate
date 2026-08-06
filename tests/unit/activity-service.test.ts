import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'

describe('activity service', () => {
  it('records and lists events newest-first', () => {
    const store = new InMemoryStore()
    const svc = new ActivityService(store)
    svc.record({ type: 'routine_started', summary: 'a' })
    svc.record({ runId: 'r1', type: 'tool_completed', summary: 'b' })
    const list = svc.list()
    expect(list.length).toBe(2)
    // newest first
    expect(list[0].summary).toBe('b')
  })

  it('filters by runId', () => {
    const store = new InMemoryStore()
    const svc = new ActivityService(store)
    svc.record({ runId: 'r1', type: 'tool_completed', summary: 'x' })
    svc.record({ runId: 'r2', type: 'tool_completed', summary: 'y' })
    expect(svc.list('r1').length).toBe(1)
    expect(svc.list('r1')[0].summary).toBe('x')
  })

  it('redacts sensitive keys from metadata', () => {
    const store = new InMemoryStore()
    const svc = new ActivityService(store)
    svc.record({
      type: 'tool_completed',
      summary: 'sensitive',
      metadata: { token: 'abc', refreshToken: 'xyz', safe: 'ok' }
    })
    const ev = svc.list()[0]
    expect(ev.metadata.token).toBe('[REDACTED]')
    expect(ev.metadata.refreshToken).toBe('[REDACTED]')
    expect(ev.metadata.safe).toBe('ok')
  })
})
