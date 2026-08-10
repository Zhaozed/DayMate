// Shared MIME helpers for the real email providers (Spec §9, §17.12/§17.13).
//
// `buildRfc822Raw` composes a minimal RFC822 message (text/plain, UTF-8, RFC2047
// encoded subjects) — used by 163's IMAP APPEND + SMTP `raw` send (and is the
// raw form of what Gmail base64url-encodes in gmail-provider).
//
// `normalizeRfc822ViaParser` runs mailparser's `simpleParser` on a raw message
// buffer and returns a small structural subset, so the 163 provider never
// re-implements MIME decoding. Text is preferred over HTML (text/plain), and
// HTML is never executed — only stripped to text by mailparser.

import type { EmailDraftInput, MailAddress } from '@shared/types'

/** Structural subset of mailparser's `ParsedMail` we consume. */
export interface ParsedMailLike {
  from: { value?: MailAddress[]; text?: string }
  to?: { value?: MailAddress[] }
  cc?: { value?: MailAddress[] }
  subject?: string
  text?: string
  date?: Date
  messageId?: string
}

/** Build a minimal RFC822 message as a UTF-8 string (CRLF line endings). */
export function buildRfc822Raw(input: EmailDraftInput): string {
  const lines: string[] = []
  lines.push(`To: ${input.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`)
  if (input.cc?.length) {
    lines.push(`Cc: ${input.cc.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`)
  }
  lines.push(`Subject: ${encodeHeader(input.subject)}`)
  if (input.threadId) lines.push(`In-Reply-To: ${input.threadId}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('MIME-Version: 1.0')
  lines.push('')
  lines.push(input.body)
  return lines.join('\r\n')
}

/** Encode a non-ASCII header value per RFC 2047 (minimal: only when needed). */
function encodeHeader(s: string): string {
  // The control-char range here is the ASCII boundary, not a real control char.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(s)) {
    return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
  }
  return s
}

/**
 * Parse a raw RFC822 message buffer via mailparser and return a small
 * structural subset. mailparser prefers text/plain over text/html and never
 * executes HTML (Spec §17.12/§17.13). Dynamic-imported so the no-credential
 * path never loads it.
 */
export async function normalizeRfc822ViaParser(source: Buffer): Promise<ParsedMailLike> {
  const { simpleParser } = await import('mailparser')
  const parsed = await simpleParser(source)
  // mailparser's `to`/`cc` are `AddressObject | AddressObject[]`; normalize to
  // a flat value list so the caller doesn't have to care.
  const flat = (a: unknown): { name?: string; address?: string }[] => {
    if (!a) return []
    const arr = Array.isArray(a) ? a : [a]
    const out: { name?: string; address?: string }[] = []
    for (const item of arr as Array<{ value?: { name?: string; address?: string }[] }>) {
      if (item?.value) out.push(...item.value)
    }
    return out
  }
  const map = (v: { name?: string; address?: string }[]): MailAddress[] =>
    v.map((x) => ({ name: x.name || undefined, address: x.address ?? '' }))
  return {
    from: { value: map(flat(parsed.from)), text: parsed.from?.text },
    to: parsed.to ? { value: map(flat(parsed.to)) } : undefined,
    cc: parsed.cc ? { value: map(flat(parsed.cc)) } : undefined,
    subject: parsed.subject ?? undefined,
    text: parsed.text ?? undefined,
    date: parsed.date ?? undefined,
    messageId: parsed.messageId ?? undefined
  }
}
