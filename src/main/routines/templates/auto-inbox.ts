// Auto Inbox Routine template (Spec §13.2). Account-agnostic: a single
// `email.list_all` step pulls a unified normalized feed from EVERY connected
// email account (mock Gmail + mock 163 credential-free, real Gmail + real 163
// once configured) and dedupes by messageId, so the classifier genuinely
// triages across providers with no per-account branches (Spec §9).
//
// Flow: list all inboxes → classify_inbox (deterministic stub, real LLM is
// M3) → create one Task per actionable email (idempotent by messageId) →
// publish a Need to Know summarizing the bucket counts → notify. Ignore /
// untrusted (SPAM / prompt-injection) items never produce a Task, draft, or
// send (Spec §17).

import type { RoutineTemplate } from './morning-brief'

export const autoInboxTemplate: RoutineTemplate = {
  id: 'auto_inbox',
  name: '自动收件箱',
  description: '分类各账户收件箱为 回复 / 跟进 / 参考 / 忽略',
  version: 1,
  enabled: true,
  trigger: {
    type: 'email_poll',
    intervalMinutes: 30
  },
  inputs: {},
  steps: [
    {
      // One unified feed across all connected providers. Per-provider outages
      // are logged as `provider_unavailable` INSIDE the tool and skipped, so
      // the run continues with the surviving accounts' mail (Spec M3
      // partial-failure). `continueOnError` is kept as a backstop in case the
      // tool itself throws (e.g. no provider connected).
      id: 'emails',
      type: 'tool',
      tool: 'email.list_all',
      args: { unreadOnly: true, limit: 50 },
      outputKey: 'emails',
      continueOnError: true
    },
    {
      id: 'memory',
      type: 'tool',
      tool: 'memory.search',
      args: { query: '' },
      outputKey: 'memory'
    },
    {
      id: 'classify',
      type: 'agent',
      action: 'classify_inbox',
      inputs: {
        emails: '{{emails}}',
        memory: '{{memory}}'
      },
      outputKey: 'classified'
    },
    {
      id: 'save_memory',
      type: 'tool',
      tool: 'memory.save_proposals',
      args: { proposals: '{{classified.memoryProposals}}' },
      continueOnError: true
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
      title: '收件箱已分类',
      summary:
        '费用/账单：{{classified.topicCounts.fees_billing}}，求职：{{classified.topicCounts.recruiting}}，会议：{{classified.topicCounts.meeting}}，广告：{{classified.topicCounts.ads}}（已忽略），其他：{{classified.topicCounts.general}}。待回复：{{classified.counts.reply}}，跟进：{{classified.counts.follow_up}}，参考：{{classified.counts.information}}。已创建 {{createdTasks.count}} 个任务。',
      reason: '自动收件箱已对所有账户的未读邮件进行分类。不可信 / 垃圾邮件已被忽略。',
      priority: 'medium'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '收件箱已审阅 —— {{createdTasks.count}} 个待办事项。'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
