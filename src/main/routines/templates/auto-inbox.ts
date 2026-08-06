// Auto Inbox Routine template (Spec §13.2). Credential-free / mock-backed for
// M2 — the unified normalized feed pulls from mock Gmail AND mock 163, so the
// classifier genuinely dedupes across two providers.
//
// Flow: list both inboxes → classify_inbox (deterministic stub, real LLM is
// M3) → create one Task per actionable email (idempotent by messageId) →
// publish a Need to Know summarizing the bucket counts → notify. Ignore /
// untrusted (SPAM / prompt-injection) items never produce a Task, draft, or
// send (Spec §17).

import type { RoutineTemplate } from './morning-brief'

export const autoInboxTemplate: RoutineTemplate = {
  id: 'auto_inbox',
  name: 'Auto Inbox',
  description: 'Classify incoming mail across accounts into reply / follow-up / info / ignore',
  version: 1,
  enabled: true,
  trigger: {
    type: 'email_poll',
    intervalMinutes: 30
  },
  inputs: {
    gmailAccountId: 'mock-gmail-001',
    mail163AccountId: 'mock-163-001'
  },
  steps: [
    {
      id: 'gmail_emails',
      type: 'tool',
      tool: 'email.list',
      args: { accountId: 'mock-gmail-001', unreadOnly: true, limit: 50 },
      outputKey: 'gmailEmails'
    },
    {
      id: 'mail163_emails',
      type: 'tool',
      tool: 'email.list',
      args: { accountId: 'mock-163-001', unreadOnly: true, limit: 50 },
      outputKey: 'mail163Emails'
    },
    {
      id: 'classify',
      type: 'agent',
      action: 'classify_inbox',
      inputs: { gmailEmails: '{{gmailEmails}}', mail163Emails: '{{mail163Emails}}' },
      outputKey: 'classified'
    },
    {
      id: 'create_tasks',
      type: 'tool',
      tool: 'inbox.create_tasks',
      args: { classifications: '{{classified.results}}' },
      outputKey: 'createdTasks'
    },
    {
      id: 'publish',
      type: 'need_to_know',
      title: 'Inbox classified',
      summary:
        'Reply: {{classified.counts.reply}}, follow-up: {{classified.counts.follow_up}}, info: {{classified.counts.information}}, ignored: {{classified.counts.ignore}}. {{createdTasks.count}} task(s) created.',
      reason: 'Auto Inbox triaged unread mail across Gmail and 163. Untrusted / SPAM items were ignored.',
      priority: 'medium'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: 'Inbox reviewed — {{createdTasks.count}} actionable item(s).'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
