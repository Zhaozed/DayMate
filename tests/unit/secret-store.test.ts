import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore, type SafeStorageLike } from '../../src/main/util/secrets'

// SecretStore (Spec §17.6/§17.7/§17.8). The key is encrypted at rest and is
// write-only from the renderer's perspective. These tests cover both the
// real-safeStorage path (with a stub encryptor) and the in-memory fallback.

/** A trivial reversible "encryption" stub — not real crypto, just round-trips. */
class StubSafeStorage implements SafeStorageLike {
  isEncryptionAvailable(): boolean {
    return true
  }
  encryptString(plain: string): Buffer {
    return Buffer.from(`enc:${plain}`, 'utf8')
  }
  decryptString(buf: Buffer): string {
    const s = buf.toString('utf8')
    return s.startsWith('enc:') ? s.slice(4) : s
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daymate-secrets-'))
})

describe('SecretStore — in-memory fallback (no safeStorage)', () => {
  it('round-trips a key through memory and never touches disk', async () => {
    const store = new SecretStore(join(dir, 'secrets.json')) // no safeStorage
    expect(await store.has('anthropic')).toBe(false)
    await store.save('anthropic', 'sk-test-123')
    expect(await store.has('anthropic')).toBe(true)
    expect(await store.readKey('anthropic')).toBe('sk-test-123')

    await store.delete('anthropic')
    expect(await store.has('anthropic')).toBe(false)
    expect(await store.readKey('anthropic')).toBeUndefined()
  })

  it('list() returns only status info, never the key string', async () => {
    const store = new SecretStore(join(dir, 'secrets.json'))
    await store.save('openai', 'sk-secret-never-leak')
    const infos = await store.list()
    expect(infos.length).toBe(1)
    expect(infos[0].providerId).toBe('openai')
    expect(infos[0].type).toBe('api_key')
    // The credential info must not carry the key.
    expect(JSON.stringify(infos)).not.toContain('sk-secret-never-leak')
  })
})

describe('SecretStore — encrypted-at-rest path (stub safeStorage)', () => {
  it('persists an encrypted entry across a new instance (restart)', async () => {
    const path = join(dir, 'secrets.json')
    const store = new SecretStore(path, new StubSafeStorage())
    await store.save('anthropic', 'sk-persist-abc')
    expect(await store.has('anthropic')).toBe(true)

    // Simulate a restart: a brand-new instance reads the same file.
    const restarted = new SecretStore(path, new StubSafeStorage())
    expect(await restarted.has('anthropic')).toBe(true)
    expect(await restarted.readKey('anthropic')).toBe('sk-persist-abc')
  })

  it('delete removes the entry from disk', async () => {
    const path = join(dir, 'secrets.json')
    const store = new SecretStore(path, new StubSafeStorage())
    await store.save('anthropic', 'sk-x')
    await store.delete('anthropic')
    const restarted = new SecretStore(path, new StubSafeStorage())
    expect(await restarted.has('anthropic')).toBe(false)
  })

  it('read() returns a Credential, but list() does not leak the key', async () => {
    const store = new SecretStore(join(dir, 'secrets.json'), new StubSafeStorage())
    await store.save('anthropic', 'sk-leak-check')
    const cred = await store.read('anthropic')
    expect(cred?.type).toBe('api_key')
    expect(cred?.key).toBe('sk-leak-check')
    const infos = await store.list()
    expect(JSON.stringify(infos)).not.toContain('sk-leak-check')
  })
})
