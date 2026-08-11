# 0017 — 真实 boss-cli 接入 + 字段映射对照调整

**状态:** 已完成 · **日期:** 2026-08-11 · **里程碑:** post-MVP（接续 0010 P1 的 deferred 项）

## 背景

`0010`（秋招投递管理 P1）引入了 `BossCliProvider` + `SwappableBossProvider` + container
`refreshBossProvider` 接线，但当时 **`boss` 二进制未安装**，且 mappers 是「以 mock 为准」
写的——真实 boss-cli 的 `--json` envelope 形状与 mock fixture 不同。CLAUDE.md 在
0010/0011/0013/Milestone C/D/E 反复标注 deferred：「真实 boss-cli 字段映射对照调整
（待用户安装）」。用户把 `jackwener/boss-cli` 源码 clone 到 `boss-cli/` 目录后，本里程碑
完成真实接入：安装 boss-cli + 对照命令源码修正 mappers + 单测锚定真实形状。

## 做了什么

### 1. 安装 boss-cli（系统层，可逆）
```bash
cd boss-cli && uv tool install .   # 入口点 boss = boss_cli.cli:cli
uv tool update-shell               # 把 ~/.local/bin 加进 ~/.zshenv
```
从本地源码装（非 PyPI），便于用户后续改 boss-cli。`BossCliProvider` 的
`BOSS_BIN = process.env.DAYMATE_BOSS_BIN ?? 'boss'` **无需改**——`boss` 上 PATH 即生效。
boss-cli 子目录保持 untracked（独立 git clone，不进 Daymate 仓库）。

### 2. 对照命令源码修正 mappers（`boss-cli-provider.ts`）
读了 `boss_cli/commands/{personal,social,search,auth}.py` 的 `_render` 代码，确认真实
envelope 形状后，定位并修复 4 类 bug：

- **`asArray` 容器键缺失**：原 key 列表 `['list','applications','jobs','zpData','results']`
  不含真实键 `cardList`/`interviewList`/`result`/`friendList`/`jobList` → 所有 list 命令把
  整个 `data` 对象包成单元素数组，mapper 拿到顶层对象，字段全空。补全真实键（置前）。
  **空对象守卫**：`boss chat` 无沟通时返回 `data: {}`（无 list 键），原"单对象→wrap"会
  合成 1 条全空记录；改为空对象→`[]`，非空单对象（inline record）才 wrap。
- **`mapApplication` 嵌套未解**：真实 card = `{jobInfo:{jobName,salaryDesc,securityId,…},
  brandInfo:{brandName,…}, deliverStatusDesc, updateTimeDesc, createTimeDesc}`（嵌套），
  原读扁平字段全错。改为先解 `jobInfo`/`brandInfo` 再读（缺失时 fallback 到 card 本身，
  对齐 render 代码的 `card.get(jobInfo, card)`）。`appliedAt` 改读 `updateTimeDesc`/`createTimeDesc`。
- **`mapJob` 缺 `jobExperience`/`jobDegree`**：真实 search 项用 `jobExperience`/`jobDegree`
  （`_render_job_table`），原读 `experienceName`/`degreeName` 全空。补 key（前置）。city 补
  `areaDistrict`。`skills`→`jobLabels`。
- **新增 `mapJobDetail`**：`boss detail` 的 data 嵌套 `{jobInfo, bossInfo:{name,title},
  brandComInfo:{brandName,…}}`，原 `getJobDetail` 裸调 `mapJob(data)` 把整个对象当扁平读→全错。
  新增专用映射解嵌套；`getJobDetail` 改用它。
- **`mapChat` 缺 `name` 键**：真实 friend 优先 `name`（`social.py` render），原只读
  `bossName`/`hrName`/`friendName`。补 `name` 置前；`lastMessage` 补 `lastMsg`/`lastText` 置前。
- **`mapInterview`**：扁平形状已对，仅靠 asArray 修复即生效。
- **`searchJobs` 补全筛选项**：`BossSearchQuery` 有 `industry`/`scale`/`stage`/`jobType`，
  原只传 city/salary/exp/degree/page。补全（真实搜索可用行业/规模/融资/职位类型过滤）。

mappers 现在 export（纯数据变换，无副作用），供单测直接断言。

### 3. 单测锚定真实形状（`tests/unit/boss-cli-provider.test.ts`）
用从命令源码提炼的真实形状 fixture（cardList 嵌套 jobInfo/brandInfo、interviewList、
friendList 含 name、jobList 含 jobExperience/jobDegree、detail 嵌套 jobInfo/brandComInfo/
bossInfo、空 `{}`）直接调 `map*`/`asArray` 断言。**这是 0010「mock 为准」根因的纠正**——
真实形状从此被测试锁定，不再依赖 mock fixture。

## 关键决策

- **gate 在 `credential_present` 而非 `authenticated`**（既有设计，本里程碑验证有效）：
  `boss status` 的严格 `authenticated` 在缺 `__zp_stoken__`（浏览器 JS 生成，QR 登录拿不到）
  时为 false，但 funnel 读 API（applied/interviews/chat）只需 4 个 session cookie 即工作。
  `isAuthenticated()` gate 在 `credential_present` → 有 cookie 即切 real；search/recommend 缺
  stoken → `not_authenticated` 错误 envelope → 既有 `provider_unavailable` 降级路径。
  实测：用户已有 4 cookie（`bst`/`wbg`/`wt2`/`zp_at`），`applied`/`interviews`/`chat` 返回
  正确 envelope（funnel 读路径已可用），`search` 返回 `__zp_stoken__ 已过期` 错误（降级）。
- **从本地源码 `uv tool install .` 而非 PyPI**：用户 clone 了源码，本地装便于改 boss-cli
  后重装；不提交 boss-cli 子目录（独立 git）。
- **mappers export 供单测**：纯数据变换无副作用，export 不破坏封装；测真实形状正是其职责。
- **空对象守卫**：`boss chat` 真实返回 `data: {}` 是边界场景，单测锚定防回归。
- **不改 container/scheduler/engine**：`refreshBossProvider` swap 逻辑（`container.ts:311`）
  已正确，安装后 boot 时 `boss status` 通过即切 real，未登录留 mock——镜像 Gmail/163 降级。

## 验证

- `uv tool install .` 成功，`boss --version` → `boss, version 0.3.5`。
- `uv tool update-shell` 把 `~/.local/bin` 加进 `~/.zshenv`，login shell `which boss` →
  `/Users/joey/.local/bin/boss`。
- 真实 `boss status --json` → `{credential_present:true, cookie_count:4, authenticated:false,
  reason:"缺少关键 Cookie: __zp_stoken__"}` → `isAuthenticated()` 返回 true（gate 在
  credential_present）→ swap 切 real。
- 真实 `boss applied --json` → `{ok:true, data:{cardList:[], totalCount:0}}`（形状确认，
  asArray 正确解包空 cardList → 0 投递）。
- 真实 `boss interviews --json` → `{ok:true, data:{interviewList:[]}}`（形状确认）。
- 真实 `boss chat --json` → `{ok:true, data:{}}`（空对象守卫生效 → 0 沟通）。
- 真实 `boss search "golang" --city 杭州 --json` → `{ok:false, error:{code:"not_authenticated",
  message:"环境异常 (__zp_stoken__ 已过期)"}}` → `runBoss` 抛 `BossCliError` →
  `provider_unavailable` 降级（既有路径）。
- `pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿（342 tests，较 324 + 18 新 mapper 测试）。

## Deferred

- **完整 `boss search`/`recommend`**：用户需 `boss logout && boss login`（浏览器登录补
  `__zp_stoken__`）后 search 才返回真实岗位；funnel 读路径不依赖它。
- **真实 `greet`（R3 审批）**：属原 spec P5 / Roadmap D，本里程碑只做读取真实化。
- **boss-cli 字段若与源码推导有出入**：反编译 API 可能变；单测锚定源码形状，偏差会先在
  单测暴露，再按真实 `--json` 输出调 mapper。
- **GUI 启动的 PATH**：`pnpm dev`（终端启动）`boss` 在 PATH；打包 .app 从 Finder 启动时
  PATH 可能不含 `~/.local/bin`——届时用 `DAYMATE_BOSS_BIN=/Users/joey/.local/bin/boss` 绝对
  路径或打包时注入 PATH（post-MVP 打包 follow-up）。
