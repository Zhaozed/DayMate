# 0015 — 运势/八字每日贴士 + polish（Milestone E）

**状态：已完成（2026-08-11）。** Release gate green：typecheck + lint + 301 tests
（1 skipped）+ build + 6 e2e（含 3× critical demo）全绿。

## 背景

Roadmap E：在 Daymate 的主动调度工作（晨报/收件箱/工作总结/岗位推荐）之外，
加一个轻量、非任务、纯氛围的「每日运势」贴士；同时做两项 polish。用户经
AskUserQuestion 确认范围：

1. **运势形态**：八字每日运势（LLM 个性化）——收集生辰，新增
   `generate_daily_fortune` agent action（6-touchpoint lockstep + 确定性 stub），
   每日个性化运势 + 一条 tip。
2. **生辰存储**：settings.json（非密）——生辰（年/月/日/时 + 性别）放非密
   设置，非 SecretStore（不是凭证）。
3. **展示位置**：机器人每日气泡——每日一条 robot bubble（NOT NTK，NOT
   routine preset）。用户接受「与 Daymate 主动调度架构不一致」的取舍：这不是
   一个 Routine，是隐藏 cron。
4. **polish**（多选）：投递详情页内联富字段编辑 + 配置页精致化（每例程通知
   开关 UI）。

## E1 — 每日运势 agent action + 生辰 + cron + 气泡

### 6-touchpoint lockstep（`generate_daily_fortune`）

沿用既有 6 触点 lockstep（Zod / TypeBox / agent-runtime / buildUserMessage /
buildSystemPrompt+enforceTrust / 输出工具 ternary chain）+ `KNOWN_AGENT_ACTIONS`
allowlist（engine.ts defense-in-depth）。

- **输出** `DailyFortuneOutput = { title, summary, tip, mood }`。**故意 NOT
  PublishableBrief**——运势不发 NTK、不持久化、不复盘。
- **§17**：生辰是用户自己的可信配置（像基础简历），非外部 untrusted 文本。
  `<birth_data>` DATA 块进 **user message**（绝不进 host-set system prompt）；
  `enforceTrust` 在输出后确定性覆盖（clamp mood 到 [0,100] —— §12「确定性最后
  一道闸」，Zod 已先约束，enforceTrust 兜底）。
- **§13.4**：`mood`（0-100）是装饰性氛围数字，**绝不是效率/摸鱼分**。stub +
  prompt + 回归测试三方守住词汇（`效率|摸鱼|闲置|工作时长|productivity|slacking`）。
- **确定性 stub**：`hashSeed(date+birth)`（无 Math.random）→ 同日期同生辰得同
  运势；生肖从生辰年派生（`ZODIAC[((year-1900)%12+12)%12]`）；mood 55-94；
  无生辰时 title 退回「今日运势」通用版。真实 LLM 路径做同样任务（输出工具 +
  Zod + enforceTrust）。

### 生辰 IPC（5 文件 wiring，非密 settings.json）

`BIRTH_DATA_GET/SET/CLEAR` channel + `DaymateApi.getBirthData/setBirthData/
clearBirthData` + preload bridge + handlers（直调 `settings.readBirthData/
writeBirthData/clearBirthData`）+ contracts re-export。`Settings` 已在 Milestone D
加了 `birthData?: BirthData` 字段 + `normalizeBirthData()`（year 1900-2100 /
month 1-12 / day 1-31，越界整块丢弃；hour 0-23 / gender male|female 可选）。

### 每日 cron（隐藏，非 routine preset）

镜像 scheduler 的 maintenance cron 模式，但放在 **container**（容器已有全部
deps：`agentRuntime` + `settings` + `notificationService`；不污染 scheduler 构造
函数加 3 个新 deps）。`cron.schedule('17 8 * * *', …)`（08:17，避开舰队 :00 碰
撞）→ 读生辰 → `agentRuntime.runAgentStep('generate_daily_fortune', {birth, date})`
→ `notificationService.notify({message: title｜summary, category: 'fortune'})`。
失败仅 console.error（不影响其他工作）。

### NotificationService 'fortune' 类别

`NOTIFICATION_CATEGORIES` 加 `'fortune'`；NotificationService 的四道闸（类别
开关 → 聚合 30s → 机器人气泡 → 原生弹窗）对 fortune 生效——用户可在配置页
关掉运势气泡/弹窗，免打扰时段抑制运势原生弹窗（气泡保留）。labels.ts 加
`fortune → '每日运势'`。

## E2 — 投递详情页内联富字段编辑

`ApplicationService.updateFields(id, patch)` + `application.update_field` 工具
早已存在（Milestone A），但 renderer 无 IPC 方法、详情页富字段只读。本里程碑补
最短路径：

- `APPLICATION_UPDATE_FIELDS` IPC + `DaymateApi.updateApplicationFields(id, patch)`
  + preload + handlers（`container.applicationService.updateFields` + `broadcastApplications`）
  + contracts re-export。
- `ApplicationDetail.RichFields` 从只读 `<dl>` 重写为内联编辑表单：城市/薪资/
  阶段/阶段截止/面试链接/优先级/内推渠道/备注 为 input/select，JD 原文为
  textarea；「保存」只写**变了**的字段（minimal patch），R1 本地 DB 写无需审批
  （§15 仅 gate 外部写）；`onApplicationChanged` → refetch。
- **§17**：JD 文本编辑只是存本地（用户编辑自己的记录）；JD 喂给 agent 时仍经
  `frameJd` → user message → enforceTrust（既有 §17 路径不变）。内联编辑不引入
  新注入面。

## E3 — 配置页每例程通知开关 UI

NotificationService 的 `routineOverrides: Record<routineId, boolean>` 后端早支持
（`categoryEnabled` 先查 routineOverrides 再查 categories），但配置页只暴露类别
开关。本里程碑加 `RoutineNotifyToggles` 子区：`listRoutines()` 列全部例程 + 每
例程一个 toggle 写 `routineOverrides[id]`（`true`/absent = 通知默认；`false` =
完全静音该例程）。同时加 `BirthDataCard`（生辰输入 + 生肖预览 + 保存/清除），
让 E1 的运势功能可配置——无此卡则运势退回通用版但仍可用。

## 关键决策

- **运势是隐藏 cron 非 routine preset**——用户选「机器人每日气泡」=最轻表面；
  Daymate 的主动调度工作全是 preset（给 Activity 历史 + Routines 页条目），运势
  不是「主动调度工作」是「氛围贴士」，隐藏 cron（镜像 maintenance cron）是诚实
  的非过度设计。代价：Routines 页看不到运势条目、Activity 无运势历史——用户已
  接受此取舍。
- **生辰非密 settings.json**——生辰不是凭证（不像 LLM key/OAuth token），与
  jobIntent/notificationPrefs 同类，放非密 settings.json。`normalizeBirthData`
  越界丢弃，坏生辰只是退回通用运势，不抛错。
- **`DailyFortuneOutput` 故意 NOT PublishableBrief**——运势不发 NTK、不持久化、
  不复盘；是 on-demand 快照（每日重新生成）。若未来要持久化运势历史 → 后续。
- **mood 是装饰非效率分**——§2/§13.4 明禁效率/摸鱼分；mood 0-100 是日运氛围数字，
  stub + prompt + 回归测试三方守住。`enforceTrust` clamp mood 是 §12 兜底（Zod 已
  先约束 0-100，clamp 是防御纵深，当前两路径都不可达越界值）。
- **cron 放 container 非 scheduler**——容器已有 `agentRuntime`+`settings`+
  `notificationService` 全部 deps；放 scheduler 要加 3 个新构造参数，污染
  `RoutineScheduler` 的职责（它管 Routine 调度，运势不是 Routine）。镜像
  maintenance cron 但在 container 侧。
- **内联编辑 minimal patch**——只写变了的字段，避免覆盖未改字段（如 boss 同步
  刚写入的 city 被表单空值覆盖）。表单值与 view 值逐字段比较构造 patch。
- **每例程开关复用既有后端**——`routineOverrides` 后端早支持（Milestone D），
  E3 只补 UI（listRoutines + toggle 写 override），零后端改动。

## §17 风险点

1. **生辰喂给 LLM**——生辰是用户自己的可信配置（像基础简历），非外部 untrusted
   文本；`<birth_data>` DATA 块进 user message，绝不进 host-set system prompt；
   `enforceTrust` 兜底。注入面极小（无邮件正文/JD prose 进运势步骤）。
2. **mood 误读为效率分**——§13.4 明禁；stub 55-94、prompt 显式说明、回归测试
   守词汇。
3. **内联 JD 编辑**——JD 是 untrusted 外部文本，但内联编辑只是存本地 DB（用户
   编辑自己的记录）；JD 喂 agent 时仍经既有 §17 路径（frameJd → user message →
   enforceTrust）。不引入新注入面。

## Deferred（本里程碑外）

- 运势历史持久化 + 趋势（需时序存储，同 Milestone B 复盘历史延后）。
- 真实八字四柱推算（full BaZi pillar computation）——当前仅生肖 + 确定性 stub，
  真实 LLM 路径做同样任务；full 四柱是过度设计，留给用户配置真实命理 LLM prompt。
- 运势发 NTK / routine preset 化（若用户日后要运势进 Activity 历史）。
- 导入 ZIP（解 zip → upsert 投递，需幂等 + 冲突策略）——延续 Milestone D deferred。
- 真实 boss-cli 字段映射对照调整（延续 0010/0011/0013，待用户安装）。
- 每例程通知开关的细粒度 UI（如 per-routine 免打扰）——后端 routineOverrides 已
  支持任意 routineId，UI 只暴露开关。
