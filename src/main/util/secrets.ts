// Encrypted-at-rest secret storage for LLM API keys (Spec §17.6/§17.7/§17.8).
//
// The key is written by the renderer through IPC, encrypted with Electron
// `safeStorage` (macOS Keychain-backed) and persisted to a file under
// `app.getPath('userData')`. The renderer NEVER reads the key back — only
// `has()`/status is exposed. This store also implements pi-ai's
// `CredentialStore` interface so `createModels({ credentials })` can resolve
// auth at call time without Daymate ever interpolating the key into a prompt.
//
// When `safeStorage` is unavailable (tests, non-Electron, or the OS keychain
// is inaccessible) the store degrades to an in-memory map and logs a warning.
// That path is for tests/dev only; production on macOS uses the real keychain.

import type { CredentialStore, Credential, CredentialInfo } from '@earendil-works/pi-ai'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Minimal Electron safeStorage surface this store relies on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

interface StoredEntry {
  /** base64 of the encrypted key buffer (safeStorage path). */
  cipher?: string
  /** Plaintext key (fallback path only — in-memory, never persisted to disk). */
  plain?: string
}

interface SecretsFile {
  version: 1
  entries: Record<string, StoredEntry>
}

const EMPTY: SecretsFile = { version: 1, entries: {} }

/**
 * A best-effort encrypted credential store. Implements pi-ai's `CredentialStore`
 * structurally; the type parameter is imported as a type only (no runtime
 * dependency on the ESM package here).
 */
export class SecretStore implements CredentialStore {
  private memory = new Map<string, StoredEntry>()
  private warnedFallback = false

  constructor(
    private readonly filePath: string,
    private readonly safeStorage?: SafeStorageLike
  ) {}

  private get encrypted(): boolean {
    return !!this.safeStorage?.isEncryptionAvailable()
  }

  // ── Daymate-facing API (used by the LLM IPC handlers + gateway) ────────────

  /** Persist an API key for `providerId`, encrypted at rest. */
  async save(providerId: string, key: string): Promise<void> {
    const entry = this.encryptEntry(key)
    await this.setEntry(providerId, entry)
  }

  /** Read the raw key (gateway / getApiKey only — never exposed to renderer). */
  async readKey(providerId: string): Promise<string | undefined> {
    const c = await this.read(providerId)
    return c && c.type === 'api_key' ? c.key : undefined
  }

  /** True iff a key exists for `providerId` (no decryption, no secret exposed). */
  async has(providerId: string): Promise<boolean> {
    const all = await this.load()
    return all.entries[providerId] !== undefined
  }

  // ── CredentialStore interface (pi-ai) ──────────────────────────────────────

  async read(providerId: string): Promise<Credential | undefined> {
    const all = await this.load()
    const entry = all.entries[providerId]
    if (!entry) return undefined
    const key = this.decryptEntry(entry)
    if (key === undefined) return undefined
    return { type: 'api_key', key }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const all = await this.load()
    return Object.keys(all.entries).map((providerId) => ({
      providerId,
      type: 'api_key' as const
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    // Serialized per-store via a promise chain so concurrent calls don't race.
    const run = this.queue.then(async () => {
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next === undefined) {
        await this.setEntry(providerId, undefined)
        return undefined
      }
      if (next.type !== 'api_key') {
        throw new Error('Daymate SecretStore only stores api_key credentials')
      }
      const entry = next.key === undefined ? undefined : this.encryptEntry(next.key)
      await this.setEntry(providerId, entry)
      return next
    })
    // Keep the chain alive without surfacing rejections to the next caller.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async delete(providerId: string): Promise<void> {
    await this.setEntry(providerId, undefined)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Per-store serialization chain (best-effort mutual exclusion). */
  private queue: Promise<void> = Promise.resolve()

  private encryptEntry(key: string): StoredEntry {
    if (this.safeStorage?.isEncryptionAvailable()) {
      return { cipher: this.safeStorage.encryptString(key).toString('base64') }
    }
    this.warnFallback()
    // Fallback: plaintext in memory only. Never written to disk, so it does
    // not masquerade as "encrypted at rest"; this path is tests/dev only.
    return { plain: key }
  }

  private decryptEntry(entry: StoredEntry): string | undefined {
    if (entry.plain !== undefined) return entry.plain
    if (entry.cipher === undefined) return undefined
    if (!this.safeStorage?.isEncryptionAvailable()) {
      // Cannot decrypt without the keychain — treat as absent.
      return undefined
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'))
    } catch {
      return undefined
    }
  }

  /** Overwrite (or delete) one entry; persists to disk when encrypted. */
  private async setEntry(providerId: string, entry: StoredEntry | undefined): Promise<void> {
    if (this.encrypted) {
      const all = await this.load()
      if (entry === undefined) delete all.entries[providerId]
      else all.entries[providerId] = entry
      await this.persist(all)
    } else {
      if (entry === undefined) this.memory.delete(providerId)
      else this.memory.set(providerId, entry)
    }
  }

  private async load(): Promise<SecretsFile> {
    if (!this.encrypted) {
      // Fallback path: in-memory only, but mirror the file shape for read().
      const entries: Record<string, StoredEntry> = {}
      for (const [k, v] of this.memory) entries[k] = v
      return { version: 1, entries }
    }
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as SecretsFile
      if (parsed.version !== 1) return { ...EMPTY }
      return { version: 1, entries: parsed.entries ?? {} }
    } catch {
      return { ...EMPTY }
    }
  }

  private async persist(file: SecretsFile): Promise<void> {
    if (!existsSync(dirname(this.filePath))) {
      await mkdir(dirname(this.filePath), { recursive: true })
    }
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8')
  }

  private warnFallback(): void {
    if (this.warnedFallback) return
    this.warnedFallback = true
    console.warn(
      '[secrets] safeStorage unavailable — keys held in memory only (not encrypted at rest).'
    )
  }
}
