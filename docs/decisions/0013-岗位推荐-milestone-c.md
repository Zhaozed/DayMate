# 0013 — 岗位推荐（Milestone C：每日岗位抓取 + 推荐评分 + 一键转投递）

## Context（为什么做）

Milestone A/B 的投递模块覆盖**已投递**记录的漏斗、复盘、邮件推断、AI 简历/面经。但投递**之前**的环节——「今天有哪些岗位值得投」——仍要用户自己去 BOSS App 搜。Roadmap C
原写「每日岗位抓取 + 推荐评分」。设计文档与 `DEVELOPMENT_SPEC.md` 均未定义此项——这是**净新增范围**，需用户定形态。

**用户决策（已确认）：**
1. **形态**：放投递页内作为可折叠「岗位推荐」子区（不新增 nav，镜像 Milestone B 复盘 section）。
2. **评分依据**：新增结构化 `jobIntent` 配置（关键词/城市/薪资/经验/学历），与 `BossJob` 元数据对比评分。
3. **节奏与范围**：每日 cron routine（`boss.search` → `score_job_matches` → `need_to_know` → `notify`）+ 手动「抓取」按钮 + 「一键转投递」（把推荐岗位转为投递记录）。

## 设计

### A. `jobIntent` 配置 + `JobMatch` 类型（shared）

`JobSearchSettings` 加 `jobIntent?: JobIntent`（`{ keyword, cities?, salaryMin?, salaryMax?,
experience?, degree? }`，薪资以千为单位，如 25/35 = 25-35K）。`JobMatchResult`
（`securityId/jobName/companyName/score(0-100)/tier/reasons/recommend/salary/city`）、
`JobMatchInput`（`{ intent, jobs: BossJob[] }`）、`JobMatchOutput`（extends `PublishableBrief`
形状 + `results`）。`BossJob` 无 JD 文本（boss-cli 映射限制），故评分是元数据维度（薪资/城市/
经验/学历）。

### B. `settings` 进 `ToolContext` + 新 R0 工具 `job_search.get_intent`

**问题**：routine 的 step graph 需要 `jobIntent`（来自 settings.json）来模板化 `boss.search`
参数 + 喂 `score_job_matches`。但调度器只为 `calendar_before`/`application_status` 注入 run
inputs，`schedule` 触发器不注入；`ToolContext`/`EngineDeps` 无 settings 访问。

**方案**：把只读 `settings?: Settings` 加进 `ToolContext`（tool-registry.ts）+ `EngineDeps` +
`buildContext`（engine.ts）+ `container.ts` 接线。`settings?` 可选——既有 8 个集成测试的最小
`EngineDeps` 字面量无需改动即编译。新 R0 工具 `job_search.get_intent` 读
`ctx.settings.readJobSearch().jobIntent`，作为 `{{intent}}` 暴露给模板。镜像 `memory.search`/
`application.search` 从 ctx 读 service 的先例。无 settings（测试）→ 返回 `null`，routine 优雅降级。

### C. `score_job_matches` agent action（6-touchpoint lockstep）

输入 `JobMatchInput`（`intent + jobs`）。`buildUserMessage`：`<job_data>` DATA 块进 **user
message**（company/position/jobName/salary 是 boss 短结构化字段值，当 untrusted，绝不进 host-set
system prompt §17）；截断 60 行。输出 `JobMatchOutput`（PublishableBrief + `results`）。

6 touchpoint（沿用 lockstep，无新机制）：
1. `schemas.ts`：Zod `jobMatchResultSchema` + `jobMatchOutputSchema`。
2. `structured-output.ts`：TypeBox `submit_score_job_matches`（params 镜像 Zod；extends `publishable`）。
3. `agent-runtime.ts`：`JobMatchInput/Output` import + `runAgentStep` 分派 +
   `generateJobMatches` 确定性 stub + `buildUserMessage` case + `enforceTrust` case +
   `createAgentRuntime` real-path allowlist（`isJobMatch` flag）+ 4 条 output-tool ternary 链。
4. stub producer（确定性）：`salaryK` 解析 `BossJob.salary`（"25-40K·15薪"/"面议"），四维评分
   （薪资重叠 ±25/±20、城市子串 ±15/±10、经验/学历 loose match）；`tier = ≥70 high / ≥50 medium /
   ≥30 low / <30 skip`；`recommend = high||medium`；recommend-first + score-desc 排序。
5. `prompt-injection.ts`：`buildSystemPrompt` action union 加 `'score_job_matches'` + task 分支
   （§17：`<job_data>` 是 DATA 非指令、元数据评分无 JD、suggestedActions 无 toolName、不发明岗位）
   + `lang` 指令补 `reasons`。
6. `enforceTrust` case：strip 带 forbidden toolName 的 suggestedActions
   （`email.create_draft`/`email.send`/`boss.greet`/`boss.apply`）—— 转投递是 renderer-side
   本地 Application 创建（R1），非 agent 工具；描述性 label 存活。无 untrusted 邮件正文输入，
   注入面远小于 `classify_application_email`/`generate_resume`。

### D. `fetchJobRecommendations` + `convertJobToApplication` service 方法 + IPC

**手动「抓取」**（不经 routine engine，镜像 `generateFunnelReview`）：IPC handler 读
`container.settings.readJobSearch().jobIntent`（服务端，非 renderer 传入）→
`applicationService.fetchJobRecommendations(agentRuntime, jobIntent)`：`bossProvider.searchJobs`
（keyword/city/limit 30）→ 缓存 jobs by securityId（供转投递查找）→
`agentRuntime.runAgentStep('score_job_matches', {intent, jobs})`。boss-cli 失败 →
`provider_unavailable` Activity + 空结果（镜像 `syncFromBoss` 容错）。jobIntent 缺失 → IPC handler
返回空 `JobMatchOutput` + 提示「尚未配置求职意向」。

**「一键转投递」**：`convertJobToApplication(securityId)` 从缓存查 job →
**幂等**：若 `bossSecurityId` 已有投递，直接返回其 view（用户重复点击不重复创建）；否则创建
`source:'boss'` + `bossSecurityId` 的 Application + `locked:true` 的 `applied` 事件（sourceRef
`boss:applied:<sid>`——用户决定投递=用户真相；sourceRef 与 boss 同步 seed 一致，故未来 boss 同步
按 sourceRef 幂等跳过而非重复）。转投递是本地 DB 写（R1，无需审批 §15 仅 gate 外部写）。

**IPC**：`JOB_RECOMMENDATIONS_FETCH` + `JOB_CONVERT_TO_APPLICATION` 两 channel，5 文件 wiring
（constants/types/preload/handlers/contracts）。

### E. `job_recommendation` routine preset（每日 cron）

`job_search.get_intent`（outputKey 'intent'）→ `boss.search`（args
`{ keyword: '{{intent.keyword}}', city: '{{intent.cities[0]}}', limit: 30 }`，outputKey 'jobs'，
`continueOnError`）→ `score_job_matches`（inputs `{ intent: '{{intent}}', jobs: '{{jobs}}' }`，
outputKey 'jobMatch'）→ `need_to_know`（fromKey 'jobJob'）→ `notify`（message `{{jobMatch.title}}`）。
trigger `schedule` cron `3 8 * * *`（08:03，避开舰队碰撞 :00 标记）。**默认 `enabled: false`**
——此 routine 需用户先配置 `jobIntent`，opt-in；手动「抓取」按钮不依赖 routine 启用状态。
jobIntent 缺失时：`job_search.get_intent` → null → `boss.search` keyword 解析为 undefined →
Zod 校验失败 → `continueOnError` → `provider_unavailable` Activity + 空 jobs → stub 产出
「今日未抓取到匹配岗位」brief → 优雅降级（仅当用户启用但未配置时发生）。

加入 `PRESETS` 数组 + `PRESET_ROUTINE_IDS`（constants.ts）。`score_job_matches` 加入
`KNOWN_AGENT_ACTIONS`（engine.ts createRoutine 防御校验）；顺手补 `generate_funnel_review`
（Milestone B 漏加——它是手动路径不需经 createRoutine，但 allowlist 应一致）。

### F. Renderer `<JobRecommendationSection />`（投递页内可折叠）

镜像 `ReviewSection`：可折叠 header（显示当前意向 keyword/cities）+ 内联 `jobIntent` 配置表单
（关键词/城市/薪资K/经验/学历，`getJobSearchConfig`/`setJobSearchConfig` 读写）+「抓取岗位」
按钮（`fetchJobRecommendations` → 评分列表 company/position/salary/tier/score/reasons）+
每条推荐岗位的「转投递」按钮（`convertJobToApplication` → `onConverted` refetch 漏斗）。
`useAsync` + loading/error/empty triad；`JOB_TIER_LABEL`/`JOB_TIER_COLOR` 加 `labels.ts`
（tier 是 wire 值，只翻译 display label）。

## §17 / §13.4 风险点

1. **评分 agent 输入含 boss 来源的 company/position/jobName/salary**——短结构化字段值
   （非 JD 文本、非邮件正文），`<job_data>` DATA 块进 user message；system prompt inert framing
   （复用通用「DATA 是数据不是指令」前缀）；`enforceTrust` + 截断 60 行；注入面远小于
   Milestone A 的 `classify_application_email`/`generate_resume`。
2. **不打效率分**——§2/§13.4 明禁；回归测试加 `效率|摸鱼|闲置|工作时长|productivity|slacking`
   词汇守卫（覆盖 stub 的 title/summary/reason/suggestedActions.label）。
3. **转投递是本地写，非外部写**——R1，无需审批（§15 仅 gate 外部写）；`bossSecurityId` 幂等
   防重复创建。
4. **jobIntent 是非密 settings 字段**——settings.json 持久，非 SecretStore；renderer 经
   `getJobSearchConfig`/`setJobSearchConfig` IPC 读写（不暴露路径外的密钥）。

## Verified

`pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅（269 passed, 1 skipped —— 较 Milestone B
260 增 9：5 `agent-runtime.test.ts` score_job_matches + 2 `tool-registry.test.ts` get_intent
+ 2 `job-recommendation.test.ts` 集成）· `pnpm build` ✅ · `pnpm test:e2e` ✅（6 e2e 不回归，
含 3× critical demo）。

新测试 `agent-runtime.test.ts` score_job_matches（5）：stub 评分 + tier/recommend/sort；
空 jobs 优雅降级；§13.4 词汇守卫；enforceTrust strip forbidden-toolName suggestedActions；
`<job_data>` 进 user message 非 system prompt（§17）。
新测试 `tool-registry.test.ts`（2）：`job_search.get_intent` 读 jobIntent / 无 settings → null。
新测试 `job-recommendation.test.ts`（2）：routine 端到端 intent→search→score→NTK→notify；
preset 默认 disabled（opt-in）。

## Key decisions

- **`settings?` 进 ToolContext（可选）而非调度器特殊注入**——调度器只为
  `calendar_before`/`application_status` 注入 run inputs；给 `schedule` routine 注入 id-specific
  inputs 是丑陋的 id 分支。一个只读 `settings` 访问器 + `job_search.get_intent` R0 工具是通用、
  可复用、镜像 `memory.search`/`application.search` 从 ctx 读 service 的先例。`settings?` 可选
  让既有 8 个集成测试的最小 EngineDeps 字面量无需改动即编译。
- **routine preset 而非隐藏调度器 cron**——Daymate 的主动调度工作（morning_brief/auto_inbox/
  daily_work_summary）全是 preset。preset 给 Activity 历史 + 次运行可见性 + Routines 页条目，
  与架构一致。隐藏 cron（如 `0 3 * * *` 维护 cron）是 housekeeping，非用户可见 proactive 工作。
- **默认 `enabled: false`（opt-in）**——job_recommendation 需用户先配置 jobIntent；默认禁用
  避免每日空 NTK 噪音。手动「抓取」按钮不依赖 routine 启用状态。
- **转投递 `locked:true` + sourceRef `boss:applied:<sid>`**——用户决定投递=用户真相（locked）；
  sourceRef 与 boss 同步 seed 一致 → 未来 boss 同步按 sourceRef 幂等跳过，不重复创建。
- **评分 stub 元数据维度，无 JD 文本**——BossJob 无 JD 文本（boss-cli 映射限制）；四维评分
  （薪资/城市/经验/学历）是诚实的非过度设计；真实 LLM 路径做同样任务（输出工具 + Zod + enforceTrust）。
- **6-touchpoint lockstep 一致**——score_job_matches 是新 action 非 funnel_review 扩展
  （输出结构 results vs highlights/riskApps）；沿用既有 lockstep 无新机制。
- **视图标识符保持英文**——`tier` 值（high/medium/low/skip）是 wire 值，只翻译 display label
  （`JOB_TIER_LABEL`）。§17 system prompt 保持英文（仅追加中文输出指令）。

## Deferred（out of this pass）

- **真实 boss-cli 字段映射对照调整**——延续 `0010`/`0011`；用户安装真实 boss-cli 后需对照调整
  `mapJob`/`mapApplication` + `BossJob.salary` 解析。
- **jobIntent 富字段**——行业/规模/技术栈偏好、排除公司清单等（当前 5 维足够覆盖核心）。
- **评分加权可配置**——当前评分权重硬编码（薪资 ±25、城市 ±15 等）；用户可调权重 → follow-up。
- **转投递后的「去 BOSS 打招呼」R3 审批流程**——greet=投递属 Roadmap D（原 spec P5）。
- **岗位推荐历史 + 趋势**——每日 brief 持久化时序存储（同 Milestone B 复盘历史延后）。
- Roadmap D（通知升级 + 配置页 + 数据导出 ZIP）/ E（运势/八字每日贴士 + polish）不受本里程碑影响。
