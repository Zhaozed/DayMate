import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { GmailFetch } from '../main/providers/email/gmail-oauth'

/**
 * Creates a fetch implementation that routes through a proxy (e.g. SOCKS5/HTTP proxy on 127.0.0.1:7890)
 * when `proxyUrl` is configured. If `proxyUrl` is omitted, returns the standard global fetch.
 */
export function createProxyFetch(proxyUrl?: string): GmailFetch {
  const url = proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (!url || url.trim().length === 0) {
    return globalThis.fetch
  }
  const dispatcher = new ProxyAgent(url)
  return ((input: string, init?: Parameters<typeof fetch>[1]) => {
    return undiciFetch(input, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
  }) as unknown as GmailFetch
}
