import { describe, it, expect } from 'vitest'
import { MemoryService, validateMemoryContent, MemorySaveError } from '../../src/main/services/memory-service'
import { InMemoryStore } from '../../src/main/db/in-memory-store'

// Memory Service (Spec §16). Memory is explicit, inspectable, deletable. Agent
// proposals land `confirmed:false` and need user confirmation before they are
// active; forbidden content (tokens, full email bodies, inferred sensitive
// traits, negative judgments) is rejected before persistence.

function svc(): { service: MemoryService; store: InMemoryStore } {
  const store = new InMemoryStore()
  return { service: new MemoryService(store), store }
}

describe('MemoryService', () => {
  it('user saves are confirmed immediately and active (searchable)', () => {
    const { service } = svc()
    const m = service.save({ key: 'email_tone', value: 'concise and direct', source: 'user' })
    expect(m.confirmed).toBe(true)
    const found = service.search('concise')
    expect(found.length).toBe(1)
    expect(found[0].id).toBe(m.id)
  })

  it('agent proposals auto-confirm and are immediately active (searchable) — no manual confirmation', () => {
    const { service } = svc()
    const m = service.save({ key: 'project', value: 'Project Aurora', source: 'agent' })
    expect(m.confirmed).toBe(true)
    // An auto-confirmed proposal IS active — search finds it immediately.
    expect(service.search('Aurora').length).toBe(1)
  })

  it('an agent proposal does NOT overwrite a user-authored confirmed value (merge, not clobber)', () => {
    const { service } = svc()
    const userItem = service.save({ key: 'working_hours', value: '9–18', source: 'user' })
    // Agent tries to overwrite the user's explicit value — it must be protected.
    const ret = service.save({ key: 'working_hours', value: '10–19', source: 'agent' })
    expect(ret.value).toBe('9–18') // user truth wins
    const active = service.listConfirmed().filter((m) => m.key === 'working_hours')
    expect(active.length).toBe(1)
    expect(active[0].id).toBe(userItem.id)
    expect(active[0].value).toBe('9–18')
  })

  it('an agent proposal UPDATES an agent-authored confirmed value in place (refine)', () => {
    const { service } = svc()
    const first = service.save({ key: 'persona', value: '旧画像', source: 'agent' })
    const next = service.save({ key: 'persona', value: '更准确的画像', source: 'agent' })
    // Same row, updated value — one active value per key, no duplicate.
    expect(next.id).toBe(first.id)
    expect(next.value).toBe('更准确的画像')
    const active = service.listConfirmed().filter((m) => m.key === 'persona')
    expect(active.length).toBe(1)
  })

  it('is idempotent: an identical agent proposal (key+value) does not create a duplicate', () => {
    const { service } = svc()
    const a = service.save({ key: 'contact', value: 'Alice — prefers morning', source: 'agent' })
    const b = service.save({ key: 'contact', value: 'Alice — prefers morning', source: 'agent' })
    expect(b.id).toBe(a.id)
    expect(service.list().filter((m) => m.key === 'contact').length).toBe(1)
  })

  it('delete is idempotent', () => {
    const { service } = svc()
    const m = service.save({ key: 'other', value: 'x', source: 'user' })
    service.delete(m.id)
    service.delete(m.id) // no throw
    expect(service.list().length).toBe(0)
  })

  it('search is case-insensitive over key and value', () => {
    const { service } = svc()
    service.save({ key: 'notification_prefs', value: 'Quiet after 22:00', source: 'user' })
    expect(service.search('NOTIFICATION').length).toBe(1)
    expect(service.search('QUIET').length).toBe(1)
    expect(service.search('noonexistent').length).toBe(0)
  })

  it('a NEW agent value for an existing agent-authored key UPDATES it in place (no pile-up)', () => {
    const { service } = svc()
    const a = service.save({ key: 'writing_style', value: '偏好简洁回复', source: 'agent' })
    const b = service.save({ key: 'writing_style', value: '喜欢简洁友好的回复', source: 'agent' })
    // Update in place — same row id, new value; one active value per key.
    expect(b.id).toBe(a.id)
    expect(b.value).toBe('喜欢简洁友好的回复')
    const active = service.listConfirmed().filter((m) => m.key === 'writing_style')
    expect(active.length).toBe(1)
  })

  it('a user-authored confirmed save demotes prior confirmed siblings of the same key', () => {
    const { service } = svc()
    service.save({ key: 'persona', value: '工程师', source: 'user' })
    const next = service.save({ key: 'persona', value: 'AI 产品经理', source: 'user' })
    const active = service.listConfirmed().filter((m) => m.key === 'persona')
    expect(active.length).toBe(1)
    expect(active[0].id).toBe(next.id)
    expect(active[0].value).toBe('AI 产品经理')
  })
})

describe('MemoryService — reconcile() boot cleanup (auto-confirm migration)', () => {
  it('collapses duplicate confirmed rows per key to the newest', () => {
    const { service, store } = svc()
    // Simulate legacy state: two confirmed persona rows (the old confirm-
    // via-update path left these because it bypassed service.confirm's demote).
    store.createMemory({ id: 'mem-old', key: 'persona', value: '旧画像', source: 'user', confirmed: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    store.createMemory({ id: 'mem-new', key: 'persona', value: '新画像', source: 'user', confirmed: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' })
    service.reconcile()
    const active = service.listConfirmed().filter((m) => m.key === 'persona')
    expect(active.length).toBe(1)
    expect(active[0].id).toBe('mem-new')
  })

  it('promotes the newest pending row to confirmed when no confirmed exists for that key', () => {
    const { service, store } = svc()
    // Legacy pending rows from the old confirm-gate path — now auto-confirm.
    store.createMemory({ id: 'p1', key: 'writing_style', value: '简洁', source: 'agent', confirmed: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    store.createMemory({ id: 'p2', key: 'writing_style', value: '简洁友好', source: 'agent', confirmed: false, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' })
    service.reconcile()
    // The newest pending (p2) is promoted to confirmed; p1 is dropped.
    const rows = service.list().filter((m) => m.key === 'writing_style')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('p2')
    expect(rows[0].confirmed).toBe(true)
    expect(rows[0].value).toBe('简洁友好')
  })

  it('drops pending when a confirmed value for the same key already exists', () => {
    const { service, store } = svc()
    store.createMemory({ id: 'c1', key: 'persona', value: '已确认', source: 'user', confirmed: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' })
    store.createMemory({ id: 'p1', key: 'persona', value: '待确认', source: 'agent', confirmed: false, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' })
    service.reconcile()
    const rows = service.list().filter((m) => m.key === 'persona')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('c1') // confirmed wins; pending dropped
  })

  it('leaves unrelated keys untouched', () => {
    const { service, store } = svc()
    store.createMemory({ id: 'a', key: 'persona', value: 'X', source: 'user', confirmed: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    store.createMemory({ id: 'b', key: 'contact', value: 'Alice', source: 'user', confirmed: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    service.reconcile()
    expect(service.listConfirmed().length).toBe(2)
  })
})

describe('MemoryService — forbidden content rejection (Spec §16)', () => {
  it('rejects values that look like tokens / long credential blobs', () => {
    expect(() => validateMemoryContent('other', 'sk-abc123 ' + 'x'.repeat(50))).toThrow(MemorySaveError)
    expect(() => validateMemoryContent('other', 'my api_key is secret')).toThrow(MemorySaveError)
  })
  it('rejects values that look like a full email body', () => {
    expect(() =>
      validateMemoryContent('other', 'From: a@x.com\nTo: b@x.com\nSubject: hi\n\nbody')
    ).toThrow(MemorySaveError)
    expect(() => validateMemoryContent('other', '-------- Original Message --------')).toThrow(MemorySaveError)
  })
  it('rejects inferred sensitive traits and negative judgments about contacts', () => {
    expect(() => validateMemoryContent('contact', 'Alice has a medical condition')).toThrow(MemorySaveError)
    expect(() => validateMemoryContent('contact', 'Bob is lazy and incompetent')).toThrow(MemorySaveError)
  })
  it('rejects overly long values', () => {
    expect(() => validateMemoryContent('other', 'x'.repeat(2001))).toThrow(MemorySaveError)
  })
  it('accepts ordinary preference memory', () => {
    expect(() => validateMemoryContent('email_tone', 'prefers concise, friendly replies')).not.toThrow()
    expect(() => validateMemoryContent('meeting_duration', '30 minutes default')).not.toThrow()
  })

  it('save() refuses forbidden content before persisting', () => {
    const { service, store } = svc()
    expect(() => service.save({ key: 'other', value: 'password: hunter2secret', source: 'user' })).toThrow()
    expect(store.listMemory().length).toBe(0)
  })
})
