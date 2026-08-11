# 0014 — 通知升级 + 配置页 + 数据导出 ZIP（Milestone D）

## Context（为什么做）

Roadmap D 原写「通知升级 + 配置页 + 数据导出 ZIP」。Milestone A–C 的投递模块已有富数据 + 复盘 + 岗位推荐，但三块用户体验缺口仍在：
1. **通知**——机器人气泡是唯一主动面；macOS 通知中心未接；无法按例程/类别静音；没有免打扰时段；连发会刷屏。
2. **配置**——求职意向（jobIntent）+ 基础简历路径散落在投递页内联表单，无集中配置入口；LLM/邮件集成卡片在「集成」页但与设置割裂。
3. **导出**——投递数据（投递记录 + 事件时间线 + 面经 + 简历 + 逐字稿）无法整体导出备份。

**用户决策（已确认）：**
1. **范围**：全部三块（配置页 + 通知升级 + 数据导出 ZIP）。
2. **配置页形态**：扩展现有「集成」页为「集成与设置」，原地加 section，**不新增 nav**。
3. **导出范围**：仅投递模块（applications + events + 面经 + 简历 + 逐字稿）。
4. **通知升级**：两者都要——macOS 原生通知中心 + 免打扰时段，**以及** 按例程/事件类别开关 + 聚合。

## 设计

### A. 通知偏好（非密 settings）

`NotificationPrefs`（`shared/types.ts`）：`nativeEnabled?`（系统弹窗总开关，默认 true）、`quietHours?{enabled,start,end}`（24h "HH:MM"，`end` 可早于 `start` 表跨夜）、`categories?: Partial<Record<NotificationCategory,boolean>>`（默认 true，`false` 静音该类别）、`routineOverrides?: Record<routineId,boolean>`（存在则覆盖 `routine` 类别默认）。`NOTIFICATION_CATEGORIES = ['routine','approval','info']`。非密——settings.json 持久（同 LLM/jobSearch）。`Settings` 加 `readNotifications()`/`writeNotifications()` + `normalizeNotifications()` 守护（坏时间/非布尔值丢弃而非抛）。

### B. `NotificationService`（中心化 notify 路径）

`src/main/services/notification-service.ts`，框架无关 + 同步（prefs 缓存，`refreshPrefs()` 在 boot + 每次 `setNotificationPrefs` 后刷新）。`notify(input:{message,category?,routineId?,navigateTo?})` 经四道闸：
1. **类别/例程开关**——`routineOverrides[routineId]` 存在则胜过 `categories[category]` 默认；`false` 完全静音（气泡 + 弹窗都抑制）。
2. **聚合**——同一 `category+message` 在 30s 窗口内折叠（不重复推气泡/弹窗），滑动窗口。
3. **机器人气泡**（in-app，非侵入）——非静音即推（免打扰时段仍推，因为它是应用内表面）。
4. **原生弹窗**——`nativeEnabled !== false` 且不在免打扰时段时 fire `notifier(title,body)`（容器注入 `new electron.Notification().show()`，try/catch——平台不支持/被拒不阻断 run）。

注入点：`pushBubble`（容器→`pushRobotNotify`）、`notifier`（容器→Electron Notification）、`now`（可注入时钟，测试用）。镜像 GmailFetch DI + RobotStateController 注入先例。

### C. 接线 engine + container

`EngineDeps.notifyRich?: (input) => void`（可选——既有 8 个集成测试的最小字面量无需改动即编译）。`execNotifyStep`：`notifyRich` 存在则用（带 `run.routineId` + `category:'routine'`），否则 fallback `ctx.notify(message)`（测试旧路径）。容器：构造 `NotificationService`（boot `refreshPrefs` fire-and-forget）+ `notifyRich` 闭包（`notificationService.notify(input)` + `broadcastActivity/Approvals/Memory`）+ 把审批气泡（`activityService.subscribe` 的 `approval_requested`）从直推 `pushRobotNotify` 改走 `notificationService.notify({category:'approval',navigateTo:'Approvals'})`——这样审批也有自己的类别开关 + 免打扰。

### D. 手写 ZIP writer（STORED，无新依赖）

`src/main/util/zip-writer.ts`——最小 STORED-only（无压缩）ZIP：local file header（sig 0x04034b50）+ 中央目录（0x02014b50）+ EOCD（0x06054b50）+ CRC32（预计算表）。§23 rule 2——不引新依赖（镜像 Milestone B 手写 SVG/div、Gmail 手写 REST 的「诚实非过度设计」文化）。数据量级几十到几百条 JSON，压缩收益小；STORED-only 通用兼容（Archive Utility / unzip / 7z / python zipfile 都读 method 0）。`fixedDate` 可注入（测试确定性输出）。

### E. 导出 service 方法 + IPC

`ApplicationService.exportApplicationsZip(): Uint8Array`——纯 + 框架无关（无 Electron import，可测）：`listApplications()` + `listDeletedApplications()` + `listArchivedApplications()`（active + 软删 + 归档全量）→ 每条 `listApplicationEvents` + `listResumeVersions` + `listPrepMaterials` + `listInterviewNotes()` → 每表一个 JSON dump（`applications.json`/`application_events.json`/`resume_versions.json`/`prep_materials.json`/`interview_notes.json`）+ `README.txt`（计数 + 导出时间）→ `writeZip()`。

IPC `APPLICATION_EXPORT_ZIP`：`dialog.showSaveDialog`（默认名 `daymate-投递-YYYYMMDD.zip`）→ `writeFile` → 返回路径或 `null`（取消）。本地写（R1，无需审批 §15 仅 gate 外部写）。3 个 Milestone D IPC channel（`NOTIFICATION_GET_PREFS`/`NOTIFICATION_SET_PREFS`/`APPLICATION_EXPORT_ZIP`），5 文件 wiring（constants/types/preload/handlers/contracts）。

### F. Renderer：扩展「集成」页为「集成与设置」

`Integrations.tsx` 标题改「集成与设置」；保留 Gmail/163/Feishu/LLM 卡片；新增 3 个 section（不新增 nav）：
- **`JobSearchCard`**——基础简历路径 + 逐字稿模板路径 + jobIntent（关键词/城市/薪资K/经验/学历），复用 `getJobSearchConfig`/`setJobSearchConfig` IPC（与投递页内联编辑器读写同一 settings，双向同步）。
- **`NotificationPrefsCard`**——系统弹窗总开关 + 免打扰时段（time 输入 + 跨夜提示）+ 按类别 3 开关（`NOTIFICATION_CATEGORY_LABEL` 翻译）。
- **`DataExportCard`**——「导出投递数据」按钮 → `exportApplicationsZip()` → save dialog → 结果提示。

`App.tsx` `PAGE_LABELS['Integrations']` →「集成与设置」。

## §17 / §13.4 风险点

1. **无注入面新增**——本里程碑无 agent 动作、无 untrusted 文本进模型；通知消息是例程自己的 `notify` step 输出（Daymate 持有，非外部邮件正文）；导出是本地 DB 行 JSON 化。§17 不受影响。
2. **不打效率分**——不涉及；§13.4 词汇守卫沿用既有。
3. **导出是本地写**——R1，`dialog.showSaveDialog` 用户选路径，无需审批（§15 仅 gate 外部写）。
4. **通知偏好非密**——settings.json，非 SecretStore；renderer 经 `getNotificationPrefs`/`setNotificationPrefs` IPC 读写。
5. **原生 `Notification` 失败不阻断**——平台不支持/权限被拒 → try/catch → 机器人气泡已推，run 不受影响。

## Verified

`pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅（291 passed, 1 skipped —— 较 Milestone C 269 增 22：2 `settings-notifications` + 11 `notification-service` + 4 `zip-writer` + 3 `export-applications` + 2 `notify-rich` 集成）· `pnpm build` ✅ · `pnpm test:e2e` ✅（6 e2e 不回归，含 3× critical demo）。

新测试：
- `settings-notifications.test.ts`（2）：prefs 持久 + 跨 fresh Settings 读回；坏 block 规范化（坏时间/非布尔丢弃）。
- `notification-service.test.ts`（11）：默认气泡+弹窗；类别开关完全静音；例程 override 胜过类别默认；免打扰抑制弹窗保留气泡；跨夜窗口；免打扰外弹窗；native 总开关；聚合折叠突发；不同消息不折叠；navigateTo 透传；refresh 拾取 live prefs。
- `zip-writer.test.ts`（4）：local/central/EOCD 头 + CRC；每条 local header 后接原字节；系统 `unzip` 可列名（可用时）；零条目 header-only。
- `export-applications.test.ts`（3）：active+deleted+archived 全量 + events/resumes/preps/notes 入 zip；空库 header-only；writer 自洽 round-trip。
- `notify-rich.test.ts`（2）：例程 notify step 走 notifyRich（带 routineId + category）且 plain 不被用；notifyRich 缺省时 fallback plain。

## Key decisions

- **`notifyRich` 可选 + engine fallback**——不破坏既有 `notify: (message)=>void` 契约（8 个集成测试字面量无需改）；可选 `notifyRich` 让容器注入中心化 NotificationService，engine 的 `execNotifyStep` 优先用它带 routineId/category，否则 fallback 旧路径。镜像 `settings?` 可选进 EngineDeps 的先例。
- **免打扰只抑制原生弹窗，不抑制机器人气泡**——机器人气泡是应用内非侵入表面（用户在看应用时就看到）；免打扰语义是「不打扰 OS」，不是「隐藏应用内提示」。per-category/per-routine `false` 才完全静音（含气泡）。语义清晰不矛盾。
- **聚合 30s 折叠同一 category+message**——机器人气泡一次只显示一条，连发会闪烁；折叠突发（同消息 30s 内只推一次）防刷屏。不同消息不折叠（信息不丢）。
- **手写 ZIP STORED-only 无新依赖**——§23 rule 2；数据量级小，压缩收益小；STORED 通用兼容；自验证（结构 round-trip + 系统 unzip 列名）。镜像既有「不引依赖」文化。
- **导出 service 纯 + 框架无关**——`exportApplicationsZip()` 返回 `Uint8Array`，无 Electron import（dialog/writeFile 在 IPC handler），可单测；镜像 `stats()` 纯 reduce 模式。
- **配置页扩展不新增 nav**——用户要集中配置但不要新导航项；「集成」页已是 Gmail/163/Feishu/LLM 卡片的 home，原地加 3 个 section（jobSearch/通知/导出）与架构一致。jobIntent 配置与投递页内联编辑器读写同一 settings（双向同步），不删内联（上下文编辑是好 UX）。
- **审批气泡走 NotificationService**——`approval_requested` 从直推 `pushRobotNotify` 改走 `notificationService.notify({category:'approval'})`，使审批也有自己的类别开关 + 免打扰；统一了所有 notify 路径。

## Deferred（out of this pass）

- **每例程更细粒度开关的 UI**——`routineOverrides` 后端已支持任意 routineId→boolean，但配置页只暴露类别开关（3 个）+ 系统总开关 + 免打扰；每例程单独开关的 UI 列表 → follow-up（需列例程 + 切换器）。
- **导出含非投递模块**——用户选「仅投递模块」；任务/NTK/记忆/例程配置的导出 → follow-up（需各自 list 方法 + zip entry）。
- **ZIP 压缩**——STORED-only；DEFLATE 压缩（zlib inflate 可用但 ZIP 容器需中央目录结构）→ follow-up（数据量级小，暂无必要）。
- **导入**——本里程碑只做导出；导入（解 zip → upsert 投递）→ follow-up（需幂等 upsert + 冲突策略）。
- **通知历史 / 错过通知回放**——免打扰期间抑制的原生弹窗不排队（机器人气泡保留可见性）；排队 + 回放 → follow-up。
- Roadmap E（运势/八字每日贴士 + polish）不受本里程碑影响。
