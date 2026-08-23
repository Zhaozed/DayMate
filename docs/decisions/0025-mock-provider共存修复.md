# mock provider 共存修复 — sync loop 烧 LLM 的真凶

## Context

ADR 0024 退役 `auto_inbox` 后，用户反馈 dev 开着**仍在烧 token**（每 3 分钟一次）。
诊断发现：sync loop 游标**卡住不变**（`mail163LastUid` / `gmailLastInternalDate` 两次
快照完全相同），但 activity 每 180s 新增一条「邮件推断完成：…2 条待确认」—— 即每轮
都拉到 2 封邮件、跑 `classify_application_email`、游标却没推进 → 重复处理同一批邮件。

加临时 `[cursor-debug]` log 跑一轮，根因水落石出：

```
[cursor-debug] provider=gmail  fetched=0        ← 真实 Gmail，游标正确，无新邮件
[cursor-debug] provider=mail163 fetched=0       ← 真实 163，游标正确，无新邮件
[cursor-debug] provider=gmail  fetched=1        ← mock Gmail！拉到 mock-msg-003 fixture
[cursor-debug] provider=mail163 fetched=4       ← mock 163！拉到 4 个 mock fixtures
```

**`emailProviders` 里有 4 个 provider 共存**：真实 Gmail + 真实 163 + mock Gmail +
mock 163。每轮 sync loop 遍历全部 4 个，mock 两个重新喂 fixtures 给 LLM。mock 163
fixture 的 messageId 是 `'mock-163-001'`（非数字），`Number()` = NaN → 163 游标推进
条件 `Number.isFinite(uid)` 永远 false → **163 游标永不推进 → mock fixtures 每轮重复
喂 → 每轮烧 LLM**。这就是删 `auto_inbox` 后仍在烧 token 的真凶。

Verified: typecheck + lint + 394 tests（1 skipped）全绿。重启 dev 后
`[refresh] gmail=true mail163=true providers=[gmail,mail163]` —— mock 移除，首 tick
拉 0 封真实新邮件 → 静默早返回（空轮不 record activity），不再烧 LLM。

## 决策

### 1. `refreshEmailProviders` 连接真实 provider 时移除对应 mock

`container.ts` 原逻辑只 unshift/insert 真实 provider、断开时移除真实 provider，**从不
移除 mock** —— 注释说"when disconnected, remove it so the mocks take over again"，
但方向反了：连接真实时 mock 该退场，它却一直留在尾部。

修复：`mockGmail` / `mockMail163` 提为具名变量（原内联 `[new Mock..., new Mock...]`
无法引用）。`refreshEmailProviders` 里：

- 真实 Gmail connected → 真实在 index 0 + **splice 移除 mockGmail**；disconnected →
  移除真实 + 确保 mockGmail 在位（credential-free 退化路径保留）。
- 真实 163 同理。

这样连接真实邮箱后 `emailProviders = [realGmail, real163]`，mock 退场，sync loop 只
遍历真实 provider。

### 2. `refreshEmailProviders` 包 try/catch

原 `void c.refreshEmailProviders()` fire-and-forget —— 任一 `getStatus()` 抛错（keychain
读取失败等）会让整个 reconcile 静默失败、mock 永不移除。包 try/catch + `console.error`
记录，单 provider 失败不阻塞另一个的 reconcile。

### 3. 诊断 log 移除（修复确认后）

`[cursor-debug]`（application-service.ts）+ `[refresh]`（container.ts）临时 log 已
移除。保留 try/catch 的 error log（错误时才打印，正常静默）。

## 关键文件

- `src/main/app/container.ts`：`mockGmail`/`mockMail163` 具名变量 + `refreshEmailProviders`
  移除 mock 逻辑 + try/catch。

## 数据副作用（follow-up，未处理）

- Gmail 游标 `gmailLastInternalDate` 在 mock 共存期间被 mock-msg-003 的动态
  `receivedAt`（`new Date()` 附近）推进过，可能**过头**——真实 Gmail 比 boot 早的
  历史邮件可能被跳过（游标已越过它们）。163 游标未被污染（mock-163 messageId 非数字
  → NaN → 从不推进，保持真实值 `1677387265`）。
- 影响：只漏"mock 共存期间 boot 前的真实 Gmail 邮件"，**未来新邮件不受影响**（游标
  在最新位置，新邮件 internalDate > 游标会被正常拉）。若要回填，手动重置
  `settings.json` 的 `emailSync.cursor.gmailLastInternalDate = 0` 触发一次全量重扫
  （会烧一次 LLM，之后游标正确）。

## 根因复盘

mock 共存 bug 一直存在（ADR 0022 sync loop 引入时就埋下），但被 `auto_inbox` 每 30
分钟的更大烧钱量掩盖。ADR 0024 退役 `auto_inbox` 暴露了这个每 3 分钟的漏洞 —— 正是
用户「删了 auto_inbox 还在烧」的直接原因。两个 ADR 合起来才是完整止血。
