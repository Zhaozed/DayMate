// Small id + time helpers. Uses crypto.randomUUID (available in Node 20 and
// Electron's main). Centralized so services don't reach for ad-hoc generation.

import { randomUUID } from 'node:crypto'

export function newId(prefix?: string): string {
  const id = randomUUID()
  return prefix ? `${prefix}_${id}` : id
}

export function nowIso(): string {
  return new Date().toISOString()
}
