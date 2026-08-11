// Interview Prep Routine template (Milestone A §F). Triggered by the
// scheduler's `application_status` poller when an application reaches
// `interview` status and has no prep material yet. The scheduler passes the
// target `targetApplicationId` into the run inputs. The routine looks up the
// application, searches the 面经库 for prior notes at that company, fetches the
// latest AI resume, generates a 面试逐字稿 (interview transcript: self-intro,
// STAR projects, common Q&A, reverse questions), saves it as a prep material
// version, and notifies the robot.
//
// Determinism: the scheduler — not the agent — picks WHICH application (the one
// whose status is `interview` and has no prep). The agent step only reasons
// about the app/JD/resume/notes it is handed, so the stub is fully
// deterministic for tests (§13.3, §17). JD is untrusted external text — framed
// via `frameJd` in a user message, never the host-set system prompt; the
// transcript HTML is rendered in a `sandbox=""` iframe so even an injected
// `<script>` is neutralized.

import type { RoutineTemplate } from './morning-brief'

export const interviewPrepTemplate: RoutineTemplate = {
  id: 'interview_prep',
  name: '面试准备',
  description: '为进入面试的投递生成面试逐字稿与准备材料',
  version: 1,
  enabled: true,
  trigger: { type: 'application_status', targetStatus: 'interview' },
  inputs: {
    // Filled by the scheduler: { targetApplicationId }.
  },
  steps: [
    {
      id: 'app',
      type: 'tool',
      tool: 'application.search',
      args: { id: '{{targetApplicationId}}' },
      outputKey: 'app',
      continueOnError: false
    },
    {
      id: 'notes',
      type: 'tool',
      tool: 'interview_notes.search',
      args: { query: '{{app[0].application.company}}' },
      outputKey: 'notes',
      continueOnError: true
    },
    {
      id: 'resume',
      type: 'tool',
      tool: 'application.get_latest_resume',
      args: { applicationId: '{{targetApplicationId}}' },
      outputKey: 'resume',
      continueOnError: true
    },
    {
      id: 'transcript',
      type: 'agent',
      action: 'generate_interview_transcript',
      inputs: {
        company: '{{app[0].application.company}}',
        position: '{{app[0].application.position}}',
        jdText: '{{app[0].application.jdText}}',
        resume: '{{resume.html}}',
        notes: '{{notes}}'
      },
      outputKey: 'transcript'
    },
    {
      id: 'save_prep',
      type: 'tool',
      tool: 'application.save_prep_material',
      args: { applicationId: '{{targetApplicationId}}', html: '{{transcript.html}}' },
      outputKey: 'prep'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '已为 {{app[0].application.company}} 生成面试准备材料'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'notification'
}
