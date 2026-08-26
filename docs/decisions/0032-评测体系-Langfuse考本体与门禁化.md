# 0032 — 评测体系：Langfuse 考 Agent 本体 + 标准 v2 + 真模型门禁

- **Date:** 2026-08-24
- **Status:** ✅ Accepted & implemented（评测体系闭环：61/61 + 门禁生效）
- **Touches:** `scripts/langfuse-eval-agent.mjs` · `scripts/langfuse-eval.mjs` ·
  `tests/evaluation/dataset.ts` · `tests/evaluation/run-eval.ts` ·
  `docs/evaluation/regression-set-spec.md` · `docs/evaluation/baseline-report.md` ·
  `src/main/agent/prompt-injection.ts`（生产 prompt 边界规则）·
  `src/main/agent/agent-runtime.ts`（stub 三向同步）

## Context

用户要拿 Langfuse 对 Daymate 做评测。早期版本用「手写 prompt 替身」跑（替身脚本
`langfuse-eval.mjs`），用户一针见血：**评测必须考真实 Agent**
（`createAgentRuntime` 生产路径），不是替身——替身改进的 prompt 跟线上 agent
没关系，测了也白测。由此立项「考本体」评测。

初跑结果打脸：64 个 case 只过 34（55.7%）。逐条归因后确认：**大部分 ❌ 不是模型
错，是标准过期**——expected 是「确定性 stub 行为的快照」，而生产 prompt 语义已
演进（ADR 0028/0029 的 unsolicited→ignore、ADR 0026 的 priority 无 surface 语义、
meeting_prep 退役），标准没跟上。标准对齐 + 生产 prompt 补规则后，最终 61/61。

## Key decisions

1. **评测 = 独立脚本 + 环境变量密钥**：不侵入应用，密钥只走 env
   （LANGFUSE_* / LLM provider key），永不进 chat / IPC / renderer。自用可接受
   云端数据。`EVAL_DRY`（stub 本体，无 key 无云端）、`EVAL_LIMIT`、
   `EVAL_CASES=id1,id2`（定向调试单个修复）、`EVAL_MIN_SCORE`（门禁，默认 85）。
2. **考本体 = 生产 `createAgentRuntime`**：`createEvalAgentRuntime` 用 env fake
   SecretStore/Settings 走生产 DI 路径（streamFn / model / getApiKey），stub 与
   真 LLM 同一入口；esbuild bundle 后 `packages:'external'`（pi-ai 由 Node 原生
   加载，avoid `Dynamic require of "process"`）。
3. **标准 = 产品意图，不是代码现状、也不是模型输出**。三向同步纪律：改 expected
   必须同步 stub（无 key 默认行为）与 run-eval 判定；模型行为不符 → 修生产
   prompt（线上受益），不迁就模型。落在 `regression-set-spec.md`。
4. **标准 v2（考本体后对齐）**：
   - meeting_prep 类别移除（能力退役，ADR 0022）；补 6 条边界用例维持 ≥60
   - unsolicited → ignore（digest / newsletter / 系统通知）；operation-triggered
     自动信（投递确认/收据/报名成功）必须 information（反向锚点）
   - morning_brief 的 priority 维度删除（生产恒 medium）
   - hasSourceRefs 放宽为**单向**（期待 true 必须带 refs；false 不再强制空——
     生产无重要事项也会给建议带 refs）
5. **标准 v2.2（门禁化）**：topic 维度从硬闸降为**趋势跟踪**（语义分组有灰度，
   cls-24 recruiting / cls-19 fees_billing 均曾模型判断更符合产品语义）；真模型
   本体评测新增 `EVAL_MIN_SCORE` 最低分门禁（全量跑 <85% → exit 1）。
6. **标准 v2.3（宁 information 勿 ignore）**：用户拍板——ignore=丢弃（会漏），
   information=保留不打扰（不 surface）；digest 周报判 information。重写生产
   prompt 规则 5 为产品总则；stub 删 digest→ignore 分支。
7. **P1 生产 prompt 边界规则**（prompt-injection.ts，线上同步受益）：meeting 仅
   新会议信号、untrusted→topic 恒 general、follow_up=追旧线程且也要动作、账单
   恒 information、宁 info 勿 ignore 总则、untrusted 不进 sourceRefs。
8. **Langfuse dataset 双向同步**：按 **id 差集**（不是数量）——云端有本地无的
   item 删除（mp 残留清掉），本地有云端无的补传；数量相同但内容不同时只比数量
   会假跳过（→ 挂 run item 404 Dataset item not found，实测踩过）。SDK
   `createDatasetItem` 失败只 log 不 reject → 必须读回校验。

## Verified

- 考本体真实 LLM 全量：**34/61（55.7%）→ 61/61**，全部门禁过
- `pnpm test`：65/65 + 7/7 release gates（安全/正确性不变量维持 0 容忍）
- `pnpm typecheck` / `pnpm lint`：0
- EVAL_DRY（stub 本体）：61/61 + approval 4/4，与 run-eval 判定一致
- 定向调试：`EVAL_CASES=cls-19,act-02` / `cls-03,cls-15` 修复验证闭环
- Langfuse 云端：dataset 65 items 与本地一致（双向同步），每次 run 自动挂 item

## Known limitations

- 当前评测是**结构层**校验（分类/topic/动作/refs 存在性，死逻辑）——内容质量
  （草稿语气、摘要精炼度、reason 合理性）未评，留给 next（LLM judge）。
- topic 维度只跟踪不 gate；爬升到某阈值前不拦发布（有意为之）。
- 生产 prompt 规则是软约束：模型大概率遵守、不保证每条 100%（61/61 为当前实测）。
- Langfuse 免费档 rate limit（~100 req/30s）：全量跑 ≈ 1-2 分钟，逐条 sleep 节流。

## Next milestone

- （A）LLM-judge 内容层：草稿语气 / 摘要质量，judge prompt 存 Langfuse Prompt
  Management，首批 2-3 条高价值用例
- （B）数据集真实化：真实收件箱场景补 case（中文账单 / 求职 / 系统邮件）
- （C）回产品主线：评测体系当护航工具，推进下一条产品功能