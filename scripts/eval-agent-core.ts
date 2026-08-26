// ─────────────────────────────────────────────────────────────────────────────
// scripts/eval-agent-core.ts —— 「考 Agent 本体」的 bundle 入口。
//
// 被 scripts/langfuse-eval-agent.mjs 用 esbuild **bundle** 后动态 import：
// 把 Daymate 真实 agent（createAgentRuntime + createModelGateway）连同其全部
// TS 依赖打进一个纯 Node 可跑的 ESM 文件，让评测脚本能在 Electron 之外跑
// 生产路径（真 key + 真 prompt + 工具调用 + enforceTrust 覆盖层）。
//
// 关键：key 不碰 Electron safeStorage —— 这里注入一个「从环境变量读 key」
// 的 SecretStore 替身给 ModelGateway，其余（provider/modelId）同理从参数来。
// 不改任何生产代码。
// ─────────────────────────────────────────────────────────────────────────────

import { createAgentRuntime, type AgentRuntime } from '../src/main/agent/agent-runtime'
import { createModelGateway } from '../src/main/agent/model-gateway'

export interface EvalAgentOptions {
  /** 'deepseek' | 'openai' | 'anthropic' */
  provider: string
  modelId: string
  /** LLM API key（来自环境变量，评测进程内使用） */
  apiKey: string
}

/** 环境变量版 SecretStore：只读，永远不落盘。 */
function envSecretStore(key: string) {
  return {
    async has(_provider: string): Promise<boolean> {
      return Boolean(key)
    },
    async readKey(_provider: string): Promise<string | undefined> {
      return key || undefined
    },
    async save(): Promise<void> {
      throw new Error('评测模式：不允许写 key')
    },
    async delete(): Promise<void> {
      throw new Error('评测模式：不允许删除 key')
    }
  }
}

/** 环境变量版 Settings：provider/modelId 硬编码自评测参数。 */
function envSettings(provider: string, modelId: string) {
  return {
    async readLlm() {
      return { provider, modelId }
    },
    async writeLlm() {
      throw new Error('评测模式：不允许改设置')
    }
  }
}

/**
 * 构造一个跑真实生产路径的 AgentRuntime：
 * - 有 apiKey → gateway.available()=true → 真 LLM（Agent + 输出工具 + Zod + enforceTrust）
 * - 无 apiKey → available()=false → 确定性 stub（与 pnpm test 同一条路径）
 */
export function createEvalAgentRuntime(opts: EvalAgentOptions): AgentRuntime {
  const gateway = createModelGateway(
    envSecretStore(opts.apiKey) as never,
    envSettings(opts.provider, opts.modelId) as never
  )
  return createAgentRuntime(gateway)
}

// 重导出评测数据集（dataset.ts 只有 type-only 的 shared import，bundle 安全）。
export {
  CLASSIFY_CASES,
  ACTION_CASES,
  NTK_CASES,
  BRIEF_CASES,
  APPROVAL_CASES,
  INJECTION_CASES,
  ALL_CASES
} from '../tests/evaluation/dataset'
// 功能测试集（features/）：独立于回归集，开发期靶子（EVAL_FEATURE=<id> 跑）。
export { FEATURE_CASES } from '../tests/evaluation/features/mail-classify'