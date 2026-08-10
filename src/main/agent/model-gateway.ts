// Model gateway — the single owner of LLM provider access (Spec §11/§17).
//
// `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are ESM-only and
// declare `engines: node>=22.19`; Daymate's main is CommonJS and
// `externalizeDepsPlugin()` externalizes deps, so a static `import` would throw
// `ERR_REQUIRE_ESM` at runtime. This gateway loads them via DYNAMIC `import()`,
// cached, and only when an LLM path is actually needed (the no-key production
// path never loads these modules at all). Types come from `import type` (erased).
//
// The renderer never sees the key: it is stored encrypted by the SecretStore,
// resolved by the SDK into `StreamOptions.apiKey` at call time, and never
// interpolated into any prompt (Spec §17.6/§17.8).

import type { Agent, StreamFn } from '@earendil-works/pi-agent-core'
import type { Model, MutableModels, ModelsSimpleStreamOptions, Api } from '@earendil-works/pi-ai'
import type { SecretStore } from '../util/secrets'
import type { Settings } from '../util/settings'
import {
  buildOutputSchemas,
  type OutputSchemas,
  type TypeBuilder
} from './structured-output'
import { DEFAULT_LLM_MODEL_IDS } from '@shared/constants'
import type { LlmConfig, LlmConfigInput, LlmTestResult, LlmProvider } from '@shared/types'

export interface ResolvedModel {
  streamFn: StreamFn
  model: Model<Api>
  getApiKey: (provider: string) => Promise<string | undefined>
}

export interface ModelGateway {
  // Renderer-facing LLM config (key is write-only; getLlmConfig never returns it).
  getLlmConfig(): Promise<LlmConfig>
  setLlmConfig(input: LlmConfigInput): Promise<LlmConfig>
  setLlmKey(key: string): Promise<LlmConfig>
  deleteLlmKey(): Promise<LlmConfig>
  testLlm(): Promise<LlmTestResult>
  // Agent-runtime path.
  available(): Promise<boolean>
  resolveModel(): Promise<ResolvedModel>
  loadAgent(): Promise<typeof Agent>
  getOutputSchemas(): Promise<OutputSchemas>
}

export function createModelGateway(secrets: SecretStore, settings: Settings): ModelGateway {
  let corePromise: Promise<typeof Agent> | undefined
  let modelsPromise: Promise<MutableModels> | undefined
  let schemasPromise: Promise<OutputSchemas> | undefined

  async function provider(): Promise<LlmProvider> {
    return (await settings.readLlm()).provider
  }

  async function config(): Promise<LlmConfig> {
    const llm = await settings.readLlm()
    return {
      provider: llm.provider,
      modelId: llm.modelId,
      keyConfigured: await secrets.has(llm.provider)
    }
  }

  async function models(): Promise<MutableModels> {
    if (!modelsPromise) {
      modelsPromise = (async () => {
        // Register every built-in provider (anthropic + openai included) with
        // the Daymate SecretStore as the credential source. Auth is resolved
        // per call; a provider with no key is simply unconfigured.
        const all = await import('@earendil-works/pi-ai/providers/all')
        return all.builtinModels({ credentials: secrets })
      })()
    }
    return modelsPromise
  }

  return {
    async available(): Promise<boolean> {
      const p = await provider()
      return secrets.has(p)
    },

    async getLlmConfig(): Promise<LlmConfig> {
      return config()
    },

    async setLlmConfig(input: LlmConfigInput): Promise<LlmConfig> {
      await settings.writeLlm({ provider: input.provider, modelId: input.modelId })
      return config()
    },

    async setLlmKey(key: string): Promise<LlmConfig> {
      const p = await provider()
      await secrets.save(p, key)
      return config()
    },

    async deleteLlmKey(): Promise<LlmConfig> {
      const p = await provider()
      await secrets.delete(p)
      return config()
    },

    async testLlm(): Promise<LlmTestResult> {
      if (!(await this.available())) {
        return { ok: false, message: 'No API key configured for the selected provider.' }
      }
      try {
        const { streamFn, model, getApiKey } = await this.resolveModel()
        const AgentCtor = await this.loadAgent()
        const agent = new AgentCtor({
          streamFn,
          getApiKey,
          initialState: {
            systemPrompt: 'Reply with the single word: ok',
            model,
            thinkingLevel: 'low' as never,
            tools: [],
            messages: []
          }
        })
        await agent.prompt('ping')
        await agent.waitForIdle()
        const err = agent.state.errorMessage
        if (err) return { ok: false, message: `Provider error: ${err}` }
        return { ok: true, message: 'Provider reachable.' }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, message: `LLM runtime unavailable: ${message}` }
      }
    },

    async resolveModel(): Promise<ResolvedModel> {
      const llm = await settings.readLlm()
      if (!(await secrets.has(llm.provider))) {
        throw new Error(`LLM key not configured for provider "${llm.provider}"`)
      }
      const m = await models()
      let model = m.getModel(llm.provider, llm.modelId)
      if (!model) {
        // Fall back to the provider's first catalog model when the configured id
        // is unknown (e.g. a model id from a newer/older catalog).
        const list = m.getModels(llm.provider)
        model = list[0]
      }
      if (!model) {
        throw new Error(`No model available for provider "${llm.provider}"`)
      }
      const streamFn: StreamFn = (mod, ctx, opts) =>
        m.streamSimple(mod, ctx, opts as ModelsSimpleStreamOptions | undefined)
      return {
        streamFn,
        model,
        getApiKey: (p: string) => secrets.readKey(p)
      }
    },

    async loadAgent(): Promise<typeof Agent> {
      if (!corePromise) {
        corePromise = (async () => {
          const core = await import('@earendil-works/pi-agent-core')
          return core.Agent
        })()
      }
      return corePromise
    },

    async getOutputSchemas(): Promise<OutputSchemas> {
      if (!schemasPromise) {
        schemasPromise = (async () => {
          const piAi = await import('@earendil-works/pi-ai')
          return buildOutputSchemas(piAi.Type as TypeBuilder)
        })()
      }
      return schemasPromise
    }
  }
}

// Re-export so callers can read the default model id without importing constants.
export { DEFAULT_LLM_MODEL_IDS }
