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
import type {
  MemoryItem,
  MemoryKey,
  MemorySaveInput,
  MemoryUpdate,
  PersonaOutput
} from '@shared/types'
import type { EmailProvider } from '../providers/email/email-provider'
import type { AgentRuntime } from '../agent/agent-runtime'
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
   * Save a memory item. Agent proposals now auto-confirm (the user does not want
   * to manually confirm inferred memory — §16 confirmation gate removed by
   * user preference). `validateMemoryContent` is the safety floor: it rejects
   * tokens, full email bodies, and forbidden inferred traits BEFORE anything
   * persists, regardless of confirmation.
   *
   * Merge / update semantics (one active value per key):
   *   • If a CONFIRMED value for the same key already exists:
   *     - User-authored prior (`source === 'user'`) is the user's explicit
   *       truth — an agent proposal does NOT clobber it (return prior as-is).
   *     - Agent-authored prior is refined in place: update its value (or no-op
   *       if the new value equals the old — idempotent).
   *   • If no confirmed value exists: clear any stale pending for the key and
   *     create a new confirmed item.
   * Either way, one confirmed value per key stays coherent.
   */
  save(input: MemorySaveInput): MemoryItem {
    validateMemoryContent(input.key, input.value)
    const isAgent = input.source !== 'user'
    const confirmed = input.confirmed ?? true // auto-confirm by default
    const now = nowIso()

    const existing = this.store.listMemory()
    const prior = existing.find((m) => m.confirmed && m.key === input.key)
    if (prior) {
      // Protect a user-authored value from agent overwrite (merge, not clobber).
      if (isAgent && prior.source === 'user') return prior
      // Idempotent: same value already active → nothing to do.
      if (prior.value === input.value) return prior
      // Update the existing confirmed row in place (one value per key).
      const next = this.store.updateMemory(prior.id, {
        value: input.value,
        updatedAt: now
      })
      if (!next) throw new Error(`记忆更新失败：${prior.id}`)
      return next
    }

    // No confirmed value for this key — drop any stale pending rows, then create.
    for (const m of existing) {
      if (!m.confirmed && m.key === input.key) this.store.deleteMemory(m.id)
    }
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

  /**
   * One-time boot reconciliation. Agent proposals now auto-confirm, so nothing
   * should be pending going forward. This sweeps legacy state created before
   * that change (rows left pending by the old confirm-gate path) and any
   * duplicates: per key, keep exactly ONE confirmed value — promote the newest
   * pending if no confirmed exists for that key, else keep the newest confirmed
   * and drop everything else. Idempotent.
   */
  reconcile(): void {
    const all = this.store.listMemory() // sorted by createdAt DESC
    const byKey = new Map<string, MemoryItem[]>()
    for (const m of all) {
      if (!byKey.has(m.key)) byKey.set(m.key, [])
      byKey.get(m.key)!.push(m)
    }
    for (const items of byKey.values()) {
      const confirmed = items.filter((m) => m.confirmed)
      const pending = items.filter((m) => !m.confirmed)
      let keep: MemoryItem
      if (confirmed.length > 0) {
        keep = confirmed[0] // newest confirmed (DESC)
      } else {
        keep = pending[0] // newest pending — promote
        this.store.updateMemory(keep.id, { confirmed: true })
      }
      for (const m of items) {
        if (m.id !== keep.id) this.store.deleteMemory(m.id)
      }
    }
  }

  /** Backward-compatible alias for {@link reconcile}. */
  dedupe(): void {
    this.reconcile()
  }

  /**
   * On-demand persona inference (§16 town-style profile). Reads the user's OWN
   * sent mail from every connected email provider (`listSent`, last 30 days,
   * capped at 100 per provider), runs the `generate_persona` agent step, and
   * saves each proposal — proposals now auto-confirm and merge/update the
   * existing confirmed value for that key in place (no manual confirmation;
   * user-authored values are protected from agent overwrite). Sent mail is the
   * user's trusted voice (framed by `frameSentReply`, the opposite of
   * §17-untrusted inbound). Provider failures are graceful — a down provider
   * contributes no sent mail, the run still completes with the others (mirrors
   * email provider partial-failure handling).
   *
   * NOT via the routine engine — on-demand manual AI, mirroring
   * `applicationService.generateResume` (single step, no orchestration).
   * Returns the persona summary + the proposals that landed (for a toast).
   */
  async generatePersona(
    emailProviders: EmailProvider[],
    agentRuntime: AgentRuntime
  ): Promise<PersonaOutput> {
    // Gather the user's own sent mail across all connected providers. A provider
    // that throws (down / not connected) contributes nothing — do not kill the
    // run (partial-failure parity).
    const sentEmails = []
    for (const p of emailProviders) {
      try {
        const sent = await p.listSent({ sinceHours: 24 * 30, limit: 100 })
        sentEmails.push(...sent)
      } catch {
        // provider unavailable — skip, the others still contribute
      }
    }

    const memory = this.listConfirmed()
    const output = (await agentRuntime.runAgentStep('generate_persona', {
      sentEmails,
      memory
    })) as PersonaOutput

    // Save each proposal — `save()` now auto-confirms and merges/updates the
    // existing confirmed value for that key in place (no manual confirmation).
    // User-authored values are protected from agent overwrite (merge, not
    // clobber). `validateMemoryContent` re-checks before persisting
    // (enforceTrust already filtered, but the service is the last word §12).
    // A rejected proposal (full email body / token / forbidden trait) becomes
    // a no-op skip, never throws — the user still gets the summary + the valid
    // updates.
    const proposals = output.memoryProposals ?? []
    for (const proposal of proposals) {
      try {
        this.save({
          key: proposal.key,
          value: proposal.value,
          source: 'agent'
        })
      } catch {
        // rejected by validateMemoryContent — skip, do not fail the run
      }
    }

    return output
  }
}
