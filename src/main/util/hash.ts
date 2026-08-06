// Content hashing for the Approval immutability guarantee (Spec §15:
// "No action may change between approval preview and execution. If content
// changes, request a new approval.")
//
// The hash is taken over CANONICAL JSON (object keys sorted at every depth),
// so semantically-equal args always hash equal regardless of key order.

import { createHash } from 'node:crypto'

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Stable JSON: sorted keys, recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** Hash of an action's args — stored at preview time, rechecked at execute time. */
export function contentHashOf(args: unknown): string {
  return sha256(canonicalJson(args))
}
