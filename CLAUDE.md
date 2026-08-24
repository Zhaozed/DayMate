# Daymate — Claude Code Guide

> Living document. Update at the end of every milestone (one-line entry in the
> history table below; full write-up goes in `docs/decisions/`). Spec §23 rule 2.

## What this is

Daymate is a persistent macOS-first desktop personal work agent. It connects
Gmail, 163 Mail and Feishu Calendar, proactively executes configurable
Routines, converts important information into Tasks and Need to Know items, and
requires explicit approval before any external write action.

Authoritative product spec: `DEVELOPMENT_SPEC.md`. Read it fully before editing.

## Architecture constraints (do not violate)

- **Main process owns everything sensitive.** All credentials, Provider calls,
  Pi Agent execution, Routine scheduling and database writes run in the Electron
  main process. The renderer communicates through typed IPC only.
- **Renderer is sandboxed.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. Never expose Node.js, tokens, authorization codes, or raw
  database access to the renderer.
- **Typed IPC.** Canonical contracts live in `src/shared`. The preload is the
  only module that touches `ipcRenderer`; it exposes a typed `window.daymate`
  API via `contextBridge`.
- **Email Provider abstraction.** Business logic and Routines must not contain
  Gmail- or 163-specific branches (Spec §9).
- **Tool Registry is the only Agent path to external systems.** Pi Agent may
  select tools but cannot bypass the Tool Registry or Approval Service (§11).
- **Approval gates every external write.** R0/R1 auto, R2 approval, R3 preview +
  approval, R4 forbidden in MVP. Content cannot change between approval preview
  and execution (§15). **Exception (ADR 0022):** `email.create_draft` is R1
  (auto, no approval) — a draft only inserts into the user's own Drafts folder
  (no external side-effect; the user reviews + sends manually). The actual
  send (`email.send_draft`) stays R3 / approval-gated.
- **Keep Agent decisions separate from deterministic business rules.** Agent
  reasoning only inside explicit agent steps (§12).

## Scope exclusions (out of scope for MVP — Spec §2)

Do not implement without explicit approval: multiple agents; voice wake word;
continuous screenshots; keyboard/mouse capture; autonomous desktop control;
mobile/Windows; Slack/WeChat/Notion/Drive; public multi-user SaaS; arbitrary
NL Routine generation; automatic email sending without approval; deletion of
external data; 3D robot; productivity/slacking score.

## Tech stack

Electron · electron-vite · React + TypeScript · Tailwind CSS v4 ·
`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` · Zod ·
SQLite + Drizzle ORM · node-cron · Gmail API · IMAP/SMTP (163) · Feishu OpenAPI.

## Commands

```bash
pnpm install
pnpm dev          # electron-vite dev — launches robot + workbench
pnpm typecheck    # tsc --noEmit for node + web projects
pnpm lint
pnpm test         # vitest run
pnpm test:e2e     # Playwright — wired in Milestone 4
pnpm build        # electron-vite build
pnpm dist         # universal (arm64+x64) macOS packaging (Milestone F)
```

Do not claim a command passes unless it was actually run (Spec §23 rule 14).

## Repo layout (Spec §7)

```
src/main/        windows · agent · routines · providers · services · db · ipc
src/preload/     contextBridge bridge (only ipcRenderer surface)
src/renderer/    robot/ · workbench/  (separate HTML entries)
src/shared/      types.ts · schemas.ts · constants.ts  (IPC contracts) · cron.ts
tests/           unit/ · integration/ · e2e/
docs/            decisions/ · evaluation/ · screenshots/
```

## Milestone history

Each milestone's full "Verified" + "Key decisions" write-up lives in its ADR
under `docs/decisions/`. This table is the index — read the ADR for detail.

| # | Milestone | Status | Summary | ADR |
|---|-----------|--------|---------|-----|
| M0 | Repository & guardrails | ✅ | App launches; main+renderer compile; robot+workbench windows render; no Node API to renderer; typecheck+lint+tests+build pass. | [0001](docs/decisions/0001-m0-security-and-build.md) |
| M1 | Domain & Routine foundation | ✅ | Mock Morning Brief end-to-end; `RoutineStore` interface (Sqlite/InMemory); better-sqlite3 rebuilt for Electron; idempotent migrations; run+task idempotency; Tool Registry gates R2/R3. | [0002](docs/decisions/0002-m1-routine-engine-and-store.md) |
| M2 | Email integrations (credential-free core) | ✅ | Approval Service + content-immutability hashing (SHA-256); Auto Inbox across mock Gmail+163, dedupe by messageId; approval flow tested end-to-end; persists across real-SQLite restart. | [0003](docs/decisions/0003-m2-approval-immutability-and-providers.md) |
| M3 | Credential-free agent runtime + injection hardening | ✅ | Two agent steps key-gated (real LLM via pi-agent-core/pi-ai when key, deterministic stub otherwise); key write-only + safeStorage-encrypted; §17 prompt-injection suite; partial-failure handling; structured output via output tool + Zod re-validation; `enforceTrust` deterministic overlay; Feishu skeleton. | [0004](docs/decisions/0004-m3-agent-runtime-and-injection.md) |
| M4 | Robot surface, notifications, packaging, e2e | ✅ | `RobotStateController` derives state from Activity events; robot bubbles + quick panel + fixed-anchor resize + context menu; approval reachable from robot; Draft Review preset (R3); macOS packaging (unsigned .app + dmg); real Playwright Electron e2e (3 specs). Fixes: `resolveTemplate` array-index tokens, `resolveStepArgs` uses `run.stepOutputs`. | [0005](docs/decisions/0005-m4-robot-and-e2e.md) |
| M5 | Memory, meeting prep, work summary, routine builder, evaluation | ✅ | Memory Service (confirmed:false proposals, content guard); Meeting Prep (`calendar_before` deterministic target event); Daily Work Summary (facts only, no productivity score); custom Routine builder (8 validated step templates, defense-in-depth re-validation); evaluation (62-case dataset, 1 optimization iteration). | [0006](docs/decisions/0006-m5-memory-prep-summary-builder-eval.md) |
| Post-MVP | Gmail real OAuth | ✅ | Real OAuth 2.0 loopback flow; REST (no googleapis); safe MIME extraction; tokens in Keychain; proxy-aware `GmailFetch` via DI (Electron `net.fetch`); mutable `emailProviders` swap; `seedPresets` re-syncs. | [0007](docs/decisions/0007-gmail-real-oauth-and-proxy.md) |
| Post-MVP | 163 Mail real IMAP/SMTP | ✅ | Real IMAP+SMTP authorized by 授权码; IMAP APPEND drafts, SMTP sends exact RFC822 (content immutability); shared `mail-mime.ts`; domestic → direct TCP no proxy. Fixed two time-of-day-flaky work-summary tests. | [0008](docs/decisions/0008-mail163-real-imap-smtp.md) |
| Post-MVP | Personal profile + tone-mirrored drafts + topic inbox | ✅ | Passive town-style profile (`memoryProposals` declarative); tone-mirrored drafts (`generate_draft_reply`, `frameSentReply`); topic-based inbox classification (5 topics, `topicCounts` pre-computed); schema lockstep (6 touchpoints). | [0009](docs/decisions/0009-profile-tone-topic.md) |
| Post-MVP | 秋招投递管理 P1 (BOSS funnel) | ✅ | `BossProvider` abstraction (mock/cli/swappable); event-timeline model (non-linear, terminal-wins); cross-channel unified funnel; 5 R0 read-only boss tools; applications renderer page. | [0010](docs/decisions/0010-秋招投递管理-p1-boss-funnel.md) |
| Post-MVP | 投递模块重构 Milestone A | ✅ | Rich schema (9 cols + 3 new tables); `computeStatus` locked-priority (§17 防线); email→投递 inference (`syncFromEmails`, 3-strategy deterministic match); AI 简历/面经/逐字稿 (3 new agent actions, sandboxed iframe render); 8 new tools. | [0011](docs/decisions/0011-投递模块重构-milestone-a.md) |
| Post-MVP | 投递复盘看板 Milestone B | ✅ | `stats()` deterministic service (no store change); 2 IPC channels; `generate_funnel_review` agent action; collapsible `<ReviewSection />` in applications page (KPI tiles + funnel bar + SVG donut + AI panel). | [0012](docs/decisions/0012-投递复盘看板-milestone-b.md) |
| Post-MVP | 岗位推荐 Milestone C | ✅ | `jobIntent` config + `JobMatch` types; `settings?` in ToolContext + `job_search.get_intent` R0 tool; `score_job_matches` agent action; `fetchJobRecommendations`/`convertJobToApplication` (idempotent); `job_recommendation` daily preset (opt-in). | [0013](docs/decisions/0013-岗位推荐-milestone-c.md) |
| Post-MVP | 通知升级+配置页+导出 Milestone D | ✅ | `NotificationService` (centralized notify, 4 gates: category/routine toggle, 30s aggregate, bubble, native); `notifyRich` optional in EngineDeps; hand-written STORED ZIP writer + 投递 export; Integrations page → 集成与设置 (3 new sections). | [0014](docs/decisions/0014-通知升级-配置页-导出-milestone-d.md) |
| Post-MVP | 运势/八字每日贴士 Milestone E | ✅ | `generate_daily_fortune` agent action (mood decorative, not productivity score; `hashSeed` deterministic); 生辰 in non-secret settings; hidden daily cron in container (bubble, not NTK); polish — inline rich-field editing + per-routine notify toggle UI. | [0015](docs/decisions/0015-运势每日贴士-milestone-e.md) |
| Post-MVP | Universal packaging + cron next-fire Milestone F | ✅ | Universal (arm64+x64) packaging via electron-builder `arch:[universal]` + lipo; better-sqlite3 dual-arch (setuptools fix for Python 3.14/distutils); hand-written 5-field cron next-fire in `src/shared/cron.ts` (dom/dow OR-rule, 4-yr look-ahead). Skipped conversational Assistant. | [0016](docs/decisions/0016-universal-packaging-milestone-f.md) |
| Post-MVP | 真实 boss-cli 接入 + 字段映射对照 | ✅ | `uv tool install` from local source; fixed 4 mapper bug classes vs real envelope (asArray keys, nested jobInfo/brandInfo, `jobExperience`/`jobDegree`, `mapJobDetail`, chat `name`); unit tests anchor real shapes; gate at `credential_present`. | [0017](docs/decisions/0017-真实boss-cli接入与字段映射对照.md) |
| Post-MVP | 岗位推荐双桶重做 (校招生双投) | ✅ | Dual-bucket deterministic split (intern/campus, agent bucket-unaware); `searchJobsPaged` (new, not breaking `searchJobs`); service sequential city crawl (anti-bot, no concurrency); tier badge always shown, recommend gate removed; mock buckets by jobType. | [0018](docs/decisions/0018-岗位推荐双桶重做-校招生双投.md) |
| Post-MVP | 邮件驱动求职汇总重做 + BOSS 退场 | ✅ | BOSS UI 全隐藏 (backend dormant, reversible); per-provider incremental cursor (sinceUid/sinceInternalDate); container-resident poll loop; `classify_application_email` + jdExcerpt/city/salary; aggressive auto-create + normalized dedup (no fuzzy fallback); `web.fetch_jd` R0 tool + on-demand IPC. | [0019](docs/decisions/0019-邮件驱动求职汇总重做-boss退场.md) |
| Post-MVP | 导航精简 + 必读=晨报 + 记忆 town 画像 | ✅ | NAV 11→7 (dormant, not hard-deleted; Approvals mount kept as e2e safety net); auto_inbox drops `publish` step + clears 存量 noise; NeedToKnow=每日晨报; Memory town rewrite (inline-edit profile, `MEMORY_CONFIRM` IPC fixes same-key dedup bug, `dedupe()` boot migration). | [0020](docs/decisions/0020-导航精简-必读晨报-记忆town画像.md) |
| Post-MVP | 用户画像自动推断 (generate_persona) | ✅ | `generate_persona` agent action (sent mail = trusted via `frameSentReply`, not `frameEmail`); **取消手动确认闸** — proposals auto-confirm + merge/update (user-authored protected, agent-authored refined); `MemoryService.generatePersona` on-demand (non-routine-engine); 「待确认」section removed; TypeBox union `job_search_profile` fix. | [0021](docs/decisions/0021-用户画像自动推断-generate-persona.md) |
| Post-MVP | 瘦身：邮件驱动必读 + 草稿免审批 | ✅ | 侧栏 7→6 (面经库休眠); 裁 4 preset (draft_review/meeting_prep/daily_work_summary/job_recommendation, seedPresets boot 删旧行, agent stubs dormant); 必读只显 urgent/high; `EmailBriefingService` 钩在同步回路 tick 实时发布重要邮件 NTK (recruiting/fees/meeting → urgent, actionable → high, untrusted 跳过, sourceRef 幂等); `email.create_draft` → R1 免审批 (§15 例外, send_draft 仍 R3); approval-flow 测试改用 send_draft 锚定 §15 闸. | [0022](docs/decisions/0022-瘦身-邮件驱动必读-草稿免审批.md) |
| Post-MVP | 群发邮件确定性预过滤 | ✅ | `src/main/util/bulk-mail.ts` 纯函数层 (RFC822 路由头 + 发件人/学校名单正则, 零 LLM); `NormalizedEmail.bulk?: boolean` (§17-safe 只持久化布尔, 原始头 provider 局部); Gmail/163 normalize 时算 bulk; **分路径过滤** — 必读路径两段 (bulk 带重要关键词确定性 surface high NTK 无 LLM, 纯 bulk 跳过, 只对真人邮件跑 classify_inbox), 漏斗路径只跳纯 ads edm (投递确认信 bulk 非 ads 保留建投递); `detectTopic` 改引用共享 `ADS_KEYWORD_RE` (DRY). | [0023](docs/decisions/0023-群发邮件确定性预过滤.md) |
| Post-MVP | auto_inbox 退役 — 同步回路接管 | ✅ | `auto_inbox` preset 每 30min 无条件烧 `classify_inbox` 与同步回路 (ADR 0022/0023) 重复 + 产出落休眠 Tasks 页 (用户一天 37 次 API 根因); 从 PRESETS 移除 + RETIRED boot 删旧行 + 删模板; `email.list_all` tool dormant 保留; partial-failure 测试重锚 `syncFromEmails`; 同步回路成邮件→必读+投递唯一路径. | [0024](docs/decisions/0024-auto-inbox退役同步回路接管.md) |
| Post-MVP | mock provider 共存修复 | ✅ | `refreshEmailProviders` 原只 unshift 真实 provider 不移除 mock → `emailProviders` 真实+mock 共存 → sync loop 每 180s 喂 mock fixtures 烧 LLM (删 auto_inbox 后仍在烧的真凶; mock-163 messageId 非数字 → NaN → 163 游标永不推进 → 每轮重复); `mockGmail`/`mockMail163` 具名 + 连接时 splice 移除 mock + try/catch 防 getStatus 抛错静默失败; 重启验证 `providers=[gmail,mail163]` mock 退场. | [0025](docs/decisions/0025-mock-provider共存修复.md) |
| Post-MVP | 首页重构：天气/晨报轮播/邮件 ToDo 抽取 | ✅ | Home 三卡 (今日天气 wttr.in+LLM润色 1次/天, 今日晨报左右轮播近7天 kind 标记, 可管理 ToDo); `generate_daily_weather` agent step (无 key 确定性 stub); `todoTitle`/`dueDate` 折进已有 `classify_inbox`/`classify_application_email` (零新增 LLM); `TaskService.delete` + `sourceProvider` + `TASK_CREATE/DELETE/TASKS_CHANGED` IPC; 必读=邮件驱动 urgent/high (晨报 kind 离开必读进首页); 集成与设置加天气城市. | [0026](docs/decisions/0026-首页重构-天气晨报轮播-todo自动抽取.md) |
| Post-MVP | ToDo 重构：删 Mock + 中文标题 + 类型/来源 + 学校垃圾过滤 + 60 天冷启动 | ✅ | 一次性 purge email-origin task + mock/demo 投递 (purgeDone 标志); `TaskCategory` (学校/求职/账单/会议/其他) + `sourceLink` 列 (ALTER 幂等); stub todoTitle 改发件人+topic 派生 (绝不内嵌 subject); `[student_ips]` 主题子串 pre-LLM 过滤 (`isSchoolSpam`, 零 LLM); 60 天冷启动回填 (`listAllSince` 翻页 + `listBackfill`, per-accountId `coldStartDone` 与游标分离, 只跑必读路径, 批 20 skipDrafts, Gmail 封顶 2000); TODO_GET/SET/COLD_START IPC + 集成与设置「邮件待办设置」. | [0027](docs/decisions/0027-todo-重构.md) |
| Post-MVP | 邮件过滤紧急修复 | ✅ | 必读 surface 尊重 LLM `ignore` 判定 (LinkedIn 群发招聘广告不再当 urgent surface); 删 bulk-surface 路径 (29 条【通知】垃圾根因, bulk 永不进必读/永不产 ToDo/零 LLM); 漏斗置信度闸 (low/缺公司岗位 → pending 不建投递, 假 Universiti Malaya 根因); prompt 强化 (automated/marketing→ignore, 招聘外联→low confidence); bulk 检测拓宽 (BULK_SENDER_CONTAINS_RE catch jobs-noreply/railway-noreply, PREFIX_RE catch alerts/notice/deploy); `demoSeeded` 一次性闸 + PURGE_VERSION→4 (seedDemoData 重种 tug-of-war 终结, demo 投递永久 0); purgeVersion 版本化闸. | [0028](docs/decisions/0028-邮件过滤紧急修复.md) |
| Post-MVP | 必读页重构：线程聚合 + 4 类分区 | ✅ | 去晨报化 (页头"每日晨报"→"必读", 删"运行晨报"+"清空全部"按钮); 线程聚合 (同线程多封折叠一项, one-NTK-per-thread by list() scan, Gmail 原生 threadId / 163 从 References/In-Reply-To/Message-Id 合成 + 根 Message-Id 剥角括号; `update()` 追加 sourceRef 幂等); 整线程 lazy 拉取 (`EMAIL_THREAD_GET` IPC + `provider.getThread`: Gmail threads.get / 163 best-effort IMAP header search `safeSearch`, R0 只读不持久化, 失败回退 surfaced); 4 值 `BriefingCategory` (学校/求职/日常/其他, 与 Task 5 值区分) 作分区头; NTK 加 threadId/briefingCategory/sourceProvider/sourceAccountId/sourceLink/updatedAt; 过滤放宽 (ADR 0028 bulk 全丢取消 → 操作触发 bulk keep+classify; **surface 闸 = `important\|\|actionable`, LLM `ignore` 始终尊重** — v7 原 `operationTriggered` 覆盖臂把 Grab/马来营销 bulk 当操作触发 surface 成 medium 涌进必读, v8 删除, 操作触发邮件靠 important topic 投递/面试→recruiting 账单→fees_billing 会议→meeting 捕到; 验证码/安全提醒/纯 ads/spam 仍 drop pre-LLM); title 去掉【topic】前缀; source provider 徽章+深链 (Gmail 真深链, 163 webmail 根不造假); prompt 放宽 automated→information/unsolicited→ignore + briefingCategory 每 surface 必填; `enforceTrust` 剥 briefingCategory; PURGE_VERSION→8 (v7 重建旧 NTK + v8 清 v7 放进之 Grab 垃圾, mail163 必读 27→1). | [0029](docs/decisions/0029-必读页重构-线程聚合-4类分区.md) |
| Post-MVP | 邮件同步回路自愈 | ✅ | 同步回路静默停滞 bug (provider 调用挂起永不 reject → setInterval 堆叠挂起 tick → 不打日志不恢复, "今天收到邮件却没进必读"); 三层自愈 (provider 无关): per-tick 硬超时 `Promise.race` deadline (clamp 60-120s, 挂起→reject→打超时 Activity→释 inFlight→下一轮新连接) + inFlight 重叠跳过 (不堆 pending) + 看门狗/断路器 (3×interval 无 settle→强制 tick; 5×interval 仍 inFlight→超时机器失效→强重置 inFlight) + `powerMonitor 'resume'` 唤醒即时同步 (setInterval 睡眠不补跑 slot); 修了 ADR 0027 遗留日期炸弹测试 (`application-service` demote 用相对 `Date.now()-N*DAY`); 不改 ADR 0024 空 delta 静默语义. | [0030](docs/decisions/0030-邮件同步回路自愈.md) |
| Post-MVP | 邮件同步游标自纠正 | ✅ | ADR 0030 hang 自愈治不了的"幽灵停滞" (provider 连着 real=2、无报错/超时/Activity, 却 newEmails=0): 根因 ADR 0025 未修 follow-up — mock 当初把 `gmailLastInternalDate` 推到未来值, mock 移除后游标留靠前于真实最新邮件 (Aug22 16:00 UTC vs 真实 Aug21 14:11) → 每轮 `listMessages` 带靠前游标 → 全部 `<=游标` → 第一封 break → 返回 `[]` → newEmails=0, 与"无新邮件"静默不可区分 (ADR 0024). 游标自纠正一层 (ADR 0030 之上): 空 delta 时无游标探针 `listMessages({limit:1})` 取真实最新 (R0 只读), 游标靠前即回退到 `newest-1` (Gmail ts-1ms / 163 uid-1) + `setTimeout(tick,3s)` 立即重跑解封被挡邮件 + `rewoundProviders` Set 每会话每 provider 至多回退一次 (污染一次性历史遗留; 防探针竞态致每 180s 重复回退烧 LLM); 实跑验证回退解封 3 封被挡真邮件, 下一轮稳定无循环. | [0031](docs/decisions/0031-邮件同步游标自纠正.md) |

### Current state & next

- **Real providers:** Gmail ✅ activated · 163 ✅ activated · Feishu Calendar
  (skeleton, activates on creds) · LLM key ✅ (write-only, safeStorage) ·
  boss-cli ✅ installed but **BOSS UI 全隐藏** (ADR 0019 — anti-bot wall;
  backend dormant, reversible).
- **Navigation (6):** 首页 / 必读 / 投递 / 例程 / 记忆 / 集成与设置.
  (Assistant/Tasks/Approvals/Activity/InterviewNotes dormant — ADR 0020/0022.)
- **Routines (2 presets):** morning_brief · interview_prep.
  Retired (dormant / boot-purged): auto_inbox (ADR 0024 — duplicated the sync
  loop, burned LLM every 30min unconditionally) / draft_review / meeting_prep
  / daily_work_summary / job_recommendation (ADR 0022).
- **必读 = 各来源信息汇总（ADR 0029 重构，去晨报化）:** NOT the morning brief —
  it is the consolidated view of everything important from connected sources
  (Gmail+163 now, more apps later). Page header is "必读" (was "每日晨报"); the
  "运行晨报" + "清空全部" buttons are gone. **Thread-aggregated:** emails in the
  same conversation collapse into ONE item (Gmail native threadId; 163
  synthesized from References/In-Reply-To/Message-Id headers — root Message-Id
  angle-brackets stripped so it matches the bare id replies reference). Expanding
  an item lazily fetches the WHOLE thread (new `EMAIL_THREAD_GET` IPC →
  `provider.getThread`: Gmail `threads.get`, 163 best-effort IMAP header search
  via `safeSearch`; both R0 read-only, never persisted, return [] on failure →
  renderer falls back to surfaced sourceRefs); surfaced 必读 emails are starred
  within the thread. **4-class sections** (学校/求职/日常/其他) via the new
  4-value `BriefingCategory` (distinct from the 5-value `TaskCategory` for
  ToDos); priority is now just an in-item badge. NTK carries
  `threadId`/`briefingCategory`/`sourceProvider`/`sourceAccountId`/`sourceLink`/
  `updatedAt`; thread-merge by scanning `needToKnowService.list()` for a matching
  threadId (one-NTK-per-thread), `update()` appends sourceRefs idempotently.
  Title is the model's Chinese summary (`r.reason`), NOT the raw subject —
  the raw email subject is demoted to a small subtitle (from `sourceRefs[].label`) so the user sees the summary headline + original line below (v9 user feedback: "你总结的中文放标题，真邮件标题放下面").
  Source provider badge + deep link (Gmail real per-message link; 163 webmail
  root — not faked). **过滤放宽 (ADR 0029, v8-corrected):** the ADR 0028 "drop
  ALL bulk" bar is LIFTED — pure ads, verification codes, security alerts, and
  school-spam are still dropped pre-LLM (`shouldSkipBriefing` +
  `VERIFICATION_CODE_RE` / `SECURITY_ALERT_RE`), but operation-triggered bulk
  (投递确认/面试通知/报名成功/收据/回执) now KEEPS and flows to `classify_inbox`
  (NOT dropped pre-LLM). **Surface gate = `important || actionable`** (important =
  recruiting/fees_billing/meeting topic; actionable = reply/follow_up); the LLM
  `ignore` verdict is ALWAYS respected, even for bulk. v7 shipped a broken
  `operationTriggered = isBulkMail(email)` arm that force-surfaced ANY bulk
  clearing the pre-LLM gate as `medium` (overriding LLM `ignore`) → Grab/Malay
  promo marketing ("Flash Sale"/"Deals"/"Diskaun") the narrow `ADS_KEYWORD_RE`
  missed flooded 必读 ("啥内容都没有啊"). v8 DELETED that arm: operation-triggered
  mail the user wants surfaces via its important topic (投递/面试→recruiting,
  账单/收据→fees_billing, 会议/邀请→meeting); general-topic bulk (Grab promos,
  email confirmations, GitHub OAuth) does NOT surface even if hedged
  `information`. Untrusted mail is skipped (§17, `enforceTrust` also strips
  `briefingCategory`). **前史 (ADR 0028):** mock calendar leak + ToDo title fix
  still apply — `MockCalendarProvider.setRealMode(true)` mutes `listEvents`→`[]`
  when a real email provider is connected; `todoTitle` ≤25 字 with the specific
  object. **PURGE_VERSION=9** — v7 rebuilt old one-per-email NTKs; v8 cleared
  the v7-broken-arm Grab-marketing junk (mail163 必读 27→1); v9 rebuilds NTKs
  with the new headline=reason title (was title=subject) so the Chinese-summary
  headline + subject-subtitle layout applies to existing items too. ToDo
  todoTitle cap widened 25→40 chars (prompt) so the advisor/sender name fits.
  Funnel path: confidence gate unchanged (low/missing company+position → pending,
  not created); only skips pure ads edm (投递确认 bulk-but-not-ads kept → builds
  投递). `seedDemoData` gated by one-time `demoSeeded` flag.
- **Memory:** auto-confirm + merge/update (no manual gate — user preference,
  ADR 0021). `validateMemoryContent` still the safety floor.
- **首页 (ADR 0026):** three cards — 今日天气 (real wttr.in + LLM-polished
  穿衣/宜忌, cached daily via `generate_daily_weather` agent step, city default
  北京 configurable on 集成与设置), 今日晨报 (swipeable carousel over the last ~7
  days' morning-brief NTKs, tagged `kind='morning_brief'` so they leave 必读), and
  我的 ToDo (manageable: create/edit/complete/delete via `TASK_CREATE`/`TASK_DELETE`
  + `TASKS_CHANGED` live push). **Mail auto-extracted ToDos:** `todoTitle`/`dueDate`
  are folded into the already-running `classify_inbox` (必读 path) +
  `classify_application_email` (漏斗 path) — **zero new LLM call**; only the model
  (or the stub's reply/follow_up + 面试/笔试 rules) filling `todoTitle` creates a
  ToDo (the "没用的别生产" filter), with `sourceProvider` (163/Gmail) badge +
  topic-mapped priority + parsed dueDate. Untrusted mail never produces a ToDo (§17
  `enforceTrust` strips `todoTitle`/`dueDate`/`category`).
- **ToDo 重构 (ADR 0027):** readable Chinese titles (stub builds `回复/跟进 <sender>（<topic>）`,
  never embeds the raw subject — fixes unreadable `跟进：1677387239`), `TaskCategory`
  (学校/求职/账单/会议/其他) + `sourceLink` (Gmail deep link; 163 has none) columns.
  One-time `purgeEmailOriginTasks` (gated by `settings.todo.purgeDone`) clears all
  email-origin tasks + mock/demo 投递 so the cold-start regenerates readable titles.
  `[student_ips]` school-wide broadcast is filtered by subject-substring
  (`isSchoolSpam`) BEFORE any LLM call — never a ToDo, never reaches classify. 60-day
  cold-start backfill (`EmailBriefingService.backfillAccount` + Gmail `listAllSince`
  nextPageToken paging + `listBackfill`) runs once per connected account on connect
  (per-accountId `coldStartDone`, SEPARATE from the incremental cursor), 必读 path
  only (漏斗 stays incremental — cost halved), batched 20 with `skipDrafts` so it
  doesn't burn `generate_draft_reply`. Manual re-scan button on 集成与设置.
- **Conversational Assistant:** intentionally skipped (ADR 0016 — Daymate is a
  proactive agent, not a chatbot).
- **Next (post-MVP):** real Feishu Calendar activation (on creds); code
  signing/notarization (needs paid Apple Developer ID); per-contact persona;
  history/trend persistence (funnel review / fortune / NTK); ZIP import;
  merge auto_inbox into the sync loop; delete dormant agent actions
  (meeting_prep/work_summary/score_job_matches).

## Working rules (Spec §23)

1. Implement one milestone at a time. 2. Do not add dependencies without
explaining why. 3. Do not expand scope. 4. Never hardcode credentials or expose
secrets through IPC. 5. Use typed schemas for external and model outputs.
6. Use mock providers before real integrations. 7. Add tests for approval and
idempotency before email sending. 8. Record architecture decisions under
`docs/decisions/`. 9. After each milestone run typecheck, tests and the critical
flow; report changed files, tests, known limitations and next milestone.

> When adding a new milestone: add ONE row to the table above (summary +
> ADR link) and write the full Verified + Key decisions write-up in a new
> `docs/decisions/00NN-*.md` ADR. Do NOT inline the full write-up here — this
> file is an index, not a transcript.
