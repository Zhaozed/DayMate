# 0010 — 秋招投递管理集成 P1：BOSS 直聘漏斗

**Status:** Accepted — P1 complete
**Date:** 2026-08-10
**Spec:** `~/Desktop/Daymate-秋招投递管理集成设计.md`

## Context

秋招海投期间，投递渠道分散（BOSS 直聘 + 官网 + 内推 + 线下），状态信息散落在
BOSS App、邮件、口头沟通中，难以追踪每家公司的进度。用户希望 Daymate 作为
"纯秘书"主动管理投递漏斗。`jackwener/boss-cli`（PyPI `kabi-boss-cli`）是一个
Python CLI，封装了 BOSS 直聘的反向 API，能列出已投递/面试/沟通记录。

boss-cli 是本地运行时绑定的（子进程 + 浏览器 cookies），与 Daymate 的
Gmail/163 邮件关联需求天然契合，故集成进 Daymate 而非独立 web。

## P1 scope — read-only + local writes, zero approval risk

P1 只做**读取**与**本地写入**（手动录入投递/进展），不触发任何外部写动作，
不经审批、不碰 agent。这样能在零风险下先把漏斗面板立起来。

- **BossProvider 抽象**（`src/main/providers/boss/`）：`BossProvider` 接口 +
  `MockBossProvider`（canned fixtures，无凭证默认）+ `BossCliProvider`
  （promisified `execFile('boss', …, '--json')`，60s 超时，统一 envelope 解析，
  `BossCliError` 带 code）。`SwappableBossProvider` 委托，镜像
  `SwappableCalendarProvider`，mock↔real 热切换。
- **DB schema**（`applications` + `application_events` 表）：`applications` 在
  `boss_security_id` 上建唯一索引（boss 同步去重键）；`application_events` 在
  `application_id` + `source_ref` 上建索引（事件幂等键）。
- **ApplicationService**：事件时间线模型（非线性状态机）。每个 Application 有一
  条有序 ApplicationEvent 流；`computeStatus` = 最新事件胜出，但
  `offer`/`rejected`/`withdrawn` 终态优先（不可"撤销拒信"）。手动事件默认
  `locked`（用户真相）；boss 检测的事件 `locked:false`。boss 同步按
  `bossSecurityId` upsert 应用、按 `sourceRef` 幂等追加事件；boss-cli 失败 →
  `provider_unavailable` Activity，优雅返回（镜像邮件 provider 宕机处理）。
- **5 个 R0 只读工具**：`boss.applied` / `boss.interviews` / `boss.chat` /
  `boss.detail` / `boss.search`（全部委托 `ctx.bossProvider`）。
- **投递渲染页**（`Applications.tsx`）：漏斗分组（按 currentStatus），每卡显示
  公司/职位/来源徽标/投递日期/事件时间线 chips；"同步 BOSS"按钮、"新增投递"内联
  表单（手动录入官网/内推）、"追加进展"内联表单；`onApplicationChanged` 实时推送。

## Key decisions

- **事件时间线 > 线性状态机。** 各公司校招流程不同（有的测评+笔试，有的直接约
  面试），线性状态机会错误地把"未测评"标记为异常。事件模型只**记录观察到的**
  事件，currentStatus 由最新事件推导，不假设固定阶梯。终态优先保证
  offer/rejected/withdrawn 不会被后续非终态事件覆盖。
- **跨渠道统一漏斗。** `ApplicationSource` 枚举（`boss`/`manual`/`web`/
  `referral`/`other`）让非 BOSS 投递（官网/内推/线下）也能录入，与 boss 同步
  的记录共存于同一面板。boss-cli 没有 apply 命令（greet=投递），所以非 BOSS 渠道
  只能手动录入。
- **locked 标志 + P2 精度。** P1 仅 latest-wins + terminal-wins；完整的
  "自动事件不覆盖用户 locked 事件"优先级逻辑留给 P2（邮件推断产生自动事件时才
  有意义）。P1 先存标志、先展示，是诚实的非过度设计选择。
- **boss-cli 字段映射是防御性的。** 真实 boss-cli 输出结构以 mock fixtures 为准
  （mock 驱动测试）；`mapJob`/`mapApplication` 等用 `pick`/`str` helper 尝试多种
  key 变体。用户安装 boss-cli 后，需对照真实输出调整映射（已在代码注释标注）。
- **MockBossProvider 是无凭证默认路径。** 与 Gmail/163 的 mock 同构：未连接前
  SwappableBossProvider 持 MockBossProvider，面板可端到端跑；boss-cli 安装且
  `boss status` 通过时 `refreshBossProvider` 切换到 BossCliProvider。

## Changed files

- `src/shared/constants.ts` — `boss` provider + 应用/事件枚举 + IPC 通道
- `src/shared/types.ts` — Boss* + Application* 类型 + DaymateApi 方法
- `src/shared/schemas.ts` — application/事件 Zod schemas
- `src/main/db/schema.ts` `migration.ts` `store.ts` `sqlite-store.ts`
  `in-memory-store.ts` — 两张表 + 8 个 store 方法
- `src/main/providers/boss/` — `boss-provider.ts` `mock-boss-provider.ts`
  `boss-cli-provider.ts`（新增目录）
- `src/main/services/application-service.ts`（新增）
- `src/main/agent/tool-registry.ts` — 5 个 R0 工具
- `src/main/routines/engine.ts` — `bossProvider` 注入 ToolContext
- `src/main/app/container.ts` — 装配 + `refreshBossProvider` + `broadcastApplications`
- `src/main/ipc/handlers.ts` `contracts.ts` — 5 个 IPC handler
- `src/preload/index.ts` — typed API
- `src/renderer/workbench/src/pages/Applications.tsx`（新增）+ `labels.ts`
  + `App.tsx`（nav + 标签）

## Verification

typecheck + lint + 193 tests（1 skipped；+11 application-service 单测：手动 CRUD、
状态推导（终态优先/最新非终态/无事件默认 applied）、boss 同步（拉取 applied+
interviews+chats、幂等不重复、provider 宕机 → provider_unavailable Activity、
securityId 缺失时按公司+职位回退匹配））+ build 全部通过。

## Known limitations / Deferred

- **boss-cli 字段映射以 mock 为准**，用户安装真实 boss-cli 后需对照调整。
- **邮件→投递状态推断**（P2）：多策略匹配（域名、公司名出现在正文、牛客/北森/
  赛码等第三方平台），把邮件事件并进时间线（此时 locked 优先级才生效）。
- **投递状态推断 Routine builder step 模板**（P3）+ agent action（P4）。
- **greet（批量打招呼=投递）**（P5，R3 审批——主动外部写动作）。
- 现有 `auto_inbox` 仍硬编码 `mock-gmail-001`/`mock-163-001`（独立于本 pass）。
