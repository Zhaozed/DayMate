import { describe, it, expect } from 'vitest'
import { firstAngleToken, synthesizeThreadId } from '../../src/main/providers/email/mail163-provider'
import { normalizeRfc822ViaParser, type ParsedMailLike } from '../../src/main/providers/email/mail-mime'

// ADR 0029 — 163 has no native threadId, so the provider synthesizes one from
// RFC822 threading headers (References / In-Reply-To / Message-Id). The key
// is the conversation ROOT's Message-Id (shared by every reply via the first
// References token), so emails in the same thread collapse into one 必读 item.
// This file exercises the pure synthesis helpers over real parsed headers.

async function parse(headers: Record<string, string>): Promise<ParsedMailLike> {
  // Build a minimal RFC822 from headers + parse it, so the mailparser headers
  // map (the same surface `toNormalized` reads) is exercised end-to-end.
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  const raw = `${lines}\r\n\r\nbody\r\n`
  return normalizeRfc822ViaParser(Buffer.from(raw, 'utf8'))
}

describe('firstAngleToken', () => {
  it('extracts the first <...> token', () => {
    expect(firstAngleToken('<abc@root> <def@reply>')).toBe('abc@root')
  })
  it('returns the bare id without angle brackets', () => {
    expect(firstAngleToken('<abc@root>')).toBe('abc@root')
  })
  it('returns undefined when no angle-bracket token', () => {
    expect(firstAngleToken('plain text')).toBeUndefined()
    expect(firstAngleToken(undefined)).toBeUndefined()
    expect(firstAngleToken('')).toBeUndefined()
  })
})

describe('synthesizeThreadId', () => {
  it('uses the FIRST References token (the conversation root, shared by every reply)', async () => {
    const root = '<root-msg@example.com>'
    const parsed = await parse({
      'Message-Id': '<reply-1@example.com>',
      References: `${root} <mid@example.com>`,
      'In-Reply-To': root
    })
    expect(synthesizeThreadId(parsed)).toBe('root-msg@example.com')
  })

  it('falls back to In-Reply-To when References is absent', async () => {
    const parsed = await parse({
      'Message-Id': '<reply-2@example.com>',
      'In-Reply-To': '<parent@example.com>'
    })
    expect(synthesizeThreadId(parsed)).toBe('parent@example.com')
  })

  it('falls back to the message own Message-Id for the root (no References / In-Reply-To)', async () => {
    const parsed = await parse({ 'Message-Id': '<the-root@example.com>' })
    expect(synthesizeThreadId(parsed)).toBe('the-root@example.com')
  })

  it('returns undefined when no threading headers at all', async () => {
    const parsed = await parse({ Subject: 'a standalone message with no ids' })
    expect(synthesizeThreadId(parsed)).toBeUndefined()
  })

  it('two replies to the same root synthesize the SAME threadId', async () => {
    const root = '<root@example.com>'
    const r1 = synthesizeThreadId(
      await parse({ 'Message-Id': '<r1@example.com>', References: `${root} <x@example.com>` })
    )
    const r2 = synthesizeThreadId(
      await parse({ 'Message-Id': '<r2@example.com>', References: `${root} <y@example.com>` })
    )
    expect(r1).toBe(r2)
    expect(r1).toBe('root@example.com')
  })
})
