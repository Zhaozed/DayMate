# Daymate 回归基线报告（Regression Baseline Report）

Generated against dataset version **3**. 56/56 regression cases passed.

## 按功能分组（回归集）

| 功能 | 状态 | 通过 | 总数 | 通过率 |
|---|---|---:|---:|---:|
| 1. 邮件分类（含注入防护） | ✅ | 30 | 30 | 1.000 |
| 2. 必读事项 (Need to Know) | ✅ | 12 | 12 | 1.000 |
| 3. 草稿生成 | ✅ | 10 | 10 | 1.000 |
| 4. 求职线索 | 🟡 待建 | 0 | 0 | 待建 |
| 5. 审批安全 | ✅ | 4 | 4 | 1.000 |

## Per-category metrics

| Category | Metric | Passed | Total | Value |
|---|---|---:|---:|---:|
| email_classification | Accuracy (Precision≈Recall≈F1 for balanced set) | 26 | 26 | 1.000 |
| email_classification | Topic dimension accuracy (fees/recruiting/ads/meeting/general) | 26 | 26 | 1.000 |
| action_extraction | Action accuracy | 10 | 10 | 1.000 |
| need_to_know | Usefulness (NTK has sourceRefs) | 6 | 12 | 0.500 |
| need_to_know | False-positive rate (lower is better) | 12 | 12 | 0.000 |
| prompt_injection | Attack block rate | 4 | 4 | 1.000 |
| approval | Unauthorized-write block rate | 4 | 4 | 1.000 |

## Latency (deterministic stub path)

All categories run in single-digit milliseconds (rule-based stubs; no model call). Per-category wall-clock:

- email_classification: 3 ms
- action_extraction: 2 ms
- need_to_know: 1 ms
- approval: 0 ms
- prompt_injection: 1 ms

## Estimated model cost (LLM path)

When an LLM key is configured, each agent step is one model turn with a small structured-output tool call. Estimated per-step: ~1–3k input tokens + ~0.5–1k output tokens. At Claude Sonnet-class pricing (~$3/M in, ~$15/M out) a single brief ≈ $0.01–0.03. The credential-free path used here costs $0.

## Release gates

- [x] 7/7 gates pass
  - [x] 100% external write actions require approval
  - [x] 100% prompt-injection tests produce no external writes
  - [x] No credential in renderer/log/model-context (static: write-only key, never in stub input)
  - [x] No duplicate email sending in retry (idempotency key — covered by integration tests)
  - [x] Need-to-know surfacing matches expected actionable or important criteria
  - [x] ≥50 regression cases exist
  - [x] Critical demo flow succeeds three consecutive times (Playwright e2e)

## Failing cases

None.
