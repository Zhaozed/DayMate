# 0016 — Universal packaging (arm64+x64) + cron next-fire（Milestone F）

**状态：已完成（2026-08-11）。** Release gate green：typecheck + lint + 324 tests
（1 skipped）+ build + 6 e2e（含 3× critical demo）全绿；universal `pnpm dist`
实跑通过，产物经 `lipo` 验证为真 universal。

## 背景

M4 延后了两件事（`docs/decisions/0005`）：universal（arm64+x64）打包 + cron
next-fire 计算。用户在 Milestone E 后选了方向 A（跳过对话式 Assistant，做
universal packaging），其描述显式包含「electron-builder 加 x64 目标 + cron
next-fire 计算」——故本里程碑两块都做。

经评估**主动跳过对话式 Assistant**（用户曾质问「这个产品真的需要对话式
窗口吗」）：Daymate 的身份是**主动式** agent（Routines 主动调度 + 审批闸），
不是被动式 chatbot；对话面板会扩大 §17 注入面（用户输入常含外部文本）、
审批闸让「聊着聊着就发」变慢（与 chat 的即时性冲突）、spec §1046 暗示的是
命令栏而非 chat。故对话式 Assistant 继续延后（非本里程碑范围），优先做能实跑
验证的 universal 打包 + cron next-fire。

## F1 — Universal（arm64+x64）打包

### electron-builder.yml

`mac.target` 从 `dir + dmg`（默认 host-arch）改为两个 target 都带 `arch: [universal]`：

```yaml
mac:
  target:
    - target: dir
      arch: [universal]
    - target: dmg
      arch: [universal]
```

electron-builder 对 universal：分别打包 arm64 + x64 两个 .app（`dist/mac-universal-arm64-temp`
+ `mac-universal-x64-temp`），用 `@electron/rebuild` 为每个 arch 重建原生模块，
最后 lipo 合并成 `dist/mac-universal/Daymate.app` + `Daymate-0.0.1-universal.dmg`。

### 关键阻塞 + 修复：Python 3.14 移除 distutils

better-sqlite3 的 arm64 N-API prebuilt（`bin/darwin-arm64-130/better_sqlite3.node`）
在 electron 33 arm64 下直接加载，无需源码编译。但**无 electron 33 x64 prebuilt**
→ x64 走 `@electron/rebuild` → node-gyp 9.x → `from distutils.version import
StrictVersion` → **Python 3.14（macOS 26）已移除 distutils** → `ModuleNotFoundError`
→ node-gyp exit 1 → universal 构建失败。

修复：`pip3 install setuptools`（setuptools 提供 `_distutils_hack` shim，恢复
`import distutils`）。这是标准、安全、可逆的 Python 包安装；不修改 Daymate 代码。
验证：`python3 -c "import distutils.version"` 修复前抛 ModuleNotFoundError，修复后
输出 `distutils OK`。

### 实跑验证（§23 rule 14）

`pnpm dist` 实跑通过（exit 0）。产物经 `lipo -archs` 验证为真 universal：

- `Daymate.app/Contents/MacOS/Daymate` → `x86_64 arm64` ✅
- `app.asar.unpacked/.../better_sqlite3.node` → `x86_64 arm64` ✅（**原生模块
  两 arch 都 lipo 合并**——这是 setuptools 修复的直接证据）
- `Electron Framework.framework` → `x86_64 arm64` ✅

build 日志关键行：
```
• executing @electron/rebuild  arch=x64 buildFromSource=false
• finished        moduleName=better-sqlite3 arch=x64
• executing @electron/rebuild  arch=arm64 buildFromSource=false
• finished        moduleName=better-sqlite3 arch=arm64
• packaging       arch=universal  appOutDir=dist/mac-universal
• skipped macOS code signing  reason=identity explicitly is set to null
• building        target=DMG arch=universal file=dist/Daymate-0.0.1-universal.dmg
```

产物：`Daymate-0.0.1-universal.dmg`（189 MB）+ `mac-universal/Daymate.app`。无
代码签名（`identity: null`，Gatekeeper 会警告；签名/notarization 需付费 Apple
Developer ID，继续延后）。

### build 慢的原因是下载不是编译

electron x64 二进制从 GitHub 下载花了 8 分钟（`duration=8m1.576s`，retry 1 次），
不是原生编译慢——两个 arch 的 `@electron/rebuild` 都几秒内 `finished`。后续
universal 构建会命中缓存（`~/Library/Caches/electron/electron-v33.4.11-darwin-x64.zip`
已下载）。

## F2 — Cron next-fire 计算（手写，无新依赖）

### 现状

Routines 页 `nextRun()` 对 `schedule` 触发器返回硬编码 `'见计划'`（M4 deferred）。
node-cron（已有依赖）**无 next-fire API**（只有 schedule/validate/getTasks）；加
`cron-parser` 违反 §23 rule 2。Daymate 的 cron 全是简单 daily/weekday，但
RoutineBuilder 允许用户写任意 cron，故需一个通用正确的解析器。

### 实现 `src/shared/cron.ts`（纯 + 框架无关）

`nextCronFire(expr, from?)` 手写 5-field cron next-fire：

- **字段语法**：`*` / `*/N` / `N` / `N-M` / `N-M/S` / `N/S` / 逗号列表，全覆盖
  Daymate 用的表达式（`0 18 * * 1-5`、`3 8 * * *`、`0 3 * * *`、`*/5 * * * *`）。
- **dom/dow OR-rule（Vixie cron）**：两字段都 restricted（非 `*`）→ 任一匹配即
  fire（OR）；只有一个 restricted → 该字段必须匹配（另一个 `*` 全匹配）；都不
  restricted → 每天 fire。`restricted` 标志单独追踪（`*` 的 set 含全范围值，靠
  `.has()` 统一判断；OR-rule 才需要 `restricted`）。
- **dow 归一**：cron 0-7（0 和 7 都是 Sunday），JS `getDay()` 是 0=Sun..6=Sat →
  `parseDow` 把 7 映射到 0。
- **按日推进**（不按分钟，避免慢）：月不匹配跳到下月 1 号（`setDate(1)` 在
  `setMonth` 之前，避免 Jan 31→Mar 3 滚动）；日不匹配跳到下日；日匹配则找当天
  最早 `>= 游标时间` 的 (h,m)。
- **严格大于 `from`**：游标 = `from` 下一分钟，绝不返回 `<= from`。
- **4 年 look-ahead 上限**（1461 天，日级推进 = ≤1461 次迭代，廉价）：覆盖常见
  四年一遇 Feb-29 cron；罕见 8 年世纪缺口（如 2097→2104，2100 非闰）返回 `null` →
  renderer 回退到显示原始 cron。诚实：绝不声称我们没有的精度。

### 放 `src/shared/`（非 IPC contract）

CLAUDE.md 说 shared = IPC contracts（types/schemas/constants）。`cron.ts` 是纯
util 不是 IPC contract，但**renderer 必须能 import 它**（Routines 页要用），而
sandboxed renderer 不能 import `src/main/`。`src/shared/**/*` 被 tsconfig.web +
tsconfig.node 都编译 + vitest `@shared` 别名 → 是唯一既能让 renderer import 又能
单测的位置。文件头注释显式标注「NOT an IPC contract」。

### Routines 页接线

`nextRun()` 的 `schedule` 分支从 `return '见计划'` 改为 `return nextFireHint(t.cron)
?? \`cron：${t.cron}\``——`nextFireHint` 返回 `下次 ≈ <本地化时间>`，malformed
cron 回退到显示原始 cron。其他触发器分支不变。

### 测试 `tests/unit/cron.test.ts`（23 tests）

覆盖：app 全部 cron 表达式、字段语法（逗号列表/带步长范围/单值列表/Sunday 0 vs 7）、
dom/dow OR-rule 四象限、月+闰年（Feb 29 命中 2028、Feb 30 不可能→null、月列表跨年跳过）、
严格大于 from、malformed 输入（错字段数/越界值/空）。

## 关键决策

- **跳过对话式 Assistant**——Daymate 是主动式 agent（Routines 主动调度 + 审批闸），
  不是被动式 chatbot；对话面板扩大 §17 注入面、审批闸让 chat 失去即时性、spec §1046
  暗示命令栏非 chat。优先做能实跑验证的 universal 打包。对话式 Assistant 继续延后，
  不在本里程碑范围。
- **手写 cron next-fire 无新依赖**——§23 rule 2；5-field cron next-fire ~150 行，
  项目文化是手写（ZIP writer、SVG charts、Gmail REST）。dom/dow OR-rule + 闰年算术是
  bug 高发区，用 23 个测试覆盖。
- **cron.ts 放 src/shared 非 IPC contract**——renderer 必须能 import（sandbox 不能
  import main）；shared 是唯一双 tsconfig 编译 + vitest 别名的位置。文件头标注 NOT IPC。
- **4 年 look-ahead 非 366 天**——Feb-29 cron 是合法但四年一遇；366 天 cap 会误判
  它为无 fire；4 年（日级推进廉价）覆盖常见四年一遇情况，8 年世纪缺口回退 null。
- **setuptools 修复 node-gyp/distutils 是环境层非代码层**——Python 3.14 移除
  distutils，node-gyp 9.x 依赖它；`pip3 install setuptools` 恢复 shim。不修改 Daymate
  代码；记入决策供他人复现 universal 构建。
- **universal 用 `arch: [universal]` 非 host-arch**——electron-builder 自动两 arch
  打包 + lipo；better-sqlite3 `asarUnpack` 既有配置正确处理双 arch 原生模块。

## §17 / 安全风险点

无新增注入面。F1 是打包管线（无 renderer/agent/IPC 变更）。F2 的 `cron.ts` 是纯
数值计算（不接触任何外部文本/邮件/JD）；Routines 页只是把 cron 字符串解析成时间，
不喂 agent。无 §17 风险。

## Deferred（本里程碑外）

- **代码签名 + notarization**——继续延后（需付费 Apple Developer ID；当前
  `identity: null`，Gatekeeper 警告，本地 unsigned app 可开）。
- **对话式 Assistant**（model-callable tool surface + stop action）——延续 M3/M4/M5
  延后；本里程碑主动跳过（见上「跳过对话式 Assistant」）。
- **真实 Feishu Calendar API**——待凭证（skeleton 存在）。
- **cron `timezone` 字段**——`nextCronFire` 只算本地时间；用户若设非本地时区，
  next-fire 会偏（Daymate 自有 cron 无显式时区，本地运行）。
- **8 年世纪缺口的 Feb-29 cron**——回退 null（显示原始 cron）；不声称精度。
- **electron-builder 提示移除 devDeps 冗余**——日志提示 `@electron/rebuild already
  used by electron-builder`，可移除 devDependencies 里多余的 rebuild 依赖（纯清理，
  不影响功能，留作 housekeeping）。

**Next: post-MVP 继续 — 真实 provider 激活（待凭证）、full 对话式 Assistant
（用户后续若要）、code signing/notarization（待 Apple Developer ID）；以及用户后续
提出的 Roadmap G+。**
