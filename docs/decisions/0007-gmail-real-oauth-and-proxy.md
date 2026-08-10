# 0007 — Real Gmail: OAuth loopback, proxy-aware fetch, preset re-sync

## Context

M2 left Gmail as a skeleton. The post-MVP "real provider activation" pass
turns it on with user-supplied credentials (Spec §9). Gmail is the first real
external provider: real OAuth, real read (messages.list/get), real write
(drafts.create/send), all through the existing approval gate (§15) and
prompt-injection guards (§17).

## Decisions

1. **No `googleapis` dependency.** The REST surface we need is tiny (auth token
   exchange/refresh, messages.list/get, drafts.create/send, profile). Hand-
   rolling `fetch` over those endpoints keeps token handling inside the
   `SecretStore` architecture (no large native/ESM dep, no extra credential
   plumbing) and keeps the §17.12/§17.13 MIME extraction under our control.

2. **OAuth 2.0 desktop/installed-app flow on a loopback callback (Spec §9).**
   `startCallbackServer` listens on `127.0.0.1` port 0 (OS-assigned). Google's
   Desktop app type accepts any localhost port (RFC 8252), so no fixed port
   registration. A 16-byte random `state` mitigates CSRF; the caller
   (`connect`) checks the returned state against its own. `prompt: consent`
   forces a refresh token every time. The server is `await`ed to `listening`
   before reading `.address()` (it's async), and auto-closes via
   `promise.then(close, close)` — NOT `promise.finally(close)`, because
   `finally` propagates the rejection to the chained promise and would surface
   as an unhandled rejection (the rejection path is tested).

3. **Proxy-aware fetch via dependency injection (the critical fix).** Node's
   global `fetch` (undici) does NOT read the system proxy / VPN. On a network
   where Google endpoints are only reachable through a proxy, `exchangeCode`
   timed out (`ConnectTimeoutError`) even though the user's browser completed
   the OAuth consent. Fix: the Gmail provider + OAuth module take an injectable
   `fetch` (`GmailFetch` type). In production `container.ts` passes Electron's
   `net.fetch` (Chromium network stack → respects system proxy). In tests the
   default Node global `fetch` is used (loopback only, no proxy needed). The
   `GmailFetch` type is `string`-input-only (narrower than `typeof fetch`) so
   both the global `fetch` (`string | URL | Request`) and Electron's
   `net.fetch` (`string | Request`) satisfy it; defined via `Parameters`/
   `ReturnType` type queries to avoid referencing bare `RequestInit`/`Response`
   globals (eslint `no-undef` can't resolve them from `@types/node`).

4. **Mutable `emailProviders` swap.** `container` keeps the `emailProviders`
   array as one mutable reference the engine reads each `buildContext`.
   `refreshEmailProviders()` moves the real `GmailProvider` to index 0 when
   `getStatus() === 'connected'`, removes it when disconnected (mocks take over
   again). Called from the Gmail connect/disconnect handlers AND once at boot
   (fire-and-forget) so a restart with stored tokens reconnects automatically.

5. **`seedPresets` re-syncs (not insert-only).** Originally `if (existing)
   continue` — presets seeded once and never updated. A template fix (dropping
   the hardcoded `accountId: 'mock-gmail-001'` from Draft Review's `email.list`
   step) never reached the DB row, so the routine kept hitting the mock
   provider even after real Gmail was connected. Fix: on each boot, re-sync the
   canonical preset definition (steps, inputs, name, description, version,
   approvalPolicy, output) into existing rows, preserving only the user-mutable
   config (`enabled`, `trigger`) and `createdAt`. Presets are not user-editable
   in the builder (§14), so overwriting their step graph is safe; the double-
   seed integration tests still pass because `enabled`/`trigger` are preserved.

6. **Draft Review now account-agnostic.** The `email.list` step passes no
   `accountId` → `emailProviderFor` picks `emailProviders[0]` (real Gmail when
   connected, mock in the credential-free default). The `email.create_draft`
   approval step resolves `{{gmailEmails[0].accountId}}` from the list output,
   so the draft goes to whichever provider actually supplied the email.

## Verification

- typecheck · lint · 152 tests · build all green.
- 25 new no-network Gmail tests (base64url decode, HTML strip, address parse,
  message normalization, RFC822/RFC2047 draft construction, SecretStore
  persistence, OAuth loopback callback parsing incl. error/timeout/CSRF-state).
- Real end-to-end (user-supplied credentials): OAuth browser consent →
  `exchangeCode` via `net.fetch` (proxy) → tokens in Keychain; `Test` reads one
  real message; Draft Review run → real `email.list` → R3 approval pause →
  approve → real `drafts.create` → draft appears in Gmail Drafts. Debug
  instrumentation confirmed `emailProviderFor(no acct) → gmail-real` and
  `emailProviderFor(gmail-real) → gmail-real` on the live run (logs removed
  after).

## Deferred

- Real `sendDraft` (actually sending an email) — not exercised in the self-test
  (a draft is a safe write; sending is more intrusive and isn't needed to prove
  the path). The implementation exists and is approval-gated.
- Code signing / notarization — needs a paid Apple Developer ID.
- Universal (arm64+x64) packaging.
