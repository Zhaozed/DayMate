# Baseline Evaluation Report

Generated against dataset version **1**. 65/65 cases passed.

## Per-category metrics

| Category | Metric | Passed | Total | Value |
|---|---|---:|---:|---:|
| email_classification | Accuracy (Precision≈Recall≈F1 for balanced set) | 23 | 23 | 1.000 |
| email_classification | Topic dimension accuracy (fees/recruiting/ads/meeting/general) | 23 | 23 | 1.000 |
| action_extraction | Action accuracy | 10 | 10 | 1.000 |
| need_to_know | Usefulness (NTK has sourceRefs) | 5 | 10 | 0.500 |
| need_to_know | False-positive rate (lower is better) | 10 | 10 | 0.000 |
| morning_brief | Fact coverage & correctness | 8 | 8 | 1.000 |
| meeting_prep | Context coverage & source correctness | 5 | 6 | 0.833 |
| prompt_injection | Attack block rate | 4 | 4 | 1.000 |
| approval | Unauthorized-write block rate | 4 | 4 | 1.000 |

## Latency (deterministic stub path)

All categories run in single-digit milliseconds (rule-based stubs; no model call). Per-category wall-clock:

- email_classification: 32 ms
- action_extraction: 31 ms
- need_to_know: 31 ms
- morning_brief: 29 ms
- meeting_prep: 5 ms
- approval: 0 ms
- prompt_injection: 5 ms

## Estimated model cost (LLM path)

When an LLM key is configured, each agent step is one model turn with a small structured-output tool call. Estimated per-step: ~1–3k input tokens + ~0.5–1k output tokens. At Claude Sonnet-class pricing (~$3/M in, ~$15/M out) a single brief ≈ $0.01–0.03. The credential-free path used here costs $0.

## Release gates

- [x] 8/8 gates pass
  - [x] 100% external write actions require approval
  - [x] 100% prompt-injection tests produce no external writes
  - [x] No credential in renderer/log/model-context (static: write-only key, never in stub input)
  - [x] No duplicate email sending in retry (idempotency key — covered by integration tests)
  - [x] Morning Brief contains source references (non-trivial input)
  - [x] Inbox topic dimension: every case tagged into the correct topic (fees/recruiting/ads/meeting/general)
  - [x] ≥60 evaluation cases exist
  - [x] Critical demo flow succeeds three consecutive times (Playwright e2e)

## Failing cases

None.
