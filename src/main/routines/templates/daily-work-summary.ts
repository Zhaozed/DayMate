// Daily Work Summary Routine template (Spec §13.4). End-of-day recap built
// ONLY from data Daymate actually handled today: processed emails, created/
// completed tasks, meetings attended, waiting items, tomorrow's highlights.
// Must NOT infer productivity or slacking time (§13.4).
//
// Triggered on a weekday evening schedule. Reads today's emails, all tasks,
// and this week's events (the agent step filters to attended-today and
// tomorrow). The agent step produces the structured summary; we publish it as
// a Need to Know and notify the robot.

import type { RoutineTemplate } from './morning-brief'

export const dailyWorkSummaryTemplate: RoutineTemplate = {
  id: 'daily_work_summary',
  name: '每日工作总结',
  description: '日终回顾 Daymate 今日处理的工作',
  version: 1,
  enabled: true,
  trigger: {
    type: 'schedule',
    cron: '0 18 * * 1-5',
    timezone: 'Asia/Shanghai'
  },
  inputs: {
    emailSinceHours: 24
  },
  steps: [
    {
      id: 'emails',
      type: 'tool',
      tool: 'email.list',
      args: { unreadOnly: false, sinceHours: 24, limit: 50 },
      outputKey: 'emails',
      continueOnError: true
    },
    {
      id: 'tasks',
      type: 'tool',
      tool: 'task.list',
      args: {},
      outputKey: 'tasks',
      continueOnError: true
    },
    {
      id: 'events',
      type: 'tool',
      tool: 'calendar.list',
      args: { range: 'this_week' },
      outputKey: 'events',
      continueOnError: true
    },
    {
      id: 'summary',
      type: 'agent',
      action: 'generate_work_summary',
      inputs: {
        emails: '{{emails}}',
        tasks: '{{tasks}}',
        events: '{{events}}'
      },
      outputKey: 'summary'
    },
    {
      id: 'publish',
      type: 'need_to_know',
      fromKey: 'summary'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '{{summary.title}}'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
