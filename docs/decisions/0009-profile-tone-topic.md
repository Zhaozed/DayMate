# 0009 — Personal profile, tone-mirrored drafts, topic inbox

Date: 2026-08-08
Status: accepted (post-MVP)
Supersedes: none
Related: 0003 (approval + immutability), 0004 (agent runtime + §17),
0006 (memory/prep/summary/builder/eval), 0007 (Gmail real), 0008 (163 real)

## Context

The user's three complaints, all in one pass:

1. Email drafts were a hardcoded canned string (`"收到——我会查看并尽快回复
   你。"`) — "实现了功能，但并不像我做的". Wanted a "town"-style passive
   personal profile (writing style, persona, task relationships) and drafts that
   mirror the user's own reply tone.
2. Inbox classification was four coarse action buckets
   (reply/follow_up/information/ignore) — ads, invoices, and recruiting offers
   collapsed together. Wanted topic-based grouping + a summary.
3. Tone source clarification: **both** a memory profile AND the user's real
   prior replies fetched live, in this same pass. Profile capture: agent
   proposes passively, user confirms (§16). Topic taxonomy chosen by the user:
   费用/账单/支付, 求职/招聘/HR, 广告/推广/营销, 会议/日程.

## Decision

### A. Sent mail is the user's own voice — the opposite of §17-untrusted

The prior-reply tone corpus rides in a **separate** agent input field
(`priorReplies`), never folded into `emails`/`gmailEmails`/`mail163Emails`. It
therefore never enters `collectEmails` or the `enforceTrust` untrusted-set. It is
framed by a NEW `frameSentReply` (distinct `<your_reply>` block, `capInput`-bound,
corpus cap ≤3), NOT `frameEmail` — `frameEmail` calls `isUntrusted`, which would
mis-flag a sent reply that quotes an injection email. Sent mail is the user's OWN
voice, unconditionally labeled "mirror this tone".

**Data-flow note:** feeding real sent mail to a third-party LLM (DeepSeek) is a
user-consented data flow separate from the §17 injection surface. The LLM-key
opt-in (§17.6/§17.8) covers it; the key is write-only from the renderer,
`safeStorage`-encrypted at rest, and never enters model context or the renderer.

### B. Memory proposals via a declarative tool step, NOT runtime injection

Agent outputs gain an optional `memoryProposals: { key: MemoryKey; value:
string }[]` field. Each routine template adds ONE `memory.save_proposals` tool
step (R0, `continueOnError: true`) after the agent step:
`args: { proposals: '{{brief.memoryProposals}}' }`. `resolveTemplate` already
resolves whole-array tokens for tool args (the `inbox.create_tasks` pattern).
The new tool loops `memoryService.save({ key, value, source: 'agent',
routineRunId })` per item — which already lands `confirmed:false` (§16) — with
try/catch per item so a rejected proposal (e.g. `validateMemoryContent` rejects
a full email body / a token / a forbidden inferred trait) becomes a logged
`tool_requested` Activity, never fails the run.

`createAgentRuntime` stays **pure** — no `MemoryService` injection, no signature
change. This was the riskiest design element of the proposal and the declarative
step removes it entirely. The engine unwraps `result.data` (engine.ts:486/598)
so `{{brief.memoryProposals}}` resolves to the raw array.

### C. Topic is a pre-computed output field

`resolveTemplate` cannot iterate/group, so the classify output carries
`topicCounts: Record<EmailTopic, number>` (mirroring `counts`). The auto_inbox
publish summary reads `{{classified.topicCounts.fees_billing}}` etc. `topic` is
orthogonal to the action bucket; `ads → classification:'ignore'` is a
cross-dimension rule enforced in the stub (and respected by `enforceTrust`,
which recomputes counts after the override). `EMAIL_TOPICS` =
`['fees_billing','recruiting','ads','meeting','general']`.

Stub topic regexes (Chinese + English, eval-safe):
- fees_billing: `账单|发票|invoice|receipt|费用|billing|扣款|续费`
- recruiting: `招聘|offer|面试|猎头|recruit`
- ads: `退订|unsubscribe|广告|promotion|优惠|活动` (→ also force ignore)
- meeting: `会议|日程|meeting|agenda|邀请`
- else general

Untrusted mail is forced to `topic:'general'` computed AFTER the untrusted
check (a spam "offer" would otherwise mis-tag as recruiting).

### D. Dedicated `generate_draft_reply` agent action

Overloading `generate_morning_brief` for drafts was awkward (empty
`suggestedActions` edge). A 6th action costs the same 6-file schema surface
already maintained for the other 4 — worth it, since draft-review is the one
place tone-mirroring is product-visible at approval time. New routine sequence
(draft-review.ts): `email.list` → `email.list_sent` (`toAddress:
'{{gmailEmails[0].from.address}}'`) → `memory.search` → `generate_draft_reply`
(inputs `email: '{{gmailEmails[0]}}'`, `priorReplies: '{{sentReplies}}'`,
`memory: '{{memory}}'`) → `memory.save_proposals` (`{{draftReply.memoryProposals}}`)
→ `approval` (`email.create_draft`, `body: '{{draftReply.body}}'`,
`to: '{{draftReply.to}}'`, `subject: '{{draftReply.subject}}'`) → `notify`.

The approval `contentHash` (tool-registry.ts) is computed over resolved args →
the LLM-generated body is captured immutably at approval-request time (§15
holds; the M4 `resolveStepArgs`-against-`stepOutputs` fix means the templated
approval args hash-match at resume).

### E. 163 Sent mailbox is locale-dependent

`mail163-provider.ts` hardcoded `'INBOX'` (RFC-3501 constant). Sent is NOT
universal. `findSentMailbox` reuses the `findSpecialMailbox('\\Drafts')` pattern
with `\\Sent`, plus a name-based fallback probing `['已发送','Sent','Sent
Items','发件箱']` via `mailboxExists` when special-use isn't advertised (163 is
historically unreliable about `\\Sent`). Gmail `in:sent` (+ `to:` when filtered)
is reliable. 163 is domestic → direct TCP, no proxy-aware fetch needed.

### F. Stub tone-mirroring (credential-free fallback)

`generateDraftReply` stub: refuses untrusted email (§17); when prior replies
exist, detects the greeting (regex on `Hi/Dear/Hey/你好/您好`), sign-off
(`Thanks/Best regards/Cheers/Regards/祝好/此致` to end-of-line), and formality
(`Dear/Best regards/您好/此致`) from `prior[0]`; composes `body =
[greeting?, ack, signOff?].join('\n\n')`; when prior replies lack a detected
greeting, falls back to `Hi <senderName>,`; proposes a `writing_style` memory
from the observed formality. Without prior replies, consults the memory profile
(`email_tone`/`writing_style`) for formality. This is NOT the canned string
whenever prior replies or a profile exist, so tone-mirroring is demonstrable
credential-free and the e2e can assert it structurally.

## Schema lockstep (6 touchpoints per change)

Adding `topic` to `EmailClassificationResult` and `memoryProposals` to outputs
each touched: Zod (`schemas.ts`), TypeBox mirror (`structured-output.ts
buildOutputSchemas`), TS interface (`agent-runtime.ts`), stub producer, system-
prompt task string (`prompt-injection.ts`), and (for the new action) a new branch
in `createAgentRuntime`'s real-path if/else. The `memory.save` tool's inline key
union (`tool-registry.ts`) is a hand-maintained duplicate of `MEMORY_KEYS` —
updated alongside `constants.ts`. Treated as a checklist, not a surprise.

## Localization notes

- Wire identifiers stay English: `topic` values, tool names (`email.list_sent`,
  `memory.save_proposals`), `MemoryKey` values. Only display labels translate.
- The §17 system prompt stays English (the proven injection surface); only a
  Chinese output-language directive is appended. `buildUserMessage` data
  payloads stay English (model-internal). `frameSentReply` `<your_reply>` label
  is English.
- Classify stub REGEX matchers stay English — they match the English eval
  dataset fixtures. Translating them would break the 65-case eval. The eval is
  structural (counts/refs/hasAction/topic), so localizing stub *display* strings
  is eval-safe.

## Verification

typecheck + lint + 182 tests (1 skipped) + build + 6 e2e tests (incl. the 3×
critical demo) all pass. New: a `generate_draft_reply` stub unit test
(tone-mirroring greeting/sign-off + §17 untrusted-refusal) and a tone-mirror
assertion in `approval-from-robot.spec.ts` (preview body contains the mirrored
greeting + sign-off, is not the canned string). Eval gained a topic-accuracy
gate (65/65) and 3 new Chinese topic cases (账单→fees_billing, 面试→recruiting,
限时优惠→ads/ignore).

## Deferred (out of this pass)

- `getThread` full-thread fetch (163 IMAP threading unreliable; `listSent`
  filtered by recipient is enough for tone).
- Topic taxonomy beyond the 4 chosen — extendable by adding an `EmailTopic`
  member + regex.
- Auto-proposing per-contact relationship memory (the `contact` key) — the
  proposal mechanism supports it; wiring per-contact extraction is a follow-up.
- Real Feishu Calendar activation (still pending admin approval, unrelated).
