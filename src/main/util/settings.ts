// Plain (non-secret) application settings, persisted as JSON under
// `app.getPath('userData')`. Only NON-SECRET values live here — the LLM API
// key is in the SecretStore (encrypted). The renderer reads this shape via
// `getLlmConfig()` which augments it with a `keyConfigured` flag (never the
// key itself) (Spec §17.8).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { LLM_PROVIDERS, DEFAULT_LLM_MODEL_IDS } from '@shared/constants'
import type { LlmProvider } from '@shared/types'

export interface LlmSettings {
  provider: LlmProvider
  modelId: string
}

export interface AppSettings {
  llm: LlmSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    provider: 'anthropic',
    modelId: DEFAULT_LLM_MODEL_IDS.anthropic
  }
}

export class Settings {
  private cached: AppSettings | undefined

  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    if (this.cached) return this.cached
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.cached = normalize(parsed)
    } catch {
      this.cached = { ...DEFAULT_SETTINGS }
    }
    return this.cached
  }

  async readLlm(): Promise<LlmSettings> {
    return (await this.read()).llm
  }

  async writeLlm(llm: LlmSettings): Promise<LlmSettings> {
    const current = await this.read()
    const next: AppSettings = { ...current, llm }
    await this.persist(next)
    this.cached = next
    return next.llm
  }

  private async persist(settings: AppSettings): Promise<void> {
    if (!existsSync(dirname(this.filePath))) {
      await mkdir(dirname(this.filePath), { recursive: true })
    }
    await writeFile(this.filePath, JSON.stringify(settings, null, 2), 'utf8')
  }
}

/** Coerce a parsed (possibly partial) object into a valid AppSettings. */
function normalize(parsed: Partial<AppSettings> | null | undefined): AppSettings {
  const llm = parsed?.llm
  const valid = LLM_PROVIDERS as readonly string[]
  const provider: LlmProvider =
    llm?.provider && valid.includes(llm.provider) ? (llm.provider as LlmProvider) : 'anthropic'
  const modelId =
    typeof llm?.modelId === 'string' && llm.modelId.length > 0
      ? llm.modelId
      : DEFAULT_LLM_MODEL_IDS[provider]
  return { llm: { provider, modelId } }
}
