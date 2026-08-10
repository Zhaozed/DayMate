import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '../../src/main/util/secrets'
import { Settings } from '../../src/main/util/settings'
import { createModelGateway } from '../../src/main/agent/model-gateway'
import { DEFAULT_LLM_MODEL_IDS } from '@shared/constants'

// Model gateway (Spec §11/§17). These tests exercise the REAL pi-ai catalog
// wiring (no safeStorage, no network — `resolveModel()` only resolves the
// model object; the key is consumed at call time, never at resolve time).
//
// They prove the domestic `deepseek` provider is actually registered by
// `builtinModels` and resolvable by the gateway — not a skeleton. The
// end-to-end "real model round-trip" is gated by the Integrations `Test`
// button, which needs a user-supplied key (never hardcoded here).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daymate-gateway-'))
})

describe('ModelGateway — deepseek provider wiring (real pi-ai catalog)', () => {
  it('exposes deepseek in the configured providers and defaults', () => {
    expect(DEFAULT_LLM_MODEL_IDS.deepseek).toBe('deepseek-v4-flash')
  })

  it('reports unavailable without a key and resolvable with one', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json')) // in-memory fallback
    const settings = new Settings(join(dir, 'settings.json'))
    const gw = createModelGateway(secrets, settings)

    // Configure the deepseek provider (no key yet).
    const cfg = await gw.setLlmConfig({ provider: 'deepseek', modelId: 'deepseek-v4-flash' })
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.keyConfigured).toBe(false)
    expect(await gw.available()).toBe(false)

    // Save a (fake) key — keyConfigured flips; available() now true.
    const withKey = await gw.setLlmKey('sk-deepseek-fake')
    expect(withKey.keyConfigured).toBe(true)
    expect(await gw.available()).toBe(true)

    // resolveModel() loads pi-ai and resolves the deepseek model from the
    // catalog. This is the real provider path, not a stub. No network call
    // happens here — the key is only read back via getApiKey at call time.
    const resolved = await gw.resolveModel()
    expect(resolved.model).toBeDefined()
    // The model carries an id (catalog entry); confirm it is a deepseek model.
    const id = (resolved.model as { id?: string }).id
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^deepseek/i)

    // getApiKey resolves the stored key for THIS provider (never crosses to
    // the renderer; used by the SDK at call time only).
    expect(await resolved.getApiKey('deepseek')).toBe('sk-deepseek-fake')

    // Deleting the key returns to unavailable.
    await gw.deleteLlmKey()
    expect(await gw.available()).toBe(false)
  })

  it('persists the deepseek choice across a fresh Settings instance', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'))
    const settings = new Settings(join(dir, 'settings.json'))
    const gw = createModelGateway(secrets, settings)
    await gw.setLlmConfig({ provider: 'deepseek', modelId: 'deepseek-v4-pro' })

    // A new Settings reading the same file must remember the choice.
    const settings2 = new Settings(join(dir, 'settings.json'))
    const gw2 = createModelGateway(secrets, settings2)
    const cfg = await gw2.getLlmConfig()
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.modelId).toBe('deepseek-v4-pro')
  })
})
