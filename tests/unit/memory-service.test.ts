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

  it('agent proposals land proposed (not active) — never searchable until confirmed', () => {
    const { service } = svc()
    const m = service.save({ key: 'project', value: 'Project Aurora', source: 'agent' })
    expect(m.confirmed).toBe(false)
    // A proposed item must NOT be active — search returns nothing.
    expect(service.search('Aurora').length).toBe(0)
    service.confirm(m.id)
    expect(service.search('Aurora').length).toBe(1)
  })

  it('confirming a proposed item demotes any prior confirmed value for the same key (one active per key)', () => {
    const { service } = svc()
    const first = service.save({ key: 'working_hours', value: '9–18', source: 'user' })
    const proposal = service.save({ key: 'working_hours', value: '10–19', source: 'agent' })
    service.confirm(proposal.id)
    const active = service.listConfirmed().filter((m) => m.key === 'working_hours')
    expect(active.length).toBe(1)
    expect(active[0].value).toBe('10–19')
    expect(active[0].id).toBe(proposal.id)
    // The prior confirmed item is gone (not demoted-then-leaked).
    expect(service.list().find((m) => m.id === first.id)).toBeUndefined()
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
