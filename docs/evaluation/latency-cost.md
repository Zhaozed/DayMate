# Latency & Estimated Model Cost (Spec §19)

## Latency — credential-free deterministic stub path

The default (no LLM key) path runs rule-based stubs. Per-category wall-clock
(recorded in `baseline-report.md`):

| Category | Latency |
|---|---|
| email_classification | single-digit ms |
| action_extraction | single-digit ms |
| need_to_know | single-digit ms |
| morning_brief | single-digit ms |
| meeting_prep | single-digit ms |
| approval | 0 ms (gated by integration tests) |
| prompt_injection | single-digit ms |

The full 65-case suite completes in well under 100 ms. There is no model call,
no network, no I/O — the stubs are pure functions over in-memory fixtures.

## Estimated model cost — LLM path (when a key is configured)

When an LLM key is supplied, each agent step becomes one model turn that ends
by calling a structured-output tool (`submit_brief` / `submit_classifications`
/ `submit_meeting_prep` / `submit_work_summary`). Per step:

- **Input tokens:** ~1–3k (system prompt + framed emails / calendar / tasks).
- **Output tokens:** ~0.5–1k (the structured tool call + reasoning).
- **Per-step cost at Claude Sonnet-class pricing** (~$3 / M input, ~$15 / M
  output): roughly **$0.01–$0.03** per agent step.

A Morning Brief run = 1 agent step + deterministic tool steps ⇒ ≈ $0.01–0.03.
Auto Inbox = 1 agent step per batch. Meeting Prep = 1 agent step. The
credential-free path used by the evaluation suite and the default install
costs **$0** (no model call).

## Notes

- The LLM key is write-only from the renderer, `safeStorage`-encrypted at rest,
  and never interpolated into any prompt (Spec §17.6/§17.8). No credential
  appears in the model context, logs, or renderer — verified by the
  `secret-store` unit tests and the §17 prompt-injection suite.
- Latency on the LLM path is dominated by the model round-trip (hundreds of ms
  to seconds depending on provider); the stub path is the deterministic
  baseline for CI and the credential-free default.
