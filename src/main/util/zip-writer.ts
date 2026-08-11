// Minimal ZIP writer — STORED (no compression) method only.
//
// The 投递 data export (Milestone D §D3) zips a handful of JSON dumps. The
// data volume is tens-to-hundreds of rows, so compression buys little; a
// STORED-only writer is universally compatible (Archive Utility, unzip, 7z,
// python zipfile all read method 0) and needs NO new dependency (Spec §23
// rule 2 — consistent with the hand-rolled SVG/div charts in Milestone B and
// the hand-rolled Gmail REST in the post-MVP pass).
//
// Format reference: PKZIP APPNOTE 6.3.x. We write, per entry:
//   - Local file header (sig 0x04034b50)
//   - Uncompressed bytes (verbatim)
// Then one central-directory header per entry (sig 0x02014b50) + end-of-
// central-directory record (sig 0x06054b50). CRC32 via a precomputed table.
//
// Names are ASCII-safe (the export uses stable ASCII file names). Time is
// injected by the caller via `fixedDate` so the writer is deterministic in
// tests (the workflow-script `Date.now()` restriction does not apply here —
// this is normal main-process code, but determinism is still nice for tests).

export interface ZipEntry {
  /** ASCII-safe file name, e.g. "applications.json". */
  name: string
  /** File contents. */
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Encode a string as UTF-8 bytes. */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Write a 16-bit little-endian uint into buf at offset. */
function u16(buf: number[], offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

/** Write a 32-bit little-endian uint into buf at offset. */
function u32(buf: number[], offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

/** DOS date/time fields for the central directory. Caller passes a fixed
 *  Date so the output is deterministic in tests. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  }
}

export interface ZipOptions {
  /** Fixed timestamp for every entry (deterministic output in tests). */
  fixedDate?: Date
}

/** Build a ZIP archive buffer from entries (STORED method, no compression). */
export function writeZip(entries: ZipEntry[], opts: ZipOptions = {}): Uint8Array {
  const stamp = opts.fixedDate ?? new Date()
  const { time, date } = dosTime(stamp)

  const localChunks: Uint8Array[] = []
  const central: number[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = utf8(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length
    // Name length must fit in 16 bits (it always will for our ASCII file names).
    const nameLen = nameBytes.length

    // Local file header — 30 bytes + name.
    const lh = new Array<number>(30)
    u32(lh, 0, 0x04034b50) // signature
    u16(lh, 4, 20) // version needed to extract (2.0)
    u16(lh, 6, 0) // general purpose bit flag
    u16(lh, 8, 0) // compression method (0 = stored)
    u16(lh, 10, time)
    u16(lh, 12, date)
    u32(lh, 14, crc)
    u32(lh, 18, size) // compressed size == uncompressed (stored)
    u32(lh, 22, size)
    u16(lh, 26, nameLen)
    u16(lh, 28, 0) // extra field length
    localChunks.push(new Uint8Array(lh), nameBytes, entry.data)

    // Central directory header — 46 bytes + name.
    const ch = new Array<number>(46)
    u32(ch, 0, 0x02014b50) // signature
    u16(ch, 4, 20) // version made by
    u16(ch, 6, 20) // version needed
    u16(ch, 8, 0) // flags
    u16(ch, 10, 0) // method
    u16(ch, 12, time)
    u16(ch, 14, date)
    u32(ch, 16, crc)
    u32(ch, 20, size) // compressed
    u32(ch, 24, size) // uncompressed
    u16(ch, 28, nameLen)
    u16(ch, 30, 0) // extra
    u16(ch, 32, 0) // comment
    u16(ch, 34, 0) // disk number start
    u16(ch, 36, 0) // internal attrs
    u32(ch, 38, 0) // external attrs
    u32(ch, 42, offset) // local header offset
    for (const b of ch) central.push(b)
    for (const b of nameBytes) central.push(b)

    offset += 30 + nameLen + size
  }

  // End of central directory record — 22 bytes.
  const centralSize = central.length
  const eocd = new Array<number>(22)
  u32(eocd, 0, 0x06054b50) // signature
  u16(eocd, 4, 0) // disk number
  u16(eocd, 6, 0) // disk with central dir
  u16(eocd, 8, entries.length) // entries on this disk
  u16(eocd, 10, entries.length) // total entries
  u32(eocd, 12, centralSize)
  u32(eocd, 16, offset) // central dir offset
  u16(eocd, 20, 0) // comment length

  // Assemble.
  const total =
    localChunks.reduce((n, c) => n + c.length, 0) + central.length + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of localChunks) {
    out.set(c, p)
    p += c.length
  }
  out.set(new Uint8Array(central), p)
  p += central.length
  out.set(new Uint8Array(eocd), p)
  return out
}
