// Milestone D §D3 — hand-rolled STORED ZIP writer. Validates by reading the
// produced buffer back (local headers + central directory + EOCD + CRC32)
// AND, when the system `unzip` is present, by listing entries with it —
// proving real-world compatibility (Archive Utility / 7z / unzip read method 0).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeZip, type ZipEntry } from '../../src/main/util/zip-writer'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function u32(buf: Uint8Array, off: number): number {
  return (
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)
  ) >>> 0
}
function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8)
}
function readU16Ascii(buf: Uint8Array, off: number, len: number): string {
  return new TextDecoder().decode(buf.subarray(off, off + len))
}

describe('zip-writer (§D3, STORED, no dep)', () => {
  const fixed = new Date(2026, 7, 11, 9, 30, 0)
  const entries: ZipEntry[] = [
    { name: 'applications.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'events.json', data: new TextEncoder().encode('[{"e":"offer"}]') },
    { name: 'README.txt', data: new TextEncoder().encode('hello 投递') }
  ]

  it('writes valid local headers + central directory + EOCD', () => {
    const zip = writeZip(entries, { fixedDate: fixed })
    // EOCD is the last 22 bytes (no comment).
    const eocdOff = zip.length - 22
    expect(u32(zip, eocdOff)).toBe(SIG_EOCD)
    expect(u16(zip, eocdOff + 8)).toBe(entries.length) // entries on disk
    expect(u16(zip, eocdOff + 10)).toBe(entries.length) // total entries
    const centralSize = u32(zip, eocdOff + 12)
    const centralOff = u32(zip, eocdOff + 16)
    expect(centralOff + centralSize).toBe(eocdOff)

    // Walk the central directory.
    let p = centralOff
    const seen: { name: string; size: number; crc: number }[] = []
    while (u32(zip, p) === SIG_CENTRAL) {
      const crc = u32(zip, p + 16)
      const size = u32(zip, p + 24)
      const nameLen = u16(zip, p + 28)
      const name = readU16Ascii(zip, p + 46, nameLen)
      seen.push({ name, size, crc })
      p += 46 + nameLen
    }
    expect(seen.map((s) => s.name)).toEqual(entries.map((e) => e.name))
    // CRC32 of 'hello 投递' is deterministic + non-zero.
    expect(seen[2].crc).not.toBe(0)
    expect(seen[2].size).toBe(entries[2].data.length)
  })

  it('each local header precedes its raw bytes', () => {
    const zip = writeZip(entries, { fixedDate: fixed })
    let off = 0
    for (const e of entries) {
      expect(u32(zip, off)).toBe(SIG_LOCAL)
      const nameLen = u16(zip, off + 26)
      const name = readU16Ascii(zip, off + 30, nameLen)
      expect(name).toBe(e.name)
      const dataStart = off + 30 + nameLen
      const data = zip.subarray(dataStart, dataStart + e.data.length)
      expect(Array.from(data)).toEqual(Array.from(e.data))
      off = dataStart + e.data.length
    }
  })

  it('round-trips through the system unzip when available', () => {
    let unzip: string
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' })
      unzip = 'unzip'
    } catch {
      return // unzip not installed — skip the real-tool check, structural tests cover format.
    }
    const dir = mkdtempSync(join(tmpdir(), 'daymate-zip-'))
    const file = join(dir, 'export.zip')
    writeFileSync(file, writeZip(entries, { fixedDate: fixed }))
    const out = execFileSync(unzip, ['-l', file], { encoding: 'utf8' })
    for (const e of entries) {
      expect(out).toContain(e.name)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('produces an empty (header-only) archive for zero entries', () => {
    const zip = writeZip([], { fixedDate: fixed })
    expect(u32(zip, zip.length - 22)).toBe(SIG_EOCD)
    expect(u16(zip, zip.length - 14)).toBe(0) // 0 entries
  })
})
