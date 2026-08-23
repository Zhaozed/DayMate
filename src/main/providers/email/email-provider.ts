// Email Provider abstraction (Spec §9).
//
// Business logic and Routines must not contain Gmail- or 163-specific branches.
// Both providers implement this interface; the Tool Registry and Routines only
// ever speak to it. Mock implementation in mock-email-provider.ts; real Gmail
// (M2) and 163 (M2) land later.

import type {
  IntegrationAccount,
  IntegrationStatus,
  NormalizedEmail,
  EmailQuery,
  EmailDraft,
  EmailDraftInput,
  EmailSendResult,
  SentMailQuery
} from '@shared/types'

export interface EmailProvider {
  readonly provider: 'gmail' | 'mail163'
  readonly accountId: string

  connect(): Promise<IntegrationAccount>
  disconnect(): Promise<void>
  getStatus(): Promise<IntegrationStatus>

  listMessages(query: EmailQuery): Promise<NormalizedEmail[]>
  getMessage(messageId: string): Promise<NormalizedEmail>
  searchMessages(query: string, limit?: number): Promise<NormalizedEmail[]>

  /**
   * The user's OWN sent mail — a tone corpus for draft-mirroring (Spec §13.5).
   * Sent mail is the user's voice, the opposite of §17-untrusted inbound mail;
   * it is only ever a tone reference, never an instruction source. Filtering by
   * `toAddress` lets the corpus mirror the voice used with a specific contact.
   */
  listSent(query: SentMailQuery): Promise<NormalizedEmail[]>

  /**
   * ADR 0027 — one-time cold-start backfill: return all mail newer than
   * `sinceDate` (newest-first), paging through full history as needed (Gmail
   * consumes `nextPageToken`; 163 pages its in-memory uid list). Optional:
   * providers that don't implement it fall back to `listMessages` with a wide
   * `sinceHours`. Capped by the provider for cost/rate-limit safety. Used only
   * by the container's cold-start orchestrator, never the incremental sync loop.
   */
  listBackfill?(sinceDate: Date, maxItems?: number): Promise<NormalizedEmail[]>

  /**
   * ADR 0029 — fetch ALL emails in a conversation, for the 必读 thread-Item
   * expand. Gmail uses threads.get (native threadId); 163 does a best-effort
   * IMAP header search on the synthesized thread key. Returns [] on any
   * failure (caller falls back to surfaced sourceRefs). R0 read-only.
   * Optional: providers without threading return [].
   */
  getThread?(threadId: string): Promise<NormalizedEmail[]>

  createDraft(input: EmailDraftInput): Promise<EmailDraft>
  sendDraft(draftId: string): Promise<EmailSendResult>
}
