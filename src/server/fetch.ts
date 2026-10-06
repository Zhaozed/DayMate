import type { GmailFetch } from '../main/providers/email/gmail-oauth'

/**
 * Creates a fetch implementation. If `proxyUrl` is omitted or empty,
 * returns standard globalThis.fetch. If `proxyUrl` is configured, dynamically
 * delegates to undici ProxyAgent.
 */
export function createProxyFetch(proxyUrl?: string): GmailFetch {
  const url = proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (!url || url.trim().length === 0) {
    return (input: string, init?: Parameters<typeof fetch>[1]) => {
      return globalThis.fetch(input, init)
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetch: undiciFetch, ProxyAgent } = require('undici')
    const dispatcher = new ProxyAgent(url)
    return ((input: string, init?: Parameters<typeof fetch>[1]) => {
      return undiciFetch(input, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
    }) as unknown as GmailFetch
  } catch {
    console.warn('[proxy] Proxy configured but undici ProxyAgent unavailable; falling back to global fetch.')
    return (input: string, init?: Parameters<typeof fetch>[1]) => {
      return globalThis.fetch(input, init)
    }
  }
}
