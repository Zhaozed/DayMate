import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import type { Application, ApplicationEvent } from '@shared/types'

// stats() aggregate (Milestone B). DESCRIPTIVE only — no productivity framing.
// These pin the counts / conversion / stale / urgent / avg computation against a
// hand-built funnel so a regression in the reducer surfaces immediately.

function iso(s: string): string {
  return new Date(s).toISOString()
}

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    company: '腾讯',
    position: '后端',
    source: 'web',
    appliedAt: iso('2026-08-01T10:00:00Z'),
    createdAt: iso('2026-08-01T10:00:00Z'),
    updatedAt: iso('2026-08-01T10:00:00Z'),
    ...overrides
  }
}

function makeEvent(appId: string, overrides: Partial<ApplicationEvent> = {}): ApplicationEvent {
  return {
    id: 'ev-1',
    applicationId: appId,
    type: 'interview',
    source: 'manual',
    locked: true,
    eventAt: iso('2026-08-03T10:00:00Z'),
    createdAt: iso('2026-08-03T10:00:00Z'),
    ...overrides
  }
}

function makeService(): { svc: ApplicationService; store: InMemoryStore } {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const svc = new ApplicationService(store, new MockBossProvider(), activity)
  return { svc, store }
}

describe('ApplicationService.stats() — funnel review statistics', () => {
  it('empty funnel → zero counts and null averages', () => {
    const { svc } = makeService()
    const s = svc.stats()
    expect(s.total).toBe(0)
    expect(s.active).toBe(0)
    expect(s.terminal).toEqual({ offer: 0, rejected: 0, withdrawn: 0 })
    expect(s.reachedStage.applied).toBe(0)
    expect(s.avgDaysSinceLastEvent).toBeNull()
    expect(s.avgDaysInProcess).toBeNull()
    expect(s.conversion.offer).toBe(0)
  })

  it('counts by status / source / reached-stage / conversion / terminal', () => {
    const { svc, store } = makeService()
    // a1: applied → communicated → assessment → interview (non-terminal, in process)
    store.createApplication(makeApp({ id: 'a1', source: 'boss' }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e1', type: 'applied', eventAt: iso('2026-08-01T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e2', type: 'communicated', eventAt: iso('2026-08-02T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e3', type: 'assessment', eventAt: iso('2026-08-03T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e4', type: 'interview', eventAt: iso('2026-08-04T10:00:00Z') }))
    // a2: applied → interview → offer (terminal offer)
    store.createApplication(makeApp({ id: 'a2', company: '阿里', source: 'web' }))
    store.createApplicationEvent(makeEvent('a2', { id: 'e5', type: 'applied', eventAt: iso('2026-08-01T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a2', { id: 'e6', type: 'interview', eventAt: iso('2026-08-05T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a2', { id: 'e7', type: 'offer', eventAt: iso('2026-08-06T10:00:00Z') }))
    // a3: applied → rejected (terminal)
    store.createApplication(makeApp({ id: 'a3', company: '字节', source: 'referral' }))
    store.createApplicationEvent(makeEvent('a3', { id: 'e8', type: 'applied', eventAt: iso('2026-08-01T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a3', { id: 'e9', type: 'rejected', eventAt: iso('2026-08-02T10:00:00Z') }))

    const s = svc.stats()
    expect(s.total).toBe(3)
    expect(s.active).toBe(1) // only a1 non-terminal
    expect(s.terminal).toEqual({ offer: 1, rejected: 1, withdrawn: 0 })
    expect(s.byStatus.interview).toBe(1) // a1 current
    expect(s.byStatus.offer).toBe(1)
    expect(s.byStatus.rejected).toBe(1)
    expect(s.bySource.boss).toBe(1)
    expect(s.bySource.web).toBe(1)
    expect(s.bySource.referral).toBe(1)
    // reachedStage: every app reached applied → 3; interview reached by a1+a2 → 2;
    // offer reached by a2 → 1; communicated by a1 → 1; assessment by a1 → 1.
    expect(s.reachedStage).toEqual({ applied: 3, communicated: 1, assessment: 1, written_test: 0, interview: 2, offer: 1 })
    // conversion vs applied (3): interview 2/3 = 67, offer 1/3 = 33.
    expect(s.conversion.interview).toBe(67)
    expect(s.conversion.offer).toBe(33)
    expect(s.conversion.assessment).toBe(33)
  })

  it('stale = non-terminal apps with no progress for ≥ STALE_DAYS (14)', () => {
    const { svc, store } = makeService()
    // An app applied 20 days ago with only an `applied` event (non-terminal, stale).
    store.createApplication(makeApp({ id: 'a1', appliedAt: iso('2026-07-15T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e1', type: 'applied', eventAt: iso('2026-07-15T10:00:00Z') }))
    const s = svc.stats()
    expect(s.stale).toBe(1)
    expect(s.byFunnelGroup.stale).toBe(1)
    expect(s.active).toBe(1) // still non-terminal
  })

  it('urgent = apps with a stage_deadline within 3 days', () => {
    const { svc, store } = makeService()
    const soon = new Date(Date.now() + 1 * 86_400_000).toISOString() // tomorrow
    store.createApplication(makeApp({ id: 'a1', stageDeadline: soon }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e1', type: 'applied', eventAt: iso('2026-08-01T10:00:00Z') }))
    const s = svc.stats()
    expect(s.urgent).toBe(1)
    expect(s.byFunnelGroup.urgent).toBe(1)
  })

  it('averages are non-null when non-terminal apps exist', () => {
    const { svc, store } = makeService()
    store.createApplication(makeApp({ id: 'a1', appliedAt: iso('2026-08-01T10:00:00Z') }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e1', type: 'applied', eventAt: iso('2026-08-01T10:00:00Z') }))
    const s = svc.stats()
    expect(s.avgDaysSinceLastEvent).not.toBeNull()
    expect(s.avgDaysInProcess).not.toBeNull()
    expect(typeof s.avgDaysSinceLastEvent).toBe('number')
  })
})
