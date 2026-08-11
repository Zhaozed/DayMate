// Milestone E — non-secret birth data for the daily 运势 persists + normalizes.
import { describe, it, expect } from 'vitest'
import { Settings } from '../../src/main/util/settings'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('settings — birth data (Milestone E, non-secret)', () => {
  it('reads/writes birth data (persisted across a fresh Settings)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-birth-'))
    const settings = new Settings(join(dir, 'settings.json'))
    expect(await settings.readBirthData()).toBeUndefined()
    const written = await settings.writeBirthData({
      year: 2000,
      month: 6,
      day: 15,
      hour: 8,
      gender: 'male'
    })
    expect(written.year).toBe(2000)
    expect(written.hour).toBe(8)
    expect(written.gender).toBe('male')
    const fresh = new Settings(join(dir, 'settings.json'))
    const read = await fresh.readBirthData()
    expect(read?.year).toBe(2000)
    expect(read?.month).toBe(6)
    expect(read?.day).toBe(15)
    expect(read?.hour).toBe(8)
    expect(read?.gender).toBe('male')
    rmSync(dir, { recursive: true, force: true })
  })

  it('clearBirthData removes the block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-birth-clear-'))
    const settings = new Settings(join(dir, 'settings.json'))
    await settings.writeBirthData({ year: 1999, month: 1, day: 1 })
    expect((await settings.readBirthData())?.year).toBe(1999)
    await settings.clearBirthData()
    expect(await settings.readBirthData()).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes a malformed birth block away (out-of-range date dropped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-birth-bad-'))
    const file = join(dir, 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        llm: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
        birthData: {
          year: 1800, // out of [1900,2100] → whole block dropped
          month: 6,
          day: 15,
          hour: 25, // out of [0,23] → hour dropped (but block already gone)
          gender: 'other' // not male/female → dropped
        }
      }),
      'utf8'
    )
    const settings = new Settings(file)
    const birth = await settings.readBirthData()
    expect(birth).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes partial fields: bad hour/gender dropped, valid core kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-birth-partial-'))
    const file = join(dir, 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        llm: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
        birthData: {
          year: 2000,
          month: 6,
          day: 15,
          hour: 25, // out of [0,23] → dropped
          gender: 'other' // not male/female → dropped
        }
      }),
      'utf8'
    )
    const settings = new Settings(file)
    const birth = await settings.readBirthData()
    expect(birth?.year).toBe(2000)
    expect(birth?.month).toBe(6)
    expect(birth?.day).toBe(15)
    expect(birth?.hour).toBeUndefined()
    expect(birth?.gender).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})
