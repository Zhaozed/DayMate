// Draft Review Routine template (Spec §18 + §13.5 tone-mirroring). Lists the
// first unread email, fetches the user's OWN prior replies to that sender as a
// tone corpus, runs the `generate_draft_reply` agent step to produce a
// tone-mirrored draft body, then pauses on an explicit `approval` step wrapping
// `email.create_draft` (R3 → preview + approval → run pauses). The approval
// `contentHash` is computed over the resolved args, so the LLM-generated body is
// captured immutably at approval-request time (Spec §15).
//
// Flow: email.list → email.list_sent → memory.search → generate_draft_reply →
// memory.save_proposals → approval(email.create_draft) → notify. The draft body
// comes from `{{draftReply.body}}` — the agent's tone-mirrored output — NOT a
// hardcoded string. Args are field-templated against `{{gmailEmails[0].…}}`
// (resolveTemplate supports `[N]` index access + whole-object tokens).

import type { RoutineTemplate } from './morning-brief'

export const draftReviewTemplate: RoutineTemplate = {
  id: 'draft_review',
  name: '草稿审阅',
  description: '为最近一封未读邮件生成语气匹配的回复草稿并暂停等待审批',
  version: 1,
  enabled: true,
  trigger: { type: 'manual' },
  inputs: {},
  steps: [
    {
      id: 'gmail_emails',
      type: 'tool',
      tool: 'email.list',
      // No accountId: `email.list` picks the first connected provider — the
      // real Gmail once connected, mock Gmail in the credential-free default.
      args: { unreadOnly: true, limit: 10 },
      outputKey: 'gmailEmails',
      continueOnError: true
    },
    {
      // The user's OWN sent mail — the prior-reply tone corpus (Spec §13.5).
      // Filtered to the recipient of the email being answered, so the corpus
      // mirrors the voice the user uses with THAT contact.
      id: 'sent_replies',
      type: 'tool',
      tool: 'email.list_sent',
      args: { toAddress: '{{gmailEmails[0].from.address}}', limit: 5 },
      outputKey: 'sentReplies',
      continueOnError: true
    },
    {
      id: 'memory',
      type: 'tool',
      tool: 'memory.search',
      args: { query: '' },
      outputKey: 'memory',
      continueOnError: true
    },
    {
      id: 'draft_reply',
      type: 'agent',
      action: 'generate_draft_reply',
      inputs: {
        email: '{{gmailEmails[0]}}',
        priorReplies: '{{sentReplies}}',
        memory: '{{memory}}'
      },
      outputKey: 'draftReply'
    },
    {
      id: 'save_memory',
      type: 'tool',
      tool: 'memory.save_proposals',
      args: { proposals: '{{draftReply.memoryProposals}}' },
      continueOnError: true
    },
    {
      // Explicit approval step wrapping an R3 tool. First pass (no approval
      // context) → registry returns needs_approval → run pauses. On resume the
      // gate passes and the draft is created (Spec §15). The body is the
      // tone-mirrored `{{draftReply.body}}`, captured immutably in contentHash.
      id: 'draft_approval',
      type: 'approval',
      toolName: 'email.create_draft',
      title: '草拟回复给 {{gmailEmails[0].from.name}}',
      args: {
        accountId: '{{gmailEmails[0].accountId}}',
        threadId: '{{gmailEmails[0].threadId}}',
        to: '{{draftReply.to}}',
        subject: '{{draftReply.subject}}',
        body: '{{draftReply.body}}'
      }
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '草稿待审阅'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'notification'
}
