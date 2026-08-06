# ADR 0003 — Milestone 2: approval immutability, multi-provider, Auto Inbox

Date: 2026-08-06
Status: Accepted
Milestone: 2

## Context

M2 ships the credential-free core of email integration: the Approval Service,
Auto Inbox classification, a unified normalized feed across two providers, and
draft review + approved send + duplicate-send protection — all mock-backed,
fully tested (spec rules 6 & 7). Real Gmail/163 stay as skeletons.

## Decision 1 — Content immutability via canonical-JSON SHA-256 (Spec §15)

**Problem:** "No action may change between approval preview and execution."
Without a hash, a draft's recipients/body could be swapped after the user
approved the preview but before send — the approval would cover different
content than what the user saw.

**Decision:** `src/main/util/hash.ts` defines `canonicalJson` (object keys
sorted at every depth, no whitespace) and `contentHashOf(args)` = SHA-256 of
that. `ApprovalRequest.contentHash` captures the hash of the action's resolved
args at preview time. On `engine.resume`, the engine re-resolves the current
step's args and asks `ApprovalService.verifyContent`; any mismatch fails the
run ("content changed since approval") and the action never executes. Canonical
JSON makes the hash order-independent so semantically-equal args always match.

The `content_hash` column is added to `approval_requests` via CREATE for fresh
DBs and a guarded `ALTER … ADD COLUMN` (swallows "duplicate column") for the
existing dev DB — idempotent on every launch.

## Decision 2 — Engine creates the ApprovalRequest, not the registry

The Tool Registry gates R2/R3 tools by returning `{status:'needs_approval'}`
without executing. The **engine** turns that into a persisted ApprovalRequest
(`pauseForApproval`), hashing the *resolved step args* (not the registry's
parsed output) so the hash is stable across pause/resume regardless of Zod's
key-stripping. On resume, the same resolved args are re-derived and verified.
This keeps the registry a pure gate and the engine the single owner of the
approval lifecycle (create → approve/reject → execute → markExecuted /
cancelPausedRun).

## Decision 3 — Multi-provider email registry (Spec §9)

`ToolContext.emailProvider` (single) → `emailProviders: EmailProvider[]`.
Email tools take an `accountId` and resolve via `emailProviderFor`; this is the
unified normalized feed across mock Gmail + mock 163, with no Gmail/163 branches
in business logic. `email.send_draft` now also takes `accountId` (drafts live
on a specific provider). Calendar stays single-provider (one Feishu) for now.

## Decision 4 — Deterministic Auto Inbox classifier (real LLM is M3)

`classify_inbox` is a deterministic stub in `agent-runtime`: dedupes by
`(provider, accountId, messageId)`, buckets into reply/follow_up/information/
ignore, and **always** marks SPAM-labeled / injection-marker mail as
`untrusted: true` + `ignore` — it never produces a task, draft, or send (Spec
§17). A new `inbox.create_tasks` R1 tool turns actionable classifications into
Tasks (idempotent by `sourceId = "provider:messageId"`). The contract is stable
so M3 swaps the stub for the real `pi-agent-core` + `pi-ai` classifier without
engine changes.

## Decision 5 — Duplicate-send protection at two layers (Spec §19)

- **Run level:** a manual/approval run re-invoked with the same `idempotencyKey`
  returns the existing run and executes nothing new (approval-flow test:
  "duplicate send run is a no-op").
- **Approval level:** an approval executes exactly once — `markExecuted` flips
  it from `approved` to `executed`, and reject → `cancelPausedRun` (the action
  never runs). The approval-flow tests assert: no send before approval; reject
  sends nothing; content tamper is refused; duplicate run is a no-op.

## Deferred (out of this pass)

- Real Gmail OAuth (loopback callback) and real 163 IMAP/SMTP — skeletons only;
  activate when the user supplies credentials (separate pass). Tokens/auth codes
  never hardcoded or exposed through IPC (Spec rules 4/6/7).
- Feishu create/update (P1), real LLM classification (M3).
