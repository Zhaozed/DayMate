// ADR 0027 — ToDo settings: writeTodo MERGES at the field level so concurrent
// writers (boot purge writes purgeDone/skipTokens; cold-start trigger writes
// coldStartDone) don't clobber each other's keys. Without the merge, a
// cold-start write that read a stale todo block would drop `purgeDone`, causing
// every restart to re-purge email ToDos (which then never came back, because
// cold-start was already marked done).
import { describe, it, expect } from 'vitest'
import { Settings } from '../../src/main/util/settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('settings — todo block (ADR 0027)', () => {
  it('writeTodo MERGES keys instead of replacing the block (no clobber)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-todo-merge-'))
    const settings = new Settings(join(dir, 'settings.json'))

    // Boot purge writes purgeDone + skipTokens.
    await settings.writeTodo({ purgeDone: true, skipTokens: ['[student_ips]'] })
    // A concurrent cold-start writer that only knows about coldStartDone writes
    // just that key — it MUST NOT drop purgeDone/skipTokens.
    await settings.writeTodo({ coldStartDone: ['gmail-real'] })

    const todo = await settings.readTodo()
    expect(todo.purgeDone).toBe(true) // survived the cold-start write
    expect(todo.skipTokens).toEqual(['[student_ips]'])
    expect(todo.coldStartDone).toEqual(['gmail-real'])

    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a fresh Settings reload (persisted to disk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-todo-persist-'))
    const path = join(dir, 'settings.json')
    const settings = new Settings(path)
    await settings.writeTodo({ purgeDone: true, coldStartDone: ['gmail-real', 'mail163-real'] })

    const fresh = new Settings(path)
    const todo = await fresh.readTodo()
    expect(todo.purgeDone).toBe(true)
    expect(todo.coldStartDone).toEqual(['gmail-real', 'mail163-real'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes bad todo input on disk reload (non-string skipTokens dropped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-todo-norm-'))
    const path = join(dir, 'settings.json')
    const settings = new Settings(path)
    // writeTodo persists the raw object; normalization runs on read-from-disk
    // (a fresh Settings instance, simulating an app restart).
    await settings.writeTodo({
      skipTokens: ['[student_ips]', '', 123 as unknown as string],
      coldStartDone: ['gmail-real', null as unknown as string]
    } as never)
    const fresh = new Settings(path)
    const todo = await fresh.readTodo()
    expect(todo.skipTokens).toEqual(['[student_ips]']) // empty + non-string dropped
    expect(todo.coldStartDone).toEqual(['gmail-real']) // null dropped
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips the one-time demoSeeded flag + survives reload (ADR 0027 fix)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-todo-demo-'))
    const path = join(dir, 'settings.json')
    const settings = new Settings(path)
    // seedDemoData sets demoSeeded once; the purge must NOT reset it (the
    // whole point: demo 投递 never re-seed after the purge clears them).
    await settings.writeTodo({ demoSeeded: true })
    // A later purge write (purgeVersion/coldStartDone) MERGES — demoSeeded
    // survives.
    await settings.writeTodo({ purgeVersion: 4, coldStartDone: [] })
    const fresh = new Settings(path)
    const todo = await fresh.readTodo()
    expect(todo.demoSeeded).toBe(true)
    expect(todo.purgeVersion).toBe(4)
    expect(todo.coldStartDone).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
