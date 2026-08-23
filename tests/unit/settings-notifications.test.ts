// Milestone D — non-secret notification preferences persist + normalize.
import { describe, it, expect } from 'vitest'
import { Settings } from '../../src/main/util/settings'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('settings — notification prefs (§D2, non-secret)', () => {
  it('reads/writes notification prefs (persisted across a fresh Settings)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-notif-'))
    const settings = new Settings(join(dir, 'settings.json'))
    expect(await settings.readNotifications()).toEqual({})
    const written = await settings.writeNotifications({
      nativeEnabled: false,
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      categories: { routine: false },
      routineOverrides: { interview_prep: false }
    })
    expect(written.nativeEnabled).toBe(false)
    expect(written.quietHours?.start).toBe('22:00')
    const fresh = new Settings(join(dir, 'settings.json'))
    const read = await fresh.readNotifications()
    expect(read.nativeEnabled).toBe(false)
    expect(read.categories?.routine).toBe(false)
    expect(read.routineOverrides?.interview_prep).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes a malformed prefs block away (bad quiet-hours times dropped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-notif-bad-'))
    const file = join(dir, 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        llm: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
        notifications: {
          nativeEnabled: 'yes', // not a boolean → dropped
          quietHours: { enabled: true, start: '25:00', end: '07:00' }, // bad time → dropped
          categories: { routine: 'no', approval: false } // 'no' dropped, false kept
        }
      }),
      'utf8'
    )
    const settings = new Settings(file)
    const prefs = await settings.readNotifications()
    expect(prefs.nativeEnabled).toBeUndefined()
    expect(prefs.quietHours).toBeUndefined()
    expect(prefs.categories?.approval).toBe(false)
    expect(prefs.categories?.routine).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})
