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
  EmailSendResult
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

  createDraft(input: EmailDraftInput): Promise<EmailDraft>
  sendDraft(draftId: string): Promise<EmailSendResult>
}
