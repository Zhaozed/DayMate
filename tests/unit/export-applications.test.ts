// Milestone D §D3 — ApplicationService.exportApplicationsZip gathers every
// 投递-module row (active + deleted + archived) into a STORED ZIP.
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { writeZip } from '../../src/main/util/zip-writer'
import type { Application, ApplicationEvent, InterviewNote, PrepMaterial, ResumeVersion } from '@shared/types'

function makeService() {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const svc = new ApplicationService(store, activity)
  return { svc, store }
}

function parseEntries(zip: Uint8Array): Record<string, unknown[]> {
  // Re-implement a tiny STORED reader to round-trip the writer's output,
  // proving the service + writer agree on the bytes (the zip-writer test
  // covers the format vs real unzip separately).
  const result: Record<string, unknown[]> = {}
  let off = 0
  const dec = new TextDecoder()
  while (off < zip.length - 22) {
    const sig = zip[off] | (zip[off + 1] << 8) | (zip[off + 2] << 16) | (zip[off + 3] << 24)
    if ((sig >>> 0) !== 0x04034b50) break
    const nameLen = zip[off + 26] | (zip[off + 27] << 8)
    const size =
      zip[off + 22] | (zip[off + 23] << 8) | (zip[off + 24] << 16) | (zip[off + 25] << 24)
    const name = dec.decode(zip.subarray(off + 30, off + 30 + nameLen))
    const dataStart = off + 30 + nameLen
    const raw = dec.decode(zip.subarray(dataStart, dataStart + size))
    try {
      result[name] = JSON.parse(raw)
    } catch {
      result[name] = []
    }
    off = dataStart + size
  }
  return result
}

describe('ApplicationService.exportApplicationsZip (§D3)', () => {
  it('gathers active + deleted + archived apps, events, resumes, preps, notes', () => {
    const { svc, store } = makeService()

    // Active app + event + resume + prep.
    const a1 = svc.create({ company: '美团', position: 'Go 后端', source: 'boss' })
    svc.addEvent({ applicationId: a1.application.id, type: 'applied', locked: true })
    store.createResumeVersion({
      id: 'rv1',
      applicationId: a1.application.id,
      version: 1,
      html: '<b>简历</b>',
      createdAt: '2026-08-11T00:00:00Z'
    } as ResumeVersion)
    store.createPrepMaterial({
      id: 'pm1',
      applicationId: a1.application.id,
      version: 1,
      html: '<i>逐字稿</i>',
      createdAt: '2026-08-11T00:00:00Z'
    } as PrepMaterial)

    // Deleted app.
    const a2 = svc.create({ company: '字节', position: '前端', source: 'manual' })
    svc.softDelete(a2.application.id)

    // Archived app.
    const a3 = svc.create({ company: '阿里', position: 'Java', source: 'web' })
    svc.archive(a3.application.id)

    // Standalone 面经 note.
    svc.createInterviewNote({
      company: '腾讯',
      position: '后端',
      tags: ['algorithm', 'project'],
      content: '问了 Go GMP'
    })

    const zip = svc.exportApplicationsZip()
    expect(zip.length).toBeGreaterThan(0)

    // It IS a zip produced by our writer.
    const sig = (zip[0] | (zip[1] << 8) | (zip[2] << 16) | (zip[3] << 24)) >>> 0
    expect(sig).toBe(0x04034b50)

    const entries = parseEntries(zip)
    expect((entries['applications.json'] as Application[]).length).toBe(3) // active + deleted + archived
    expect((entries['application_events.json'] as ApplicationEvent[]).length).toBeGreaterThanOrEqual(1)
    expect((entries['resume_versions.json'] as ResumeVersion[]).length).toBe(1)
    expect((entries['prep_materials.json'] as PrepMaterial[]).length).toBe(1)
    expect((entries['interview_notes.json'] as InterviewNote[]).length).toBe(1)
    expect(entries['README.txt']).toBeDefined() // README present (raw text)
  })

  it('produces a valid (header-only) archive when the store is empty', () => {
    const { svc } = makeService()
    const zip = svc.exportApplicationsZip()
    const entries = parseEntries(zip)
    expect((entries['applications.json'] ?? []) as unknown[]).toHaveLength(0)
    expect((entries['interview_notes.json'] ?? []) as unknown[]).toHaveLength(0)
  })

  it('the writer itself round-trips a multi-entry dump', () => {
    const entries = [
      { name: 'a.json', data: new TextEncoder().encode('[1,2,3]') },
      { name: 'b.json', data: new TextEncoder().encode('{"k":"v"}') }
    ]
    const zip = writeZip(entries, { fixedDate: new Date(2026, 7, 11, 9, 30, 0) })
    const parsed = parseEntries(zip)
    expect(parsed['a.json']).toEqual([1, 2, 3])
    expect(parsed['b.json']).toEqual({ k: 'v' })
  })
})
