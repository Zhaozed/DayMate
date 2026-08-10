import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { TaskService, isAllowedTransition } from '../../src/main/services/task-service'

describe('task service', () => {
  it('creates a task with default priority and status', () => {
    const svc = new TaskService(new InMemoryStore())
    const t = svc.create({ title: 'X', sourceType: 'email' })
    expect(t.status).toBe('todo')
    expect(t.priority).toBe('medium')
  })

  it('deduplicates by (sourceType, sourceId) — idempotent create', () => {
    const svc = new TaskService(new InMemoryStore())
    const a = svc.create({ title: 'X', sourceType: 'email', sourceId: 'm-1' })
    const b = svc.create({ title: 'X', sourceType: 'email', sourceId: 'm-1' })
    expect(a.id).toBe(b.id)
    expect(svc.list().length).toBe(1)
  })

  it('allows distinct tasks when sourceId differs', () => {
    const svc = new TaskService(new InMemoryStore())
    svc.create({ title: 'X', sourceType: 'email', sourceId: 'm-1' })
    svc.create({ title: 'Y', sourceType: 'email', sourceId: 'm-2' })
    expect(svc.list().length).toBe(2)
  })

  it('rejects invalid status transitions', () => {
    const svc = new TaskService(new InMemoryStore())
    const t = svc.create({ title: 'X', sourceType: 'email' })
    expect(() => svc.update(t.id, { status: 'need_to_know' })).toThrow(/无效的任务状态转换/)
  })

  it('allows valid transitions and completes', () => {
    const svc = new TaskService(new InMemoryStore())
    const t = svc.create({ title: 'X', sourceType: 'email' })
    const updated = svc.update(t.id, { status: 'waiting' })
    expect(updated.status).toBe('waiting')
    const done = svc.complete(t.id)
    expect(done.status).toBe('done')
  })
})

describe('isAllowedTransition', () => {
  it('treats same-status as allowed', () => {
    expect(isAllowedTransition('todo', 'todo')).toBe(true)
  })
  it('allows todo -> done', () => {
    expect(isAllowedTransition('todo', 'done')).toBe(true)
  })
  it('forbids need_to_know -> waiting (skipping approval)', () => {
    expect(isAllowedTransition('need_to_know', 'waiting')).toBe(false)
  })
})
