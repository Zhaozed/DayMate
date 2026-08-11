// Job Recommendation Routine template (Milestone C — 每日岗位抓取 + 推荐评分).
// Searches BOSS by the user's structured `jobIntent` (read from settings via
// the `job_search.get_intent` R0 tool), scores the results against that intent
// with the `score_job_matches` agent step, publishes the scored brief to
// Need-to-Know, and notifies the robot.
//
// Default `enabled: false` — this routine requires the user to configure
// `jobIntent` first (keyword/cities/salary). The manual 抓取 button in the
// 投递 page works regardless of this routine's enabled state. §17: job field
// values are short structured strings framed as DATA in the user message,
// never in the host-set system prompt; `enforceTrust` strips any write/send
// toolName from suggestedActions (转投递 is a renderer-side local action).
//
// The daily 08:03 cron (avoiding the fleet-collision :00 mark) is a weekday+
// weekend morning nudge. When jobIntent is absent the search step degrades
// gracefully (continueOnError → empty results → an empty-match NTK); the
// routine is opt-in so this only happens if the user enables it without
// configuring intent.

import type { RoutineTemplate } from './morning-brief'

export const jobRecommendationTemplate: RoutineTemplate = {
  id: 'job_recommendation',
  name: '每日岗位推荐',
  description: '按求职意向抓取 BOSS 岗位并评分推荐',
  version: 1,
  enabled: false,
  trigger: {
    type: 'schedule',
    cron: '3 8 * * *',
    timezone: 'Asia/Shanghai'
  },
  inputs: {},
  steps: [
    {
      id: 'intent',
      type: 'tool',
      tool: 'job_search.get_intent',
      args: {},
      outputKey: 'intent',
      continueOnError: false
    },
    {
      id: 'search',
      type: 'tool',
      tool: 'boss.search',
      args: { keyword: '{{intent.keyword}}', city: '{{intent.cities[0]}}', limit: 30 },
      outputKey: 'jobs',
      continueOnError: true
    },
    {
      id: 'score',
      type: 'agent',
      action: 'score_job_matches',
      inputs: {
        intent: '{{intent}}',
        jobs: '{{jobs}}'
      },
      outputKey: 'jobMatch'
    },
    {
      id: 'publish',
      type: 'need_to_know',
      fromKey: 'jobMatch'
    },
    {
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot',
      message: '{{jobMatch.title}}'
    }
  ],
  approvalPolicy: 'writes_only',
  output: 'need_to_know'
}
