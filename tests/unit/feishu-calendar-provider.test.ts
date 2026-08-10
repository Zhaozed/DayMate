import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '../../src/main/util/secrets'
import { FeishuCalendarProvider } from '../../src/main/providers/calendar/feishu-calendar-provider'
import {
  authorizeUrl,
  newState,
  startCallbackServer,
  FEISHU_REDIRECT_URI,
  type FeishuFetch
} from '../../src/main/providers/calendar/feishu-oauth'

// Real Feishu Calendar provider (Spec §10). These tests exercise the OAuth URL
// building, the loopback callback parsing, the SecretStore wiring, and event
// normalization — NO network. The end-to-end read path is gated by the
// Integrations `Test` button, which needs a real Feishu self-built app +
// user consent (never hardcoded here).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daymate-feishu-'))
})

function makeProvider(): FeishuCalendarProvider {
  const secrets = new SecretStore(join(dir, 'secrets.json'))
  return new FeishuCalendarProvider({ secrets, openExternal: async () => {} })
}

/** A mock FeishuFetch that routes by URL substring to canned JSON. */
function mockFetch(routes: Record<string, unknown>): FeishuFetch {
  const mk = (body: unknown): unknown => ({ json: async () => body })
  return ((input: string) => {
    const url = String(input)
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) return Promise.resolve(mk(routes[key]))
    }
    return Promise.resolve(mk({ code: -1, msg: `no mock for ${url}` }))
  }) as unknown as FeishuFetch
}

describe('authorizeUrl / state', () => {
  it('builds the authorize URL with app_id, redirect_uri, state', () => {
    const url = authorizeUrl({ appId: 'cli_test', appSecret: 'sec' }, 'st123')
    expect(url).toContain('/open-apis/authen/v1/authorize')
    expect(url).toContain('app_id=cli_test')
    expect(url).toContain(`redirect_uri=${encodeURIComponent(FEISHU_REDIRECT_URI)}`)
    expect(url).toContain('state=st123')
    expect(url).toContain('always_reload=true')
  })

  it('state is a 32-char hex string and unique', () => {
    const a = newState()
    const b = newState()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('startCallbackServer', () => {
  it('resolves with code + state on a valid callback', async () => {
    const state = newState()
    const cb = await startCallbackServer(state)
    try {
      const assertion = expect(cb.waitForCode()).resolves.toEqual({ code: 'abc', state })
      const res = await fetch(`${FEISHU_REDIRECT_URI}?code=abc&state=${state}`)
      await res.text()
      await assertion
    } finally {
      cb.close()
    }
  })

  it('rejects on an error param (user denied)', async () => {
    const state = newState()
    const cb = await startCallbackServer(state)
    try {
      const assertion = expect(cb.waitForCode()).rejects.toThrow(/denied/)
      const res = await fetch(`${FEISHU_REDIRECT_URI}?error=access_denied&state=${state}`)
      await res.text()
      await assertion
    } finally {
      cb.close()
    }
  })

  it('rejects on a state mismatch (CSRF)', async () => {
    const state = newState()
    const cb = await startCallbackServer(state)
    try {
      const assertion = expect(cb.waitForCode()).rejects.toThrow(/状态不匹配|CSRF/)
      const res = await fetch(`${FEISHU_REDIRECT_URI}?code=abc&state=wrong`)
      await res.text()
      await assertion
    } finally {
      cb.close()
    }
  })
})

describe('FeishuCalendarProvider credentials', () => {
  it('starts disconnected with no client', async () => {
    const p = makeProvider()
    expect(await p.getStatus()).toBe('disconnected')
    expect(await p.hasClient()).toBe(false)
  })

  it('persists app_id/app_secret in the SecretStore', async () => {
    const p = makeProvider()
    await p.setClient('cli_x', 'secret_y')
    expect(await p.hasClient()).toBe(true)
    // connected requires user tokens too (not just client) — so still
    // disconnected until Connect runs the OAuth flow.
    expect(await p.getStatus()).toBe('disconnected')
  })

  it('round-trips across a new provider instance', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    const p1 = new FeishuCalendarProvider({ secrets, openExternal: async () => {} })
    await p1.setClient('cli_x', 'secret_y')
    const p2 = new FeishuCalendarProvider({ secrets, openExternal: async () => {} })
    expect(await p2.hasClient()).toBe(true)
  })

  it('disconnect clears client + tokens', async () => {
    const p = makeProvider()
    await p.setClient('cli_x', 'secret_y')
    expect(await p.hasClient()).toBe(true)
    await p.disconnect()
    expect(await p.hasClient()).toBe(false)
    expect(await p.getStatus()).toBe('disconnected')
  })

  it('listEvents throws when not configured (no app creds)', async () => {
    const p = makeProvider()
    await expect(
      p.listEvents({ start: new Date().toISOString(), end: new Date().toISOString() })
    ).rejects.toThrow(/未配置/)
  })

  it('createEvent/updateEvent throw (R2 writes deferred)', async () => {
    const p = makeProvider()
    await expect(p.createEvent({ title: 'x', start: '', end: '' })).rejects.toThrow(/deferred|R2/i)
    await expect(p.updateEvent('e', { title: 'x' })).rejects.toThrow(/deferred|R2/i)
  })
})

describe('FeishuCalendarProvider token + event flow (mocked API)', () => {
  // Wire a provider whose `http` is a mock by injecting via the deps.fetch.
  // Returns the SAME SecretStore the provider holds so tests can plant user
  // tokens through it (in tests safeStorage is absent → the store falls back
  // to an in-memory map that is NEVER written to disk, so a second SecretStore
  // pointing at the same path would NOT see tokens planted by the other).
  function makeProviderWithMock(
    routes: Record<string, unknown>
  ): { p: FeishuCalendarProvider; secrets: SecretStore } {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    const p = new FeishuCalendarProvider({
      secrets,
      openExternal: async () => {},
      fetch: mockFetch(routes)
    })
    return { p, secrets }
  }

  it('listEvents reads the primary calendar and normalizes events', async () => {
    const { p, secrets } = makeProviderWithMock({
      // Order matters: the events URL `.../calendars/cal_primary/events?...`
      // contains the substring `/calendar/v6/calendars`, so the `/events` route
      // must be matched FIRST (Object.keys preserves insertion order).
      // events list
      '/events': {
        code: 0,
        data: {
          items: [
            {
              event_id: 'evt_1',
              summary: 'Standup',
              start: { timestamp: '1700000000' },
              end: { timestamp: '1700001800' },
              location: { name: 'Room A' },
              attendees: [{ display_name: 'Bob', email: 'bob@x.com' }]
            }
          ],
          has_more: false
        }
      },
      // primary calendar list
      '/calendar/v6/calendars': {
        code: 0,
        data: {
          calendar_list: [
            { calendar_id: 'cal_primary', summary: 'My Calendar', is_primary: true }
          ]
        }
      }
    })
    await p.setClient('cli_x', 'secret_y')
    // Plant a stored user token via the provider's OWN store so
    // ensureUserToken short-circuits (no refresh / no network).
    await secrets.save(
      'feishu-user-tokens',
      JSON.stringify({ accessToken: 'user_tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 })
    )

    const events = await p.listEvents({ start: '2023-01-01T00:00:00Z', end: '2023-12-31T00:00:00Z' })
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.title).toBe('Standup')
    expect(e.location).toBe('Room A')
    expect(e.eventId).toBe('cal_primary:evt_1') // composite id
    expect(e.attendees[0]).toEqual({ name: 'Bob', address: 'bob@x.com' })
    expect(new Date(e.start).getTime()).toBe(1700000000 * 1000)
  })

  it('listEvents throws if no accessible calendar', async () => {
    const { p, secrets } = makeProviderWithMock({
      '/calendar/v6/calendars': { code: 0, data: { calendar_list: [] } }
    })
    await p.setClient('cli_x', 'secret_y')
    await secrets.save(
      'feishu-user-tokens',
      JSON.stringify({ accessToken: 'user_tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 })
    )
    await expect(
      p.listEvents({ start: '2023-01-01T00:00:00Z', end: '2023-12-31T00:00:00Z' })
    ).rejects.toThrow(/没有可访问的日历/)
  })

  it('listEvents throws clearly when the user is not connected (no refresh token)', async () => {
    const { p } = makeProviderWithMock({})
    await p.setClient('cli_x', 'secret_y') // client set but no user tokens
    await expect(
      p.listEvents({ start: '2023-01-01T00:00:00Z', end: '2023-12-31T00:00:00Z' })
    ).rejects.toThrow(/未连接/)
  })
})
