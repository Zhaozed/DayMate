import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '../../src/main/util/secrets'
import { Mail163Provider } from '../../src/main/providers/email/mail163-provider'
import { buildRfc822Raw, normalizeRfc822ViaParser } from '../../src/main/providers/email/mail-mime'
import type { EmailDraftInput } from '@shared/types'

// Real 163 Mail provider (Spec §9). These tests exercise the pure RFC822
// building, the mailparser-based normalization, and the SecretStore wiring —
// NO IMAP/SMTP network. The end-to-end read/send path is gated by the
// Integrations `Test` button, which needs a real 授权码 (never hardcoded).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daymate-mail163-'))
})

function makeProvider(): Mail163Provider {
  const secrets = new SecretStore(join(dir, 'secrets.json'))
  return new Mail163Provider({ secrets })
}

const draftInput: EmailDraftInput = {
  accountId: 'mail163-real',
  to: [{ name: 'Alice', address: 'alice@example.com' }, { address: 'bob@example.com' }],
  cc: [{ name: 'Carl', address: 'carl@example.com' }],
  subject: 'Contract amendment',
  body: 'Hi Alice, please confirm the amendment.\nThanks.'
}

describe('buildRfc822Raw', () => {
  it('builds headers with CRLF line endings', () => {
    const raw = buildRfc822Raw(draftInput)
    expect(raw).toContain('\r\n')
    expect(raw.startsWith('To: Alice <alice@example.com>, bob@example.com\r\n')).toBe(true)
  })

  it('includes Cc, Subject, content-type, and body', () => {
    const raw = buildRfc822Raw(draftInput)
    expect(raw).toContain('Cc: Carl <carl@example.com>')
    expect(raw).toContain('Subject: Contract amendment')
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8')
    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain('please confirm the amendment.')
  })

  it('encodes non-ASCII subjects per RFC 2047', () => {
    const raw = buildRfc822Raw({ ...draftInput, subject: '回复：合同修订' })
    expect(raw).toContain('Subject: =?utf-8?B?')
    // The decoded subject round-trips.
    const encoded = raw.match(/Subject: (=\?utf-8\?B\?[^?]+\?=)/)![1]
    const decoded = Buffer.from(encoded.slice('=?utf-8?B?'.length, -2), 'base64').toString('utf8')
    expect(decoded).toBe('回复：合同修订')
  })

  it('omits Cc when none provided', () => {
    const raw = buildRfc822Raw({ ...draftInput, cc: undefined })
    expect(raw).not.toContain('Cc:')
  })

  it('adds In-Reply-To for a thread', () => {
    const raw = buildRfc822Raw({ ...draftInput, threadId: '<orig@example.com>' })
    expect(raw).toContain('In-Reply-To: <orig@example.com>')
  })
})

describe('normalizeRfc822ViaParser', () => {
  it('parses a synthesized RFC822 message into structured fields', async () => {
    const raw = buildRfc822Raw(draftInput)
    const parsed = await normalizeRfc822ViaParser(Buffer.from(raw, 'utf8'))
    expect(parsed.subject).toBe('Contract amendment')
    expect(parsed.text).toContain('please confirm the amendment.')
    expect(parsed.from.value ?? []).toHaveLength(0) // no From header in drafts
    expect(parsed.to?.value).toHaveLength(2)
    expect(parsed.to?.value?.[0]?.name).toBe('Alice')
    expect(parsed.to?.value?.[0]?.address).toBe('alice@example.com')
    expect(parsed.to?.value?.[1]?.address).toBe('bob@example.com')
    expect(parsed.cc?.value?.[0]?.address).toBe('carl@example.com')
  })

  it('parses an inbound message with From/Date/Message-Id', async () => {
    const raw = [
      'From: Bob Li <bob@163.com>',
      'To: me@163.com',
      'Subject: Re: contract amendment',
      'Date: Tue, 5 Aug 2025 09:00:00 +0800',
      'Message-ID: <abc@163.com>',
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      'Following up — please reply today.'
    ].join('\r\n')
    const parsed = await normalizeRfc822ViaParser(Buffer.from(raw, 'utf8'))
    expect(parsed.from.value?.[0]?.name).toBe('Bob Li')
    expect(parsed.from.value?.[0]?.address).toBe('bob@163.com')
    expect(parsed.subject).toBe('Re: contract amendment')
    expect(parsed.text).toBe('Following up — please reply today.')
    expect(parsed.messageId).toBe('<abc@163.com>')
    expect(parsed.date?.getFullYear()).toBe(2025)
  })

  it('prefers text/plain over text/html (never executes HTML)', async () => {
    const raw = [
      'From: sp <sp@163.com>',
      'To: me@163.com',
      'Subject: mixed',
      'Content-Type: multipart/alternative; boundary="b"',
      'MIME-Version: 1.0',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain body',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p><script>evil()</script>html body</p>',
      '--b--',
      ''
    ].join('\r\n')
    const parsed = await normalizeRfc822ViaParser(Buffer.from(raw, 'utf8'))
    expect(parsed.text).toContain('plain body')
    expect(parsed.text).not.toContain('<script>')
    expect(parsed.text).not.toContain('evil()')
  })
})

describe('Mail163Provider credentials', () => {
  it('starts disconnected with no client', async () => {
    const p = makeProvider()
    expect(await p.getStatus()).toBe('disconnected')
    expect(await p.hasClient()).toBe(false)
    expect(await p.getEmailAddress()).toBeUndefined()
  })

  it('persists email + 授权码 in the SecretStore (not in source)', async () => {
    const p = makeProvider()
    await p.setClient('me@163.com', 'AUTHCODE123456')
    expect(await p.hasClient()).toBe(true)
    expect(await p.getStatus()).toBe('connected')
    expect(await p.getEmailAddress()).toBe('me@163.com')
    // The 授权码 is stored encrypted and never exposed via the provider API.
  })

  it('round-trips across a new provider instance (persisted to disk)', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    const p1 = new Mail163Provider({ secrets })
    await p1.setClient('you@163.com', 'CODE999')
    const p2 = new Mail163Provider({ secrets })
    expect(await p2.hasClient()).toBe(true)
    expect(await p2.getEmailAddress()).toBe('you@163.com')
  })

  it('disconnect clears the client', async () => {
    const p = makeProvider()
    await p.setClient('me@163.com', 'AUTHCODE123456')
    expect(await p.hasClient()).toBe(true)
    await p.disconnect()
    expect(await p.hasClient()).toBe(false)
    expect(await p.getStatus()).toBe('disconnected')
    expect(await p.getEmailAddress()).toBeUndefined()
  })

  it('connect throws when not configured (no 授权码)', async () => {
    const p = makeProvider()
    await expect(p.connect()).rejects.toThrow(/未配置/)
  })

  it('getClient throws on a malformed stored client', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    await secrets.save('mail163-client', '{"email":""}') // missing authCode
    const p = new Mail163Provider({ secrets })
    expect(await p.getEmailAddress()).toBe('') // email field present but client misconfigured for connect
    await expect(p.connect()).rejects.toThrow(/配置无效/)
  })
})
