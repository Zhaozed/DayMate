# 用户画像自动推断（generate_persona agent action）

## Context

用户要求："你让 DayMate 去访问我授权给他的工具，拿到我这个人的人物画像，并
更新记忆"。即让 Daymate 读取已连接邮箱（Gmail / 163）的**已发送邮件**（用户自己
的声音），自动推断用户画像（persona / 写作风格 / 邮件语气 / 工作时段），写入
记忆模块（§16 town-style profile）。用户随后明确要求**取消手动确认**——"不需要
我自己主动确认，你直接记住改就行了，注意好同类记忆的合并以及该更新的更新"。故
agent 提案 auto-confirm + 合并/更新，不再落 `confirmed:false` 待确认。

Verified: typecheck + lint + 384 tests (1 skipped) + build 全绿；新
`tests/unit/generate-persona.test.ts` 5 测试全绿。

## 决策

### 1. 新 agent action `generate_persona`（6-touchpoint lockstep ×8 dispatch）

沿用项目既有的 6-touchpoint lockstep（Zod schema + TypeBox mirror + TS interface +
stub + buildUserMessage + enforceTrust + system-prompt task string + 8 real-path
dispatch 点）。`generate_persona` 是新 action，非 `classify_inbox` 扩展（输入结构
不同：sent mail + memory vs inbound mail）。

- **Zod** `personaOutputSchema = { summary: string, memoryProposals? }`
  （`schemas.ts`）。
- **TypeBox** `submit_persona`（`structured-output.ts`）加入 `OutputSchemas`
  接口 + `buildOutputSchemas` 返回 map。顺手补全 `memoryProposal` union 缺失的
  `job_search_profile` literal（pre-existing inconsistency，`MEMORY_KEYS` 早有它）。
- **TS interface** `PersonaInput { sentEmails?; memory? }` + `PersonaOutput`
  （`types.ts`，`PersonaOutput` 早在 0020 已定义，本里程碑补 `PersonaInput`）。
- **stub** `generatePersona`（`agent-runtime.ts`）——镜像 `generateDraftReply`
  的 voice detection：formality（Dear/Best regards/您好 vs Hi/Hey）、greeting/
  sign-off regex、working_hours 从发送时间直方图（最早–最晚小时）；proposes
  persona / writing_style / email_tone / working_hours，**跳过已 confirmed 的
  key**（不重复提案）。无 sent mail → 最小 summary + 无提案（与真实 LLM 路径一致）。
- **buildUserMessage** `generate_persona` 分支：sent mail 经 `frameSentReply`
  （`<your_reply>` 块，NOT `frameEmail`——`frameEmail` 调 `isUntrusted`，会误标
  引用了注入邮件的回复）进 **user message**（绝不进 host-set system prompt）。
- **enforceTrust** `generate_persona` 分支：sent mail 是用户自己的可信声音
  （`frameSentReply`，非 `frameEmail`/`isUntrusted`），无 untrusted prose 进此 step，
  故**无需 untrusted stripping**。proposals 是 trusted-derived。仅防御性 cleanup：
  `capInput(summary, 600)` + 每个 proposal 过 `validateMemoryContent`（拒 token /
  完整邮件正文 / 禁止推断特征——service 再校验一次，enforceTrust 是 §12 兜底）。
- **system-prompt** `buildSystemPrompt` 加 `generate_persona` task string：指示
  模型从 `<your_reply>` 推断 persona/writing_style/email_tone/working_hours，ground
  在 sent mail，不造事实、不推断禁止特征，跳过已 confirmed 的 key。
- **8 dispatch 点**：`isPersona` flag + guard + `toolName`/`toolDesc`/`params`/
  schema ternary（`agent-runtime.ts` `createAgentRuntime` 真路径）+ stub dispatch
  （`runAgentStep`）。

### 2. `MemoryService.generatePersona`（on-demand，非 routine engine）

镜像 `applicationService.generateResume` / `generateFunnelReview` 先例：**on-demand
手动 AI，不经 routine engine**（单步、无编排需求）。签名：
`generatePersona(emailProviders, agentRuntime): Promise<PersonaOutput>`。

- 遍历每个 connected email provider `listSent({ sinceHours: 30d, limit: 100 })`
  合并 corpus。provider 失败（down / not connected）**graceful skip**——贡献 0 封，
  run 仍完成（镜像 email provider partial-failure 处理）。
- `runAgentStep('generate_persona', { sentEmails, memory })` —— `memory` =
  `listConfirmed()`（让模型/stub 跳过已 confirmed 的 key）。
- 每个 proposal 调 `this.save({ key, value, source: 'agent' })` → **auto-confirm +
  合并/更新**（同 key 已有 confirmed：user-authored 受保护不覆盖，agent-authored
  原地更新；值相同幂等 no-op）。被 `validateMemoryContent` 拒绝的 proposal → no-op
  skip（不抛错，run 仍返回 summary + 合法更新）。
- 返回 `PersonaOutput`（summary + proposals）给 IPC handler → renderer 做 toast。

### 3. IPC + preload + renderer

- **IPC channel** `MEMORY_GENERATE_PERSONA`（`constants.ts`）。Handler 调
  `container.memoryService.generatePersona(container.emailProviders,
  container.agentRuntime)` → `broadcastMemory()` → 返回 output。容器已有全部 deps
  （`emailProviders` + `agentRuntime` + `memoryService`），无需新接线。
- **preload** `generatePersona: () => ipcRenderer.invoke(IPC.MEMORY_GENERATE_PERSONA)`。
- **`DaymateApi.generatePersona(): Promise<PersonaOutput>`**（`types.ts`）。
- **Memory.tsx** `ProfileSection` header 加「生成用户画像」按钮：调
  `generatePersona()` → `onSaved()`（refetch，proposals 落「待确认」区）+ 显示
  summary toast（emerald）/ error（rose）。按钮 busy 态「推断中…」。副标说明"读取
  已连接邮箱的已发送邮件，自动推断画像"。

## 关键决策要点

- **sent mail 是用户自己的可信声音，非 §17 untrusted**——`frameSentReply`
  （`<your_reply>` 块）而非 `frameEmail`（`isUntrusted`）；feeding real sent mail
  to 第三方 LLM 是 user-consented data flow，LLM-key opt-in 覆盖（ADR 0009）。
  enforceTrust 无需 untrusted stripping。
- **on-demand 非 routine engine**——镜像 `generateResume` 先例；画像生成是单步、
  无编排需求。routine engine 的 `KNOWN_AGENT_ACTIONS` 不加它（与
  `generate_draft_reply` 同——后者也是 on-demand 不在 KNOWN list）。
- **proposals 自动确认 + 合并/更新（取消 §16 手动确认闸——用户偏好）**——用户
  反馈"不需要我自己主动确认，你直接记住改就行了"。`MemoryService.save()` 改为：
  agent 提案默认 auto-confirm；同 key 已有 confirmed 值时——user-authored
  （`source==='user'`）受保护不被覆盖（merge 非 clobber），agent-authored 原地
  更新（refine）；值相同则幂等 no-op。`validateMemoryContent` 仍是安全底（拒
  token/完整邮件正文/禁止推断特征），在 persist 前跑，与确认无关。stub + prompt
  从"跳过已 confirmed"改为"跳过 user-authored（保护），对 agent-authored/缺失
  提案（save 更新/幂等）"。
- **`reconcile()` boot 迁移取代 `dedupe()`**——auto-confirm 后不应再有 pending；
  `reconcile()` 把存量 pending 提升为 confirmed（无 confirmed 时提升最新 pending，
  有 confirmed 时丢弃 pending）+ 每 key 留一条 confirmed。`dedupe()` 保留为别名。
- **provider 失败 graceful**——镜像 email provider partial-failure；一个 provider
  down 不杀 run，其他 provider 仍贡献 sent mail。
- **`validateMemoryContent` 兜底**——enforceTrust 已 filter，service 再校验
  （§12 deterministic last word）；被拒 proposal no-op skip 不抛错。
- **顺手补全 TypeBox union 缺失 `job_search_profile`**——pre-existing
  inconsistency，Zod 早有（`MEMORY_KEYS`），TypeBox 漏了；本里程碑修正。

**Deferred（本里程碑不做）：** per-contact 画像（按收件人分桶推断不同语气，延续
0010 contact key）；画像历史趋势（需时序存储，同 Milestone B/E deferred）；routine
preset 化每日自动刷新画像（当前 on-demand 手动触发够用）；真实 LLM 路径的
grounding 校验（当前 enforceTrust + validateMemoryContent 兜底足够）。
