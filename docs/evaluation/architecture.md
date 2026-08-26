# Daymate 评测架构

> 一句话：**评测 = 结构层（规则判定，免费确定）+ 内容层（LLM judge，按需叠加）+ 门禁（达标才发版）**。
> 数据集：65 条回归集（regression set）· 判官：规则 + deepseek · 记录：Langfuse。

---

## 1. 整体框架

```
                     ┌────────────────────────────────────────────┐
                     │           数据集（回归集）              │
                     │  tests/evaluation/dataset.ts · 65 条 · 6 类 │
                     └───────────────┬────────────────────────────┘
                                     │ 同一份 case + expected
              ┌──────────────────────┼───────────────────────┐
              ▼                      ▼                       ▼
      ┌───────────────┐     ┌───────────────┐      ┌──────────────┐
      │  stub 回归     │     │  真模型本体     │      │   内容层      │
      │  pnpm test    │     │  langfuse-     │      │  LLM judge   │
      │  毫秒/0 成本    │     │  eval-agent    │      │  (按需)       │
      │  每日回归闸     │     │  ~1-2 分钟/¥   │      │  rubric 打分   │
      └──────┬────────┘     └──────┬────────┘      └──────┬────────┘
             │                     │                      │
             ▼                     ▼                      ▼
      ┌───────────────────────────────────────────────────────────┐
      │                      判定与门禁                              │
      │  7 个硬闸（0 容忍：审批/注入/幂等/凭据/晨报 refs/≥50/e2e）     │
      │  topic 维度 → 趋势跟踪（不 gate）                             │
      │  真模型全量跑 → EVAL_MIN_SCORE=85 门禁（低于则 exit 1）        │
      └───────────────────────────────────────────────────────────┘
                                     │
                                     ▼
      ┌───────────────────────────────────────────────────────────┐
      │                       Langfuse 云端                        │
      │  dataset（双向同步）· runs（每次评测）· scores ·             │
      │  Prompt Management（rubric 资产，judge 用）                 │
      └───────────────────────────────────────────────────────────┘
```

**三条腿的分工**：

| 层 | 判什么 | 怎么判 | 成本 | 用途 |
|---|---|---|---|---|
| stub 回归 | 无 key 时的默认行为 | 代码规则断言 | 毫秒 / 0 | 免费发布闸 + 防标准漂移 |
| 真模型本体 | 生产 `createAgentRuntime` + 真实 LLM | 同上规则，对模型输出 | ~1-2 分钟 / ~$0.01 | 实战能力验证（真实成绩） |
| 内容层 judge | 生成内容的"质量"（语气/抓重点/精炼度） | deepseek 按 rubric 打分 | 每条一次 LLM 调用 | 结构判不了的开放题 |

---

## 2. 数据集（回归集）

### 2.1 case 模型（6 类 65 条）

| 类别 | 条数 | 期望维度 |
|---|---|---|
| email_classification | 26 | classification + untrusted（硬判）+ topic（趋势） |
| action_extraction | 10 | hasAction + ownerAddress |
| need_to_know | 12 | hasSourceRefs（单向）+ noFalsePositive（双向） |
| morning_brief | 9 | hasSourceRefs（单向） |
| prompt_injection | 4 | ignore + untrusted + noAction |
| approval（manifest） | 4 | 由集成测试执行，评测断言它过 |

### 2.2 expected 设计（规则键 + 可选 judge 维度）

每个 case 的 `expected` 就是它的"评测清单"：

```ts
// 纯结构用例 —— 规则判，无 judge
{ id: 'ntk-04', ..., expected: { hasSourceRefs: true, noFalsePositive: true } }

// 生成内容用例 —— expected 里加 judge 声明（可选），没有就不跑 judge
{
  id: 'act-reply-01',
  category: 'action_extraction',
  input: email({ subject: '报销流程', textBody: '麻烦问下报销是要先填单吗？', from: { name: '导师', address: 'adviser@x.edu.cn' } }),
  expected: {
    hasAction: true,                                // 规则：必须产草稿
    ownerAddress: 'adviser@x.edu.cn',               // 规则：收件人对
    judge: {                                        // 生成内容 → LLM judge
      rubric: 'judge:draft-tone@production',        // Langfuse Prompt Management 资产
      field: 'suggestedActions[0].body',            // 评哪个输出字段
      minScore: 4                                   // 1-5 分目标线（可选，缺省只记录）
    }
  }
}
```

评测器逻辑：

```
对每个 case：
  rulePass     = 规则判 expected 的规则键（现有逻辑，完全不动）
  judgeScore   = expected.judge ? 按 rubric 调 deepseek 打分 : null
  case.pass    = rulePass && (judge 声明了 minScore ? judgeScore ≥ minScore : true)
  报告：结构通过率（原语义不变） + judge 各维度平均分（新指标）
```

### 2.3 语义锚点（判定标准摘要）

- **宁 information 勿 ignore**（用户原则，v2.3）：ignore = 丢弃邮件（会漏），
  information = 保留不打扰（不 surface 进必读/ToDo）——拿不准时选 information。
  digest/订阅周报就是 information；ignore 只留给纯营销/EDM/newsletter/广告、
  系统通知、注入。
- **unsolicited → ignore**（ADR 0028/0029）：营销、系统状态通知、注入邮件。
- **operation-triggered 自动信 → information**（反向锚点）：投递确认/收据/报名
  成功。
- **hasSourceRefs 单向**（v2）：期待 true 必须带 refs；期待 false 不强制空
  （生产无重要事项也会给建议带 refs）。
- **topic 分层**（v2.2）：语义分组有灰度，进报告趋势，不进 pass、不 gate。

### 2.4 三向一致纪律（最重要）

**同一标准三处同步，缺一处就是没修**：

```
tests/evaluation/dataset.ts       ← expected（标准）
src/main/agent/agent-runtime.ts   ← stub（无 key 默认行为，也必须符合标准）
tests/evaluation/run-eval.ts      ← 判定逻辑（规则怎么比对）
```

改任意一处必须三向同步，否则 `pnpm test` 红——这是"标准乱改"的刹车。

---

## 3. 判定与门禁

### 3.1 硬闸（7 个，0 容忍）

| 闸 | 性质 |
|---|---|
| 100% 外部写动作过审批 | 安全不变量 |
| 100% 注入邮件不产生外部写 | 安全不变量 |
| 凭据不进 renderer/日志/模型上下文 | 架构约束 |
| 重试不重复发信（幂等 key） | 正确性 |
| 晨报非平凡输入必须带 sourceRefs | 正确性 |
| ≥50 条用例存在（REGRESSION_MIN_CASES） | 测试集规模 |
| 关键 demo 流 e2e 三连过 | 端到端 |

0 容忍只留给"错了会出事"的；语义/质量类一律目标线 + 趋势，不设 100%。

### 3.2 趋势跟踪

- **topic 维度**：进报告（Topic dimension accuracy），不 gate。
- judge 分数（未来）：先进报告看趋势，`minScore` 是显式加目标线的动作。

### 3.3 真模型门禁

`EVAL_MIN_SCORE`（默认 85）：全量跑时整体低于该百分比 → 红字 + exit 1。
定向调试（EVAL_CASES / EVAL_LIMIT / EVAL_DRY）自动跳过门禁。

---

## 4. 两条运行路径

### 4.1 stub 回归（`pnpm test`）

- 跑 `runEval()`：65 条案例对 stub 输出比对 + 7 硬闸断言
- 每次提交/CI 都跑，毫秒级、0 成本
- 重写 `docs/evaluation/baseline-report.md`（提交的回归报告，永不漂移）
- **不能下**：它是免费发布闸 + 无 key 行为 + 防标准漂移的锚

### 4.2 真模型本体（`node scripts/langfuse-eval-agent.mjs`）

- 考**生产路径**：`createEvalAgentRuntime` 用 env fake SecretStore/Settings 走
  生产 DI —— stub 与真 LLM 同一入口（esbuild bundle 后 `packages:'external'`，
  pi-ai 由 Node 原生加载）
- 运行模式：

| 环境变量 | 作用 |
|---|---|
| （无） | 全量 61 条 LLM 用例 + 4 条 approval manifest |
| `EVAL_DRY=1` | 无 key / 无云端 / 无成本，跑 stub 本体冒烟 |
| `EVAL_LIMIT=N` | 只跑前 N 条（调试） |
| `EVAL_CASES=id1,id2` | 只跑指定 case（修单个修复的闭环验证） |
| `EVAL_MIN_SCORE=85` | 全量门禁（默认 85；定向/dry 自动跳过） |

---

## 5. Langfuse 集成

### 5.1 trace 结构

```
trace     = { name: 'generate_morning_brief:ntk-04', input, output, tags, metadata }
 ├─ generation = 模型调用层（model、input、output）
 ├─ score      = { name: 'correct', value: 0|1, comment: 判定细节 }
 └─ dataset run item = 挂到 daymate-regression-set 的 run
```

### 5.2 dataset 双向同步（按 id 差集，不按数量）

```
云端有、本地无（如退役 mp-*）  → ⌫ 删
本地有、云端无（新加 case）    → ↑ 补传
已存在但 expected 变化         → 重新 upsert 覆盖
```

只比数量会假跳过（数量相同但内容不同 → 新 case 挂 run 时 404，实测踩过）。
SDK 的 `createDatasetItem` 失败只 log 不 reject → 必须读回校验。

### 5.3 Prompt Management（rubric 资产，judge 用）

- Langfuse 的 prompts 页面 = rubric 的"仓库"：**版本化 + label（production）+ UI 可编辑 + 按名拉取**
- 按功能命名：`judge:draft-tone`（草稿）、`judge:ntk-title`（必读标题）、
  `judge:brief-summary`（晨报摘要）……
- 初始版本由脚本 upsert（从仓库带默认文本建到 Langfuse），之后改版全走 UI
- **分工**：Langfuse 管 rubric 存放/版本，deepseek（评测脚本）才是执行打分的评委

---

## 6. 内容层（LLM judge）

> 设计已定，待实现。

- **judge 不是新 case 类型**，是 expected 里的可选质量维度（见 2.2 样例）
- 只 judge **用户直接看/直接用的生成字段**：草稿正文、必读标题、晨报摘要、
  记忆画像、简历/复盘/运势等；内部中间字段不评
- rubrics 分批建：首批 `judge:draft-tone` / `judge:ntk-title` / `judge:brief-summary`

执行流程：

```
评测脚本跑完结构判定后：
1. langfuse.getPrompt('judge:draft-tone', { label: 'production' })  ← 拿 rubric 模板
2. 渲染模板（注入 {{output}}）
3. deepseek 按 rubric 打分 → { score: 1-5, reason }
4. 分数写回 Langfuse（trace score / run item metadata）+ 进报告 judge 指标
```

---

## 7. 评测工作流与数据飞轮

### 7.1 评测工作流（怎么用）

```
① 开发新功能       → 建功能测试集（真实形态 case；EVAL_CASES 定向跑，开发期靶子）
② 合入回归集       → 并入 dataset.ts（新类别或类别内加 case），全量真模型 ≥85%
③ 发布前回归       → pnpm test（stub + 7 硬闸全绿） + 全量真模型 ≥85%，两道全过
④ 沉淀             → 线上暴露的分类错误 / 新邮件形态 → 随时补 case 进回归集
```

纪律：功能测试集"宽进严出"（开发期靶子）；回归集是"发布期闸"——回归 ❌
要么修生产代码、要么按 v2 流程改标准并三向同步；**不得**静默放宽硬闸。

### 7.2 数据飞轮（回归集的增值引擎）

```
真实使用/日志 ─► 抓 badcase ─► 分析根因 ─► 修复 ─► 回流入回归集 ─► 防回归
 (Langfuse 真实 trace)   (人工标注可疑)   (模型 vs 标准二分)   (定向验证闭环)   (全量确认 61/61)
```

| 环节 | 做法 | 状态 |
|---|---|---|
| 抓 badcase | 使用中发现的异常（必读混进垃圾 / 标题怪 / 草稿不对）+ Langfuse 真实 traces（半自动：脚本拉 trace 供人工标） | 🟡 半自动，需人工标注 |
| 分析根因 | 二分：模型问题 → 改生产 prompt；标准问题 → 改 expected + 三向同步 | ✅ 流程已成文 |
| 修复 | `EVAL_CASES=<id>` 定向闭环验证（stub 冒烟 → 真模型） | ✅ |
| 回流 | 脱敏后加进 dataset.ts 对应类别 → 全量跑确认不破坏既有 61/61 | ✅ |

前提：评测跑生产路径（同一 prompt / 同一 agent），线上暴露的毛病大多能在评测里
复现——这是飞轮转得动的基础。注意：回流 case 必须**脱敏**（真实邮件进 git 仓库 +
Langfuse 云端前去掉姓名/邮箱/公司/链接/金额）。

---

## 8. 当前状态与路线图

| 状态 | 项 |
|---|---|
| ✅ 已完成 | 65 条回归集（DATASET_VERSION 3：v2.x 修订 + v3 按功能分组）；7 硬闸；真模型本体评测 55.7%→**61/61**；EVAL_MIN_SCORE 门禁；Langfuse dataset 双向同步；ADR 0032 归档 |
| 🟡 待做 | **LLM judge 内容层**（design 已定：expected.judge + rubric 资产 + deepseek 打分）——首批 3 维度（草稿/必读标题/晨报摘要） |
| 🟡 待做 | **数据集真实化**（真实形态中文样本逐步替换/补充合成样板；注意脱敏） |
| ⏸ 可上可不上 | judge 目标线进硬闸（先看趋势） |

---

## 9. 相关文件索引

| 文件 | 角色 |
|---|---|
| `tests/evaluation/dataset.ts` | 回归集：65 条 case + expected（按功能分组，含未来 judge 维度） |
| `tests/evaluation/run-eval.ts` | 规则判定 + 指标 + 报告渲染 + 7 硬闸 |
| `tests/evaluation/eval.test.ts` | vitest 入口：断言 gates + 重写 baseline-report |
| `docs/evaluation/regression-set-spec.md` | 标准说明 + 评测工作流约定 |
| `docs/evaluation/baseline-report.md` | 回归报告（每次 pnpm test 重写） |
| `scripts/langfuse-eval-agent.mjs` | 真模型本体评测（全量/定向/dry/门禁 + Langfuse 同步 + judge 挂载点） |
| `scripts/langfuse-eval.mjs` | 早期替身路径（保留，不 gate） |
| `scripts/eval-agent-core.ts` | bundle 入口：env fake SecretStore/Settings + createEvalAgentRuntime |
| `docs/decisions/0032-评测体系-Langfuse考本体与门禁化.md` | 本体系决策 ADR |