# 0008 — Real 163 Mail: IMAP read + SMTP send, 授权码 auth

## Context

Post-MVP real-provider activation (order: LLM ✅ → Gmail ✅ → **163** → Feishu
→ real Routine e2e). 163 Mail was M2 skeleton-only (`mock-mail163-provider.ts`).
Spec §9 mandates IMAP/SMTP for 163. This turns it on with user-supplied
credentials through the existing approval + injection guards (§15/§17).

## Decisions

1. **IMAP/SMTP, not a vendor SDK.** 163 is a domestic CN mailbox; its standard
   access is IMAP (imap.163.com:993 SSL) for read + APPEND-draft, and SMTP
   (smtp.163.com:465 SSL) for send. We use `imapflow` (IMAP), `mailparser`
   (MIME), and `nodemailer` (SMTP) — all pure-JS, no native build. 163 does
   NOT expose a REST/Gmail-style API, so unlike Gmail there's no hand-rolled
   REST here.

2. **授权码 (authorization code) auth, via SecretStore.** 163 requires a
   separate 授权码 (NOT the login password) for IMAP/SMTP. The email address +
   授权码 are stored as one JSON blob under `mail163-client` in the
   `SecretStore` (safeStorage/Keychain), exactly like the Gmail client. The
   renderer only ever sees opaque `Mail163Status` + the connected address —
   never the 授权码. `setMail163Client` is write-only.

3. **No proxy-aware fetch needed (unlike Gmail).** 163 is domestic; IMAP/SMTP
   are direct TCP (Node `net`/`tls`), reachable without a system proxy. So the
   provider takes no injectable `fetch` — contrast Gmail (ADR 0007), where
   Node's undici `fetch` ignored the proxy and we had to inject Electron
   `net.fetch`. Feishu (HTTPS to open.feishu.cn) is also domestic and likely
   needs no proxy; we'll confirm when it goes real.

4. **Mutable `emailProviders` swap, extended.** `refreshEmailProviders()`
   now reconciles BOTH real providers: Gmail stays at index 0 when connected
   (so account-agnostic `email.list` picks it); 163 is inserted after a
   connected Gmail (or at 0 if Gmail is absent) when connected, and removed on
   disconnect. The array is the same reference the engine reads each
   `buildContext`, so swaps are visible without re-wiring. Called from each
   connect/disconnect handler + once at boot.

5. **Drafts via IMAP APPEND to the `\\Drafts` special-use mailbox** (found by
   `list()` special-use flag, NOT a hardcoded localized folder name — 163's
   Drafts folder is locale-dependent). `sendDraft` SMTP-sends the EXACT
   RFC822 built at create time (`raw:` to nodemailer) so content cannot change
   between approval preview and execution (§15 immutability). Drafts are held
   in-memory (draftId → RFC822) between create and send, mirroring Gmail.

6. **Shared MIME module (`mail-mime.ts`).** `buildRfc822Raw` (raw RFC822, UTF-8,
   RFC 2047 subjects, CRLF) + `normalizeRfc822ViaParser` (mailparser
   `simpleParser` → small structural subset). mailparser prefers text/plain
   over text/html and never executes HTML (§17.12/§17.13). Kept loose-typed
   (`unknown` flattening of mailparser's `AddressObject | AddressObject[]`)
   so the no-credential path never loads mailparser.

7. **`sinceHours` is hour-precise.** IMAP `since` is date-only (midnight), so
   we search by date then filter by hour client-side; the `hours` const is
   captured outside the closure so the narrowing holds (TS18048 otherwise).

## Verification

- typecheck · lint · 166 tests · build all green.
- 11 new no-network 163 tests: RFC822 building (Cc, RFC 2047 CJK, In-Reply-To,
  omitted Cc), mailparser normalization (synthesized inbound, multipart
  text/plain-preferred-over-HTML, no `<script>` execution), SecretStore
  persistence + round-trip across instances, connect-throws-when-unconfigured,
  malformed-client rejection.
- Fixed two pre-existing **time-of-day-flaky** `daily-work-summary` tests
  (unrelated to 163 but blocking the suite): the stub counted "attended" as
  events with `end <= Date.now()`, and the test seeded a meeting ending
  "today 10:30" — run before 10:30 it flaked to 0; on Saturdays `this_week`
  (Sun→Sat) excluded tomorrow's (Sunday's) meeting. Fixed by seeding the
  attended meeting at `now − 2h` (always ended) and making the test
  `RelativeCalendar.listEvents` return all events (its job is summary logic,
  not range filtering — range filtering is unit-tested in tool-registry).
- Real end-to-end (user-supplied credentials): Connect validated a real IMAP
  login; `Test` read one real message — sample message id `1677387214` (a real
  IMAP UID, not a `mock-163-001` fixture), proving login + fetch + MIME
  extraction over the live mailbox.

## Deferred

- Real draft-write via IMAP APPEND + real SMTP send — implemented and
  approval-gated (R3), not exercised in the self-test. The read path proves
  IMAP login/fetch/parse; the write path shares the same credential + transport
  plumbing. Activate on demand (e.g. a 163 Draft Review run with 163 as
  emailProviders[0]).
- `auto_inbox` still hardcodes `mock-gmail-001` / `mock-163-001` accountIds —
  will be made account-agnostic (new `email.list_all` tool merging all
  connected providers) in the real-Routine-e2e step.
- Code signing / notarization — needs a paid Apple Developer ID.
