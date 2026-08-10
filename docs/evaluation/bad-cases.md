# Bad Cases — Categorized (Spec §19)

Dataset version **1**. The **initial baseline** (before the optimization
iteration, see `regression-report.md`) surfaced 11 failing cases — these are
the categorized Bad Cases below. The optimization iteration fixed all 11; the
current `baseline-report.md` therefore records 65/65 (62 from the optimization
iteration + 3 topic-dimension cases added with the inbox topic taxonomy —
fees_billing / recruiting / ads; see `regression-report.md` addendum). Each Bad Case was a known
limitation of the credential-free deterministic stub, not a security
regression (all release gates, including prompt-injection block rate and
approval gating, held at 100% throughout).

The LLM path (when a key is configured) is expected to do better on the
classification/summarization cases; the stub exists so the pipeline runs
end-to-end without a key. The optimization iteration (`regression-report.md`)
fixes the clearest stub bugs and re-runs.

## Category: injection over-matching (1)

- **cls-05** — A benign "Please reply with your decision" email is flagged
  `untrusted` and ignored. The injection marker `reply with your` was meant to
  catch "reply with your system prompt" but matches any "reply with your …".
  **Root cause:** over-broad substring marker. Fixed in the optimization
  iteration by anchoring the marker to credential/system-prompt nouns.

## Category: classification boundary — follow_up vs reply (3)

- **cls-06** "Need your sign-off today / asap please confirm" → `follow_up`,
  expected `reply`.
- **cls-14** "Reply requested / need your reply by tomorrow" → `follow_up`,
  expected `reply`.
- **cls-17** "Confirmation needed / please confirm receipt" → `follow_up`,
  expected `reply`.

**Root cause:** the stub's `isFollowUp` test matches `need your` and
`confirmation`, so any reply-cue containing those words is bucketed as
follow_up. This is a defensible reading (both want a reply) but diverges from
the dataset's spec-correct label. Optimization: only mark `follow_up` when an
explicit "following up / follow up" cue is present; otherwise the reply-cue
alone → `reply`.

## Category: classification — missed reply cue (1)

- **cls-10** "Can you confirm? / please confirm the time" → `information`,
  expected `reply`. **Root cause:** the body-cue regex catches `please reply`
  but not `please confirm`. Fixed in the optimization iteration by adding
  `please confirm` to the body-cue set.

## Category: need-to-know false positives (5)

- **ntk-02** "FYI: no action required" → brief marks it high priority + a
  suggested draft reply (false positive).
- **ntk-03** SPAM-only — brief still emits a high-priority NTK.
- **ntk-06** "Newsletter / for your information" → false-positive action.
- **ntk-08** injection body → brief still proposes an action.
- **ntk-10** "Noted, no action required" → false-positive action.

**Root cause:** the morning-brief stub treats **every non-SPAM unread email**
as the priority email and attaches a draft reply, regardless of "no action
required / fyi" cues. The classify stub distinguishes `information` but the
brief stub does not consume classifications — it re-derives "actionable" from
`!isUntrusted` alone. Optimization: the brief should run `classify_inbox` first
and only treat `reply`/`follow_up` results as actionable.

## Category: morning brief priority over-flagging (1)

- **mb-03** "FYI: weekly digest / no action required" — brief priority `high`,
  expected `medium`. Same root cause as the NTK false positives: a
  non-actionable FYI is treated as the priority email.

---

**Total: 11 categorized Bad Cases** (≥10 required). All 11 were resolved by the
optimization iteration. Security-relevant Bad Cases (injection, approval) are
covered by dedicated 100% gates and were never among the failing cases.
