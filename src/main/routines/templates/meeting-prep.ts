// Meeting Prep Routine template (Spec §13.3). Triggered `minutesBefore` an
// upcoming calendar event by the scheduler's `calendar_before` poller, which
// passes the target `targetEventId` into the run inputs. The routine reads the
// event, related email threads, open tasks and confirmed memory; the agent
// step produces the objective / context / questions / open actions; we publish
// a Need to Know and notify the robot.
//
// Determinism: the scheduler — not the agent — picks WHICH event to prep (the
// one whose start is within the minutesBefore window). The agent step only
// reasons about the event it is handed, so the stub is fully deterministic for
// tests (Spec §13.3, §17).

import type { RoutineTemplate } from './morning-brief'

export const meetingPrepTemplate: RoutineTemplate = {
  id: 'meeting_prep',
  name: '会议准备',
  description: '为即将到来的会议准备背景与待确认问题',
  version: 1,
  enabled: true,
  trigger: { type: 'calendar_before', minutesBefore: 15 },
  inputs: {
    // Filled by the scheduler: { targetEventId }.
    emailSinceHours: 72,
    memoryQuery: 'meeting'
  },
  steps: [
    {
      id: 'event',
      type: 'tool',
      tool: 'calendar.get',
      args: { eventId: '{{targetEventId}}' },
      outputKey: 'event',
      continueOnError: true
    },
    {
      id: 'emails',
      type: 'tool',
      tool: 'email.list',
      args: { unreadOnly: false, sinceHours: 72, limit: 30 },
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
      id: 'memory',
      type: 'tool',
      tool: 'memory.search',
      args: { query: 'meeting' },
      outputKey: 'memory',
      continueOnError: true
    },
    {
      id: 'prep',
      type: 'agent',
      action: 'generate_meeting_prep',
      inputs: {
        event: '{{event}}',
        emails: '{{emails}}',
        tasks: '{{tasks}}',
        memory: '{{memory}}'
      },
      outputKey: 'prep'
    },
    {
      id: 'save_memory',
      type: 'tool',
      tool: 'memory.save_proposals',
      args: { proposals: '{{prep.memoryProposals}}' },
      continueOnError: true
    },
    {
      id: 'publish',
      type: 'need_to_know',
      fromKey: 'prep'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '{{prep.title}}'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
