import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '../../src/main/util/secrets'
import {
  GmailProvider,
  normalizeGmailMessage,
  buildRfc822,
  stripHtml,
  parseAddresses,
  decodeBase64Url,
  type GmailMessageRaw
} from '../../src/main/providers/email/gmail-provider'
import { startCallbackServer, newState } from '../../src/main/providers/email/gmail-oauth'
import type { EmailDraftInput } from '@shared/types'

// Real Gmail provider (Spec §9). These tests exercise the pure transforms +
// SecretStore wiring + the OAuth loopback callback parsing — NO network. The
// end-to-end read/draft/send path is gated by the Integrations `Test` button,
// which needs user-supplied OAuth credentials (never hardcoded here).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daymate-gmail-'))
})

function makeProvider(): GmailProvider {
  const secrets = new SecretStore(join(dir, 'secrets.json'))
  return new GmailProvider({ secrets, openExternal: async () => {} })
}

describe('decodeBase64Url', () => {
  it('decodes base64url with and without padding', () => {
    // "Hello" in base64url: SGVsbG8
    expect(decodeBase64Url('SGVsbG8')).toBe('Hello')
    // gmail often omits padding
    expect(decodeBase64Url('SGVsbG8')).toBe(decodeBase64Url('SGVsbG8='))
  })
  it('decodes utf-8 multibyte', () => {
    const encoded = Buffer.from('héllo 世界', 'utf8').toString('base64url')
    expect(decodeBase64Url(encoded)).toBe('héllo 世界')
  })
})

describe('stripHtml', () => {
  it('strips tags and never executes scripts/styles (Spec §17.13)', () => {
    const html = '<style>.x{color:red}</style><script>alert(1)</script><p>Hi <b>there</b></p>'
    expect(stripHtml(html)).toBe('Hi there')
  })
  it('decodes common entities', () => {
    expect(stripHtml('a&nbsp;&amp;&lt;&gt;b')).toBe('a &<>b')
  })
})

describe('parseAddresses', () => {
  it('parses name + angle address', () => {
    const [a] = parseAddresses('Alice <alice@example.com>')
    expect(a).toEqual({ name: 'Alice', address: 'alice@example.com' })
  })
  it('parses bare address', () => {
    const [a] = parseAddresses('bob@example.com')
    expect(a).toEqual({ address: 'bob@example.com' })
  })
  it('parses multiple comma-separated', () => {
    expect(parseAddresses('Alice <alice@example.com>, bob@example.com')).toHaveLength(2)
  })
  it('empty string → []', () => {
    expect(parseAddresses('')).toEqual([])
  })
  it('strips surrounding quotes from names', () => {
    const [a] = parseAddresses('"Alice" <alice@example.com>')
    expect(a).toEqual({ name: 'Alice', address: 'alice@example.com' })
  })
})

describe('normalizeGmailMessage', () => {
  const msg = (overrides: Partial<GmailMessageRaw> = {}): GmailMessageRaw => ({
    id: 'msg-1',
    threadId: 'thr-1',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1700000000000',
    payload: {
      headers: [
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'bob@example.com' },
        { name: 'Cc', value: 'carol@example.com' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Date', value: 'Wed, 15 Nov 2023 10:00:00 +0000' }
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('plain body', 'utf8').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<p>html body</p>', 'utf8').toString('base64url') } }
      ]
    },
    ...overrides
  })

  it('prefers text/plain over text/html', () => {
    const n = normalizeGmailMessage(msg(), 'gmail-real')
    expect(n.textBody).toBe('plain body')
  })
  it('falls back to stripped html when no text/plain', () => {
    const m = msg()
    m.payload!.parts = [{ mimeType: 'text/html', body: { data: Buffer.from('<p>html only</p>', 'utf8').toString('base64url') } }]
    expect(normalizeGmailMessage(m, 'gmail-real').textBody).toBe('html only')
  })
  it('maps UNREAD label → unread:true', () => {
    expect(normalizeGmailMessage(msg(), 'gmail-real').unread).toBe(true)
  })
  it('uses internalDate for receivedAt', () => {
    expect(normalizeGmailMessage(msg(), 'gmail-real').receivedAt).toBe(
      new Date(1700000000000).toISOString()
    )
  })
  it('extracts from/to/cc and subject', () => {
    const n = normalizeGmailMessage(msg(), 'gmail-real')
    expect(n.from).toEqual({ name: 'Alice', address: 'alice@example.com' })
    expect(n.to).toEqual([{ address: 'bob@example.com' }])
    expect(n.cc).toEqual([{ address: 'carol@example.com' }])
    expect(n.subject).toBe('Hello')
    expect(n.messageId).toBe('msg-1')
    expect(n.threadId).toBe('thr-1')
    expect(n.accountId).toBe('gmail-real')
    expect(n.unread).toBe(true)
  })
  it('falls back to snippet when no extractable body', () => {
    const m = msg()
    m.payload = { headers: m.payload!.headers }
    m.snippet = 'a snippet'
    expect(normalizeGmailMessage(m, 'gmail-real').textBody).toBe('a snippet')
  })
  it('builds a gmail source url', () => {
    expect(normalizeGmailMessage(msg(), 'gmail-real').sourceUrl).toContain('msg-1')
  })
})

describe('buildRfc822', () => {
  const input: EmailDraftInput = {
    accountId: 'gmail-real',
    threadId: 'thr-1',
    to: [{ name: 'Alice', address: 'alice@example.com' }],
    cc: [{ address: 'carol@example.com' }],
    subject: 'Re: Hello',
    body: 'Thanks — will reply soon.'
  }

  it('produces base64url of a valid RFC822 with the right headers', () => {
    const raw = buildRfc822(input)
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('To: Alice <alice@example.com>')
    expect(decoded).toContain('Cc: carol@example.com')
    expect(decoded).toContain('Subject: Re: Hello')
    expect(decoded).toContain('In-Reply-To: thr-1')
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8')
    expect(decoded).toContain('MIME-Version: 1.0')
    expect(decoded).toContain('Thanks — will reply soon.')
    // CRLF line separators
    expect(decoded).toContain('\r\n')
  })
  it('RFC 2047-encodes non-ASCII subjects', () => {
    const raw = buildRfc822({ ...input, subject: '回复' })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('Subject: =?utf-8?B?')
  })
})

describe('GmailProvider SecretStore wiring (no network)', () => {
  it('reports disconnected with no client + no tokens', async () => {
    const p = makeProvider()
    expect(await p.getStatus()).toBe('disconnected')
    expect(await p.hasClient()).toBe(false)
    expect(await p.getEmailAddress()).toBeUndefined()
  })
  it('persists + retains client creds across a fresh provider instance', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    const p = new GmailProvider({ secrets, openExternal: async () => {} })
    await p.setClient('cid-123', 'sec-456')
    expect(await p.hasClient()).toBe(true)
    // New provider on the same store sees the saved client.
    const p2 = new GmailProvider({ secrets, openExternal: async () => {} })
    expect(await p2.hasClient()).toBe(true)
  })
  it('stores and reads back a tokens blob (simulated post-connect state)', async () => {
    // We can't call connect() without a real browser + Google; but we can prove
    // the token persistence path works by round-tripping through the same
    // SecretStore key the provider uses internally.
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    // Mirror the provider's internal tokens key.
    await secrets.save('gmail', JSON.stringify({
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
      expiresAt: Date.now() + 3_600_000,
      emailAddress: 'me@example.com'
    }))
    const p = new GmailProvider({ secrets, openExternal: async () => {} })
    expect(await p.getStatus()).toBe('connected')
    expect(await p.getEmailAddress()).toBe('me@example.com')
  })
})

describe('OAuth loopback callback server', () => {
  it('resolves {code, state} on a valid callback', async () => {
    const cb = await startCallbackServer()
    const state = newState()
    // redirectUri already includes /callback; append the query directly.
    const res = await fetch(`${cb.redirectUri}?code=ACODE&state=${state}`)
    expect(res.ok).toBe(true)
    const result = await cb.waitForCode()
    expect(result.code).toBe('ACODE')
    expect(result.state).toBe(state)
    cb.close()
  })
  it('rejects on state mismatch is handled by the caller, not the server', async () => {
    // The server returns whatever state Google sent; the caller (connect) checks
    // it against its own. Here we just verify the server surfaces the value.
    const cb = await startCallbackServer()
    await fetch(`${cb.redirectUri}?code=ACODE&state=server-state`)
    const result = await cb.waitForCode()
    expect(result.state).toBe('server-state')
    cb.close()
  })
  it('rejects on error param', async () => {
    const cb = await startCallbackServer()
    // Attach the assertion before the fetch — the request handler rejects
    // synchronously, so the promise needs a handler up front.
    const assertion = expect(cb.waitForCode()).rejects.toThrow(/access_denied/)
    const res = await fetch(`${cb.redirectUri}?error=access_denied`)
    await res.text() // consume the body so the socket drains cleanly
    await assertion
    cb.close()
  })
  it('rejects when code or state is missing', async () => {
    const cb = await startCallbackServer()
    const assertion = expect(cb.waitForCode()).rejects.toThrow(/缺少 code\/state/)
    const res = await fetch(`${cb.redirectUri}?code=ACODE`) // no state
    await res.text()
    await assertion
    cb.close()
  })
})
