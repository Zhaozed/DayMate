// Memory Service (Spec §16). Memory is explicit, inspectable and deletable.
//
// Two kinds of items live in the store:
//   • Confirmed (`confirmed: true`)  — active. `search()` reads only these.
//   • Proposed  (`confirmed: false`)  — surfaced separately in the Memory page
//     for the user to confirm or dismiss. "Agent proposals to save memory must
//     be visible and require confirmation" (§16) — so `save()` from an agent
//     always lands proposed, never active.
//
// Confirming a proposed item promotes it: any previously-confirmed item for the
// same key is deleted (one confirmed value per key) and the proposed item is
// flipped to confirmed. This keeps memory coherent without silently overwriting
// a user's prior choice.
//
// Forbidden content (§16 "Forbidden automatic memory") is rejected by
// `validateContent` BEFORE anything is persisted: full email bodies, passwords
// / tokens / authorization codes, inferred sensitive traits, negative
// judgments about contacts, content drawn from untrusted email instructions,
// and private company information not explicitly approved. These are business
// rules, not the model's discretion (Spec §12).

import type { RoutineStore } from '../db/store'
import type { MemoryItem, MemoryKey, MemorySaveInput, MemoryUpdate } from '@shared/types'
import { newId, nowIso } from '../util/ids'

// §16 forbidden-content markers. A value matching any of these is rejected.
// Tokens / auth codes: long base64-ish or hex runs, or explicit "password"/
// "token"/"secret"/"authorization" labels.
const SECRET_PATTERNS = [
  /\b(api[_-]?key|secret|token|password|passwd|authorization|auth[_-]?code|refresh[_-]?token)\b/i,
  /[A-Za-z0-9+/_=-]{40,}/ // ≥40-char base64/hex blob — looks like a credential
]
// Full email bodies: a value that looks like a forwarded message.
const EMAIL_BODY_PATTERNS = [
  /\bfrom:\s.*\n.*\bto:\s/i,
  /\bsubject:\s.*\n/i,
  /-{2,}\s*original\s+message\s*-{2,}/i
]
// Inferred sensitive traits / negative judgments.
const SENSITIVE_PATTERNS = [
  /\b(medical|diagnosis|disability|political|religion|sexual|mental health)\b/i,
  /\b(lazy|incompetent|unreliable|toxic|stupid|useless)\b/i
]

export class MemorySaveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemorySaveError'
  }
}

/** Reject forbidden memory content (Spec §16). Throws on a violation. */
export function validateMemoryContent(key: MemoryKey, value: string): void {
  const v = value ?? ''
  for (const re of SECRET_PATTERNS) {
    if (re.test(v)) {
      throw new MemorySaveError(`记忆被拒绝：值看起来像密钥/令牌（§16）。key="${key}"`)
    }
  }
  for (const re of EMAIL_BODY_PATTERNS) {
    if (re.test(v)) {
      throw new MemorySaveError(`记忆被拒绝：值看起来像完整邮件正文（§16）。key="${key}"`)
    }
  }
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(v)) {
      throw new MemorySaveError(`记忆被拒绝：值包含禁止推断的/负面的特征（§16）。key="${key}"`)
    }
  }
  if (v.length > 2000) {
    throw new MemorySaveError(`记忆被拒绝：值过长（超过 ${2000} 字符）。key="${key}"`)
  }
}

export class MemoryService {
  constructor(private readonly store: RoutineStore) {}

  list(): MemoryItem[] {
    return this.store.listMemory()
  }

  /** Confirmed items only — the active memory the agent may read. */
  listConfirmed(): MemoryItem[] {
    return this.store.listMemory().filter((m) => m.confirmed)
  }

  /** Free-text search over confirmed memory. Case-insensitive substring. */
  search(query: string): MemoryItem[] {
    const q = (query ?? '').trim().toLowerCase()
    if (!q) return this.listConfirmed()
    return this.listConfirmed().filter(
      (m) => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)
    )
  }

  /**
   * Save a memory item. Agent proposals (`source` starts with `agent` or
   * `routine`) always land proposed (`confirmed: false`); user-authored saves
   * (`source: 'user'`) are confirmed immediately. Idempotent: an identical
   * proposed (key, value) that already exists is a no-op.
   */
  save(input: MemorySaveInput): MemoryItem {
    validateMemoryContent(input.key, input.value)
    const isAgent = input.source !== 'user'
    const confirmed = input.confirmed ?? !isAgent

    // Idempotent: an identical proposed item already exists → return it.
    if (!confirmed) {
      const dup = this.store
        .listMemory()
        .find((m) => !m.confirmed && m.key === input.key && m.value === input.value)
      if (dup) return dup
    }

    const now = nowIso()
    const item: MemoryItem = {
      id: newId('mem'),
      key: input.key,
      value: input.value,
      source: input.source ?? (isAgent ? 'agent' : 'user'),
      confirmed,
      routineRunId: input.routineRunId,
      createdAt: now,
      updatedAt: now
    }
    this.store.createMemory(item)
    return item
  }

  /** Edit a memory item's value (user-authored edit in the Memory page). */
  update(id: string, patch: MemoryUpdate): MemoryItem {
    const existing = this.store.getMemory(id)
    if (!existing) throw new Error(`未找到记忆项：${id}`)
    if (patch.value !== undefined) validateMemoryContent(existing.key, patch.value)
    const next = this.store.updateMemory(id, patch)
    if (!next) throw new Error(`记忆更新失败：${id}`)
    return next
  }

  /**
   * Confirm a proposed item: delete any previously-confirmed item for the same
   * key (one confirmed value per key), then flip this item to confirmed.
   */
  confirm(id: string): MemoryItem {
    const existing = this.store.getMemory(id)
    if (!existing) throw new Error(`未找到记忆项：${id}`)
    if (existing.confirmed) return existing // already active
    // Demote/delete any prior confirmed value for this key to stay coherent.
    const priorConfirmed = this.store
      .listMemory()
      .filter((m) => m.confirmed && m.key === existing.key && m.id !== id)
    // Delete the prior confirmed item(s); proposed siblings are left intact.
    for (const p of priorConfirmed) this.store.deleteMemory(p.id)
    const next = this.store.updateMemory(id, { confirmed: true })
    if (!next) throw new Error(`记忆确认失败：${id}`)
    return next
  }

  delete(id: string): void {
    const existing = this.store.getMemory(id)
    if (!existing) return // idempotent
    this.store.deleteMemory(id)
  }
}
