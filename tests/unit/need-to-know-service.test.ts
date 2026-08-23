import { describe, it, expect } from 'vitest'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { InMemoryStore } from '../../src/main/db/in-memory-store'

// NeedToKnow service (Spec §18). 必读 is the curated daily brief; the
// auto_inbox template no longer publishes (bucket-count noise removed), and
// stale "收件箱已分类" rows are purged at boot via deleteByTitle. The page's
// "清空全部" reset calls clearAll.

function svc(): NeedToKnowService {
  return new NeedToKnowService(new InMemoryStore())
}

describe('NeedToKnowService — deleteByTitle / clearAll', () => {
  it('deleteByTitle removes active items whose title matches exactly', () => {
    const s = svc()
    s.create({ title: '收件箱已分类', summary: '...', reason: '...', priority: 'medium' })
    s.create({ title: '今日晨报', summary: '...', reason: '...', priority: 'high' })
    s.create({ title: '收件箱已分类', summary: '...B', reason: '...', priority: 'medium' })
    s.deleteByTitle('收件箱已分类')
    const list = s.list()
    expect(list.length).toBe(1)
    expect(list[0].title).toBe('今日晨报')
  })

  it('deleteByTitle leaves dismissed items untouched (they are already filtered from list)', () => {
    const s = svc()
    const a = s.create({ title: '收件箱已分类', summary: '...', reason: '...', priority: 'medium' })
    s.dismiss(a.id) // already dismissed → not in list anyway
    s.create({ title: '今日晨报', summary: '...', reason: '...', priority: 'high' })
    s.deleteByTitle('收件箱已分类')
    expect(s.list().length).toBe(1)
  })

  it('clearAll removes every active item', () => {
    const s = svc()
    s.create({ title: 'A', summary: '', reason: '', priority: 'urgent' })
    s.create({ title: 'B', summary: '', reason: '', priority: 'medium' })
    s.clearAll()
    expect(s.list().length).toBe(0)
  })

  it('dismiss marks a single item dismissed (removed from list)', () => {
    const s = svc()
    const a = s.create({ title: 'A', summary: '', reason: '', priority: 'medium' })
    s.create({ title: 'B', summary: '', reason: '', priority: 'medium' })
    s.dismiss(a.id)
    const list = s.list()
    expect(list.length).toBe(1)
    expect(list[0].title).toBe('B')
  })
})

// ADR 0029 — the 必读 redesign adds threadId / briefingCategory /
// sourceProvider / sourceAccountId / sourceLink / updatedAt to NeedToKnow, plus
// a `update()` path used by the thread-merge logic. Round-trip them so the
// InMemory (and via the sqlite store mirror, the SQLite) mapping is honest.
describe('NeedToKnowService — ADR 0029 thread fields + update()', () => {
  it('create persists the new thread / source fields', () => {
    const s = svc()
    const ntk = s.create({
      title: '面试通知',
      summary: 'snippet',
      reason: 'reason',
      priority: 'urgent',
      threadId: 'thread-xyz',
      briefingCategory: 'job',
      sourceProvider: 'gmail',
      sourceAccountId: 'acct-1',
      sourceLink: 'https://mail.google.com/#all/m1'
    })
    expect(ntk.threadId).toBe('thread-xyz')
    expect(ntk.briefingCategory).toBe('job')
    expect(ntk.sourceProvider).toBe('gmail')
    expect(ntk.sourceAccountId).toBe('acct-1')
    expect(ntk.sourceLink).toBe('https://mail.google.com/#all/m1')
    expect(ntk.updatedAt).toBeDefined()
    // Round-trips back through list().
    const got = s.list().find((n) => n.id === ntk.id)
    expect(got?.threadId).toBe('thread-xyz')
    expect(got?.briefingCategory).toBe('job')
    expect(got?.sourceProvider).toBe('gmail')
    expect(got?.sourceAccountId).toBe('acct-1')
    expect(got?.sourceLink).toBe('https://mail.google.com/#all/m1')
  })

  it('update() patches title/summary/sourceRefs/briefingCategory + bumps updatedAt (thread merge)', () => {
    const s = svc()
    const ntk = s.create({
      title: 'Re: 面试安排',
      summary: '第一封',
      reason: '',
      priority: 'high',
      threadId: 'tm-1',
      briefingCategory: 'job',
      sourceProvider: 'gmail',
      sourceAccountId: 'acct-1',
      sourceRefs: [{ type: 'email', id: 'email:tm-1', label: 'Re: 面试安排' }]
    })
    const before = ntk.updatedAt
    // Merge a second email into the same thread: bump title/summary + append
    // the new sourceRef, keep the category.
    s.update(ntk.id, {
      title: 'Re: 面试安排 (更新)',
      summary: '第二封',
      sourceRefs: [
        { type: 'email', id: 'email:tm-1', label: 'Re: 面试安排' },
        { type: 'email', id: 'email:tm-2', label: 'Re: 面试安排 (更新)' }
      ],
      briefingCategory: 'job'
    })
    const got = s.list().find((n) => n.id === ntk.id)!
    expect(got.title).toBe('Re: 面试安排 (更新)')
    expect(got.summary).toBe('第二封')
    expect(got.sourceRefs.map((r) => r.id).sort()).toEqual(['email:tm-1', 'email:tm-2'])
    expect(got.briefingCategory).toBe('job')
    // updatedAt touched (never goes backward; create + update can share a ms).
    expect(got.updatedAt).toBeDefined()
    expect(got.updatedAt! >= (before ?? '')).toBe(true)
  })
})
