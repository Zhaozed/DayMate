import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import type { SafeStorageLike } from '../main/util/secrets'

/**
 * Headless AES-256-GCM implementation of SafeStorageLike for Linux servers / headless environments.
 * Uses a 32-byte key derived via SHA-256 from the secret string (e.g. DAYMATE_SECRET_KEY env).
 */
export class ServerSafeStorage implements SafeStorageLike {
  private key: Buffer

  constructor(secretKey: string) {
    if (!secretKey || secretKey.trim().length === 0) {
      throw new Error('ServerSafeStorage requires a non-empty secret key')
    }
    this.key = createHash('sha256').update(secretKey).digest()
  }

  isEncryptionAvailable(): boolean {
    return true
  }

  encryptString(plain: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // Layout: 12-byte IV + 16-byte Auth Tag + ciphertext
    return Buffer.concat([iv, tag, encrypted])
  }

  decryptString(buf: Buffer): string {
    if (buf.length < 28) {
      throw new Error('Encrypted payload too short for AES-256-GCM')
    }
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const encrypted = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  }
}
