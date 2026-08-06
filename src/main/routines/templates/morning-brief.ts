// Morning Brief Routine template (Spec §13.1). Mock-backed for M1.
//
// Reads unread mail (last 24h), today's calendar, and open Tasks; the agent
// step produces a structured brief; we publish it as a Need to Know and notify
// the robot. The brief also suggests a Task, which we create. Approval policy
// is writes_only — but no R2/R3 tools run here, so nothing pauses for M1.

import type { z } from 'zod'
import type { routineTemplateSchema } from '@shared/schemas'

export type RoutineTemplate = z.infer<typeof routineTemplateSchema>

export const morningBriefTemplate: RoutineTemplate = {
  id: 'morning_brief',
  name: 'Morning Brief',
  description: 'Summarize today’s important work',
  version: 1,
  enabled: true,
  trigger: {
    type: 'schedule',
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai'
  },
  inputs: {
    emailRangeHours: 24,
    calendarRange: 'today',
    includeOpenTasks: true
  },
  steps: [
    {
      id: 'emails',
      type: 'tool',
      tool: 'email.list',
      args: { unreadOnly: true, sinceHours: 24, limit: 20 },
      outputKey: 'emails'
    },
    {
      id: 'events',
      type: 'tool',
      tool: 'calendar.list',
      args: { range: 'today' },
      outputKey: 'events'
    },
    {
      id: 'tasks',
      type: 'tool',
      tool: 'task.list',
      args: {},
      outputKey: 'tasks'
    },
    {
      id: 'brief',
      type: 'agent',
      action: 'generate_morning_brief',
      inputs: { emails: '{{emails}}', events: '{{events}}', tasks: '{{tasks}}' },
      outputKey: 'brief'
    },
    {
      id: 'create_task',
      type: 'create_task',
      title: '{{brief.taskToCreate.title}}',
      sourceId: '{{brief.taskToCreate.sourceId}}',
      priority: 'high'
    },
    {
      id: 'publish',
      type: 'need_to_know',
      fromKey: 'brief'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '{{brief.title}}'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
