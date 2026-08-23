# auto_inbox 例程退役 — 同步回路接管

## Context

ADR 0022 把必读改成「邮件驱动实时」后，容器的邮件同步回路（每 180s）已经在跑
`classify_inbox`（必读）+ `classify_application_email`（投递漏斗），ADR 0023 又加了
群发预过滤。但 **`auto_inbox` preset 例程仍然在 `PRESETS` 里、`enabled: true`**，
被 scheduler 每 30 分钟拉起一次（`auto-inbox.ts:21-24` `email_poll intervalMinutes:30`），
里面有一个 `classify_inbox` agent step（`:48-55`）—— **每 30 分钟无条件烧一次 LLM**，
不管有没有新邮件。

用户实测：开着 Daymate 一天请求了 **37 次 API**（≈ 18.5 小时 × 每 30 分钟一次）。
根因正是 `auto_inbox` 跟同步回路**重复跑 `classify_inbox`**：

| | `auto_inbox` 例程 | 同步回路（ADR 0022/0023） |
|---|---|---|
| 频率 | 每 30 分钟 | 每 3 分钟（游标增量） |
| 拉邮件 | 每次重拉 50 封未读 | 游标增量（只拉新的） |
| classify_inbox | 每次全量烧 LLM | 只对增量 + 群发预过滤后烧 |
| 群发预过滤 | ❌ 无 | ✅ ADR 0023 |
| 产出落地 | Tasks 页（ADR 0020 已休眠） | 必读 urgent/high + 投递漏斗 |

`auto_inbox` 烧的 LLM 分类结果落到 Tasks 模块，而 Tasks 页在 ADR 0020 就休眠了（侧栏
6 项无 Tasks）—— 纯重复烧钱、产出无人看。ADR 0022 follow-up 早写了「merge auto_inbox
into the sync loop」，本 ADR 执行退役。

Verified: typecheck + lint + 394 tests（1 skipped）+ e2e 3 次全绿。`partial-failure.test.ts`
从锚定 `auto_inbox` 例程改为锚定 `syncFromEmails`（同一 partial-failure 维度，M3 §17）。

## 决策

### 1. 从 PRESETS 移除 + boot 删存量行（跟 ADR 0022 退役 4 preset 同模式）

- `presets.ts`：`PRESETS` 去掉 `autoInboxTemplate` + import；`RETIRED_PRESET_IDS` 加
  `'auto_inbox'`。`seedPresets` boot 时删存量 DB 行 → 旧 schedule 停止触发。
- `src/shared/constants.ts` `PRESET_ROUTINE_IDS` 去掉 `'auto_inbox'`（renderer 隐藏 Delete
  的 preset 集合同步）。
- 删模板文件 `src/main/routines/templates/auto-inbox.ts`。

### 2. `email.list_all` tool dormant 保留（不删）

`auto_inbox` 是 `email.list_all` 工具的唯一调用方，但该 tool 注册在 Tool Registry 表里
（`tool-registry.ts:264`），不触发 `noUnusedLocals`，保留无害、可逆。on-demand IPC 仍
可调。同步回路用的是各 provider 的 `listMessages`（游标增量），不依赖 `email.list_all`。

### 3. partial-failure 测试重锚到同步回路

原 `partial-failure.test.ts` 用 `engine.run('auto_inbox')` 锚定 M3 §17 partial-failure
（一个 provider 挂不杀整流程）。例程删了，改测 `syncFromEmails`：163 provider
`listMessages` 抛 → service catch → `provider_unavailable` Activity，Gmail 邮件照常分类 +
建投递。同一 spec 维度，新锚点更贴近真实运行路径（同步回路是 container 的实际入口）。

### 4. 同步回路接管全部邮件驱动路径

`auto_inbox` 退役后，邮件 → 必读 + 投递漏斗**唯一**路径是 container 的同步回路
（`container.ts:456`，ADR 0022/0023）：
- 增量游标（per-provider sinceUid / sinceInternalDate，不重复烧）。
- 投递漏斗（群发预过滤后 `classify_application_email`，激进自动建投递）。
- 必读（bulk 带关键词确定性 surface / 真人邮件 `classify_inbox` / 回复需求 `generate_draft_reply`）。

## 关键文件

- `src/main/routines/presets.ts`（PRESETS - 1 + RETIRED + 1）
- `src/shared/constants.ts`（PRESET_ROUTINE_IDS - 1）
- 删 `src/main/routines/templates/auto-inbox.ts`
- 删 `tests/integration/auto-inbox.test.ts`（专测 auto_inbox 例程；classify_inbox untrusted
  行为已被 eval.test.ts + email-briefing-service.test.ts 覆盖）
- 重写 `tests/integration/partial-failure.test.ts`（锚 `syncFromEmails`）
- `tests/unit/routine-schema.test.ts`（去 autoInboxTemplate）
- `tests/unit/settings-notifications.test.ts`（routineOverrides `auto_inbox` → `interview_prep`）
- `tests/unit/notification-service.test.ts`（routineId `auto_inbox` → `interview_prep`）
- `tests/e2e/demo.spec.ts`（auto_inbox 断言 true → false，移入 retired 块）
- `src/main/app/container.ts`（auto_inbox cleanup 注释更新）

## 降本效果

- 每天 **-48 次** 无条件 `classify_inbox` LLM 调用（每 30 分钟一次 → 0）。
- 邮件分类唯一路径 = 游标增量同步回路（只对新邮件烧 + 群发预过滤）。
- 这是用户「开着就在烧 token」的直接止血点。

## 现存 LLM 调用源（退役后盘点）

| 源 | 频率 | 备注 |
|---|---|---|
| 同步回路 `classify_inbox` | 每 180s，仅增量 + 仅真人邮件 | ADR 0022/0023，已优化 |
| 同步回路 `classify_application_email` | 每 180s，仅增量 + 非纯 ads | ADR 0019/0023 |
| 同步回路 `generate_draft_reply` | 仅回复需求重要真人邮件 | ADR 0022 |
| `morning_brief` | cron `0 9 * * 1-5`（工作日 9 点 1 次） | 1 次/工作日 |
| `generate_daily_fortune` | cron `17 8 * * *` | 1 次/天 |
| `interview_prep` | `application_status` poller 每 60s | 仅对 interview 状态无 prep 的投递；prep 生成后 app 退出候选 |
| `generate_persona` | on-demand（非 routine） | 用户触发 |

## Follow-up

- `interview_prep` 的 60s poller 若有投递卡 interview + prep 生成失败会每分钟重试烧 LLM
  ——需确认 prep 生成失败时是否落入持续重试循环（idempotency key 固定挡不住「未生成
  prep」的候选）。如真，加退避或失败标记。
- `email.list_all` tool 长期 dormant 可考虑删（本 ADR 保留可逆）。
