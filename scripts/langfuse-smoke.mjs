#!/usr/bin/env node
// Langfuse × Daymate 冒烟脚本 —— 走一遍「真实 LLM 调用 → trace 发到 Langfuse Cloud」
// 的完整流程。不碰 Electron / IPC / SecretStore，独立可跑，用于验证评测链路。
//
// 用法（先 export，再运行）：
//   export LANGFUSE_PUBLIC_KEY="pk-lf-..."
//   export LANGFUSE_SECRET_KEY="sk-lf-..."
//   export DEEPSEEK_API_KEY="sk-..."      # 或 OPENAI_API_KEY / ANTHROPIC_API_KEY
//   node scripts/langfuse-smoke.mjs
//
// 可选覆盖：
//   LANGFUSE_BASEURL  默认 https://cloud.langfuse.com
//   LLM_PROVIDER      默认 deepseek（可选 openai / anthropic）
//   LLM_MODEL         默认 deepseek-v4-flash
//
// 它做的事：
//   1. 用 pi-ai（Daymate 的真实 LLM SDK）调一次真实模型，跑一个与
//      `classify_inbox` 语义等价的评测用例（一封面试邀请邮件 → 分类）。
//   2. 把输入 / 输出 / 真实 token 用量 / 真实成本 / 延迟 记进 Langfuse trace。
//   3. 打一个「topic 是否判成 recruiting」的本地 score，展示评测打分能力。
//   4. 打印 Langfuse 里的 trace 链接。

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { Langfuse } from 'langfuse'

// ── 1. 读环境变量并校验 ──────────────────────────────────────────────────────
const baseUrl = process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com'
const pfPublic = process.env.LANGFUSE_PUBLIC_KEY
const pfSecret = process.env.LANGFUSE_SECRET_KEY
const provider = process.env.LLM_PROVIDER ?? 'deepseek'
const modelId = process.env.LLM_MODEL ?? 'deepseek-v4-flash'

const KEY_ENV = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY'
}
const llmKey = [KEY_ENV[provider], 'LLM_API_KEY'].map((k) => k && process.env[k]).find(Boolean)

const missing = [
  ['LANGFUSE_PUBLIC_KEY', pfPublic],
  ['LANGFUSE_SECRET_KEY', pfSecret],
  [KEY_ENV[provider] ?? 'LLM_API_KEY', llmKey]
].filter(([, v]) => !v).map(([k]) => k)

if (missing.length) {
  console.error('❌ 缺少以下环境变量：')
  for (const k of missing) console.error(`   export ${k}="..."`)
  console.error('\nLangfuse key 在 cloud.langfuse.com → Settings → API Keys 拿；')
  console.error('LLM key 用你的 deepseek/openai/anthropic API key。')
  process.exit(1)
}

// ── 2. 一个与 Daymate `classify_inbox` 语义等价的评测用例 ─────────────────────
const SAMPLE_EMAIL = `Subject: 面试邀请：字节跳动 后端工程师（2026 校招）
From: 字节跳动招聘 <campus@bytedance.com>
Body: 你好，恭喜你通过简历初筛。我们邀请你参加后端工程师岗位的面试，
时间 2026-03-15 14:00，请回复确认是否参加。`

const systemPrompt = [
  '你是 Daymate，一个个人工作助理。把下面的邮件分类。',
  '只输出一个 JSON 对象，不要任何多余文字或代码块：',
  '{"classification":"reply|follow_up|information|ignore", "topic":"fees_billing|recruiting|ads|meeting|general"}',
  '规则：求职/面试/offer → topic=recruiting；广告促销 → topic=ads 且 classification=ignore；',
  '会议邀请 → topic=meeting；账单发票 → topic=fees_billing；对方需要你回复 → classification=reply。'
].join('\n')

// 期望：这是一封求职类、需要回复的面试邀请。
const EXPECTED_TOPIC = 'recruiting'

console.log(`\n▶ 模型: ${provider}/${modelId}  baseUrl: ${baseUrl}`)

// ── 3. 用真实的 pi-ai 调模型 ────────────────────────────────────────────────
const models = builtinModels()
let model = models.getModel(provider, modelId)
if (!model) {
  // 与 model-gateway 相同的 fallback：取该 provider 的第一个 catalog 模型。
  const list = models.getModels(provider)
  model = list[0]
}
if (!model) {
  console.error(`❌ 在 pi-ai catalog 里找不到 provider "${provider}" 的模型`)
  process.exit(1)
}
console.log(`   catalog 模型: ${model.id}`)

const startedAt = Date.now()
let assistant
try {
  const stream = models.streamSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: 'user', content: SAMPLE_EMAIL, timestamp: Date.now() }],
      tools: []
    },
    { apiKey: llmKey }
  )
  assistant = await stream.result()
} catch (err) {
  console.error(`❌ 模型调用失败：${err instanceof Error ? err.message : String(err)}`)
  console.error('   请检查 LLM key 是否正确、网络是否可达（deepseek 国内直连）。')
  process.exit(1)
}
const latencyMs = Date.now() - startedAt

if (assistant.stopReason === 'error' || assistant.errorMessage) {
  console.error(`❌ 模型调用失败: ${assistant.errorMessage ?? assistant.stopReason}`)
  process.exit(1)
}

const rawText = assistant.content
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('')
  .trim()

// 解析结构化输出（尽力而为；失败则保留原文，不影响 trace 产出）。
let parsed = null
try {
  parsed = JSON.parse(rawText.replace(/^```(json)?/i, '').replace(/```$/, '').trim())
} catch {
  parsed = { raw: rawText }
}

const gotTopic = parsed?.topic ?? null
const score = gotTopic === EXPECTED_TOPIC ? 1 : 0

const usage = assistant.usage
console.log('✅ 模型返回：')
console.log(`   stopReason=${assistant.stopReason}  model=${assistant.model}`)
console.log(`   tokens in=${usage.input} out=${usage.output} total=${usage.totalTokens}`)
console.log(`   cost(USD)=${usage.cost.total.toFixed(6)}   latency=${latencyMs}ms`)
console.log(`   topic=${gotTopic}  score=${score}`)

// ── 4. 发 trace 到 Langfuse ──────────────────────────────────────────────────
const langfuse = new Langfuse({
  publicKey: pfPublic,
  secretKey: pfSecret,
  baseUrl,
  release: 'langfuse-smoke-1',
  environment: 'dev'
})

const trace = langfuse.trace({
  name: 'daymate-smoke:classify_inbox',
  input: { provider, modelId, action: 'classify_inbox', email: SAMPLE_EMAIL },
  metadata: { provider, modelId, action: 'classify_inbox' },
  tags: ['daymate', 'smoke', provider]
})

trace.generation({
  name: 'classify_inbox',
  model: assistant.model,
  input: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: SAMPLE_EMAIL }
  ],
  output: parsed,
  usageDetails: {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.reasoning != null ? { reasoning: usage.reasoning } : {})
  },
  costDetails: {
    input: usage.cost.input,
    output: usage.cost.output,
    total: usage.cost.total
  },
  modelParameters: { provider, temperature: null },
  metadata: { promptVersion: 'smoke-1', latencyMs }
})

trace.score({
  name: 'topic_accuracy',
  value: score,
  comment: `expected "${EXPECTED_TOPIC}", got "${gotTopic}"`
})

await langfuse.flushAsync()
console.log(`\n🎉 已上报 Langfuse。查看 trace：`)
console.log(`   ${trace.getTraceUrl()}`)
await langfuse.shutdownAsync()