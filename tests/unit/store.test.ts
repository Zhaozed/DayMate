import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import type {
  Application,
  ApplicationEvent,
  InterviewNote
} from '@shared/types'

// InMemoryStore/SqliteStore parity for the Milestone A store additions. These
// tests pin the contract so SqliteStore (drizzle + better-sqlite3) and
// InMemoryStore behave identically — the release gate requires parity.

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

describe('InMemoryStore — soft delete / restore / purge / archive', () => {
  it('listApplications excludes soft-deleted apps', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.createApplication(makeApp({ id: 'a2', company: '阿里' }))
    expect(store.listApplications()).toHaveLength(2)
    store.softDeleteApplication('a1', iso('2026-08-09T00:00:00Z'))
    const live = store.listApplications()
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe('a2')
  })

  it('listDeletedApplications returns only soft-deleted, newest first', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.createApplication(makeApp({ id: 'a2', company: '阿里' }))
    store.softDeleteApplication('a1', iso('2026-08-08T00:00:00Z'))
    store.softDeleteApplication('a2', iso('2026-08-09T00:00:00Z'))
    const deleted = store.listDeletedApplications()
    expect(deleted).toHaveLength(2)
    expect(deleted[0].id).toBe('a2') // newest deletedAt first
    expect(deleted[0].deletedAt).toBeTruthy()
  })

  it('restoreApplication clears deletedAt and returns app to live list', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.softDeleteApplication('a1', iso('2026-08-09T00:00:00Z'))
    expect(store.listApplications()).toHaveLength(0)
    store.restoreApplication('a1')
    const live = store.listApplications()
    expect(live).toHaveLength(1)
    expect(live[0].deletedAt).toBeUndefined()
  })

  it('purgeApplication hard-deletes the app + its events + resume/prep versions', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.createApplicationEvent(makeEvent('a1', { id: 'e1' }))
    store.createResumeVersion({
      id: 'r1', applicationId: 'a1', version: 1, html: '<b></b>', createdAt: iso('2026-08-04T00:00:00Z')
    })
    store.createPrepMaterial({
      id: 'p1', applicationId: 'a1', version: 1, html: '<i></i>', createdAt: iso('2026-08-04T00:00:00Z')
    })
    store.purgeApplication('a1')
    expect(store.getApplication('a1')).toBeUndefined()
    expect(store.listApplicationEvents('a1')).toHaveLength(0)
    expect(store.listResumeVersions('a1')).toHaveLength(0)
    expect(store.listPrepMaterials('a1')).toHaveLength(0)
  })

  it('archiveApplication moves app out of default list; deletedAt takes precedence over archivedAt', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.archiveApplication('a1', iso('2026-08-09T00:00:00Z'))
    // archived → not in default list
    expect(store.listApplications()).toHaveLength(0)
    // but in archived list
    expect(store.listArchivedApplications()).toHaveLength(1)
    // soft-delete an archived app → it should leave archived list, appear in deleted
    store.softDeleteApplication('a1', iso('2026-08-10T00:00:00Z'))
    expect(store.listArchivedApplications()).toHaveLength(0)
    expect(store.listDeletedApplications()).toHaveLength(1)
  })
})

describe('InMemoryStore — resume versions', () => {
  it('lists versions newest-first and getLatest returns max version', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.createResumeVersion({ id: 'r1', applicationId: 'a1', version: 1, html: 'v1', createdAt: iso('2026-08-04T00:00:00Z') })
    store.createResumeVersion({ id: 'r2', applicationId: 'a1', version: 3, html: 'v3', createdAt: iso('2026-08-06T00:00:00Z') })
    store.createResumeVersion({ id: 'r3', applicationId: 'a1', version: 2, html: 'v2', createdAt: iso('2026-08-05T00:00:00Z') })
    const list = store.listResumeVersions('a1')
    expect(list.map((r) => r.version)).toEqual([3, 2, 1])
    const latest = store.getLatestResumeVersion('a1')
    expect(latest?.version).toBe(3)
    expect(latest?.html).toBe('v3')
  })

  it('getLatestResumeVersion returns undefined when none exist', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    expect(store.getLatestResumeVersion('a1')).toBeUndefined()
  })
})

describe('InMemoryStore — prep materials', () => {
  it('mirrors resume versioning behaviour', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    store.createPrepMaterial({ id: 'p1', applicationId: 'a1', version: 1, html: 't1', createdAt: iso('2026-08-04T00:00:00Z') })
    store.createPrepMaterial({ id: 'p2', applicationId: 'a1', version: 2, html: 't2', createdAt: iso('2026-08-05T00:00:00Z') })
    expect(store.listPrepMaterials('a1').map((m) => m.version)).toEqual([2, 1])
    expect(store.getLatestPrepMaterial('a1')?.html).toBe('t2')
  })
})

describe('InMemoryStore — interview notes (面经库)', () => {
  function makeNote(overrides: Partial<InterviewNote> = {}): InterviewNote {
    return {
      id: 'n1',
      company: '腾讯',
      position: '后端',
      tags: ['algorithm', 'project'],
      content: '一道dp',
      source: 'manual',
      createdAt: iso('2026-08-05T00:00:00Z'),
      updatedAt: iso('2026-08-05T00:00:00Z'),
      ...overrides
    }
  }

  it('create / get / list (newest-updated-first)', () => {
    const store = new InMemoryStore()
    store.createInterviewNote(makeNote({ id: 'n1', updatedAt: iso('2026-08-05T00:00:00Z') }))
    store.createInterviewNote(makeNote({ id: 'n2', updatedAt: iso('2026-08-09T00:00:00Z') }))
    const list = store.listInterviewNotes()
    expect(list.map((n) => n.id)).toEqual(['n2', 'n1'])
    expect(store.getInterviewNote('n1')?.tags).toEqual(['algorithm', 'project'])
  })

  it('updateInterviewNote patches fields and bumps updatedAt', () => {
    const store = new InMemoryStore()
    store.createInterviewNote(makeNote({ id: 'n1' }))
    const updated = store.updateInterviewNote('n1', { content: '改为八股', tags: ['fundamentals'] })
    expect(updated?.content).toBe('改为八股')
    expect(updated?.tags).toEqual(['fundamentals'])
    expect(updated?.updatedAt).not.toBe(iso('2026-08-05T00:00:00Z'))
  })

  it('deleteInterviewNote removes the note', () => {
    const store = new InMemoryStore()
    store.createInterviewNote(makeNote({ id: 'n1' }))
    store.deleteInterviewNote('n1')
    expect(store.getInterviewNote('n1')).toBeUndefined()
    expect(store.listInterviewNotes()).toHaveLength(0)
  })

  it('update on missing id returns undefined', () => {
    const store = new InMemoryStore()
    expect(store.updateInterviewNote('nope', { content: 'x' })).toBeUndefined()
  })
})

describe('InMemoryStore — rich-field updateApplication passthrough', () => {
  it('updateApplication passes through all rich fields', () => {
    const store = new InMemoryStore()
    store.createApplication(makeApp({ id: 'a1' }))
    const updated = store.updateApplication('a1', {
      city: '深圳',
      salaryRange: '25-40K',
      jdText: 'JD body',
      stage: '一面',
      stageDeadline: iso('2026-08-12T10:00:00Z'),
      interviewLink: 'https://meet/x',
      priority: 'back',
      emailRefId: 'email:123'
    })
    expect(updated?.city).toBe('深圳')
    expect(updated?.salaryRange).toBe('25-40K')
    expect(updated?.jdText).toBe('JD body')
    expect(updated?.stage).toBe('一面')
    expect(updated?.interviewLink).toBe('https://meet/x')
    expect(updated?.priority).toBe('back')
    expect(updated?.emailRefId).toBe('email:123')
  })
})
