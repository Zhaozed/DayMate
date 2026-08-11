// Chinese (zh-CN) display labels for the backend-produced enum values.
//
// The enum VALUES themselves are wire identifiers (produced by the main
// process, stored in SQLite, sent over IPC) — they stay English so the IPC
// contract, DB schema and tests are unchanged. This module only maps each
// value to the Chinese string shown in the UI, so a single change updates
// every badge that surfaces that value.
//
// Backend value → Chinese label. Unknown values fall back to the raw value
// (so a new enum member never blanks the UI).

import type {
  TaskStatus,
  TaskPriority,
  ApprovalStatus,
  RoutineRunStatus,
  IntegrationStatus,
  ApplicationSource,
  ApplicationEventType,
  ApplicationPriority,
  InterviewNoteTag,
  SmartFunnelGroup,
  JobMatchResult
} from '@shared/types'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  need_to_know: '必读',
  need_approval: '待审批',
  todo: '待办',
  waiting: '等待',
  done: '已完成',
  dismissed: '已忽略'
}

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急'
}

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
  executed: '已执行'
}

export const RUN_STATUS_LABEL: Record<RoutineRunStatus, string> = {
  pending: '待运行',
  running: '运行中',
  waiting_approval: '待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: '已连接',
  expired: '已过期',
  error: '错误',
  disconnected: '未连接'
}

// Job applications (boss-cli integration). Wire identifiers stay English;
// only these display labels translate.
export const APPLICATION_SOURCE_LABEL: Record<ApplicationSource, string> = {
  boss: 'BOSS 直聘',
  manual: '手动',
  web: '官网',
  referral: '内推',
  email: '邮件',
  other: '其他'
}

export const APPLICATION_EVENT_LABEL: Record<ApplicationEventType, string> = {
  applied: '已投递',
  communicated: '已沟通',
  assessment: '测评',
  written_test: '笔试',
  interview: '面试',
  offer: '录用',
  rejected: '已拒',
  withdrawn: '已放弃'
}

// Milestone A — funnel priority + 面经 tags + smart-funnel buckets.
export const APPLICATION_PRIORITY_LABEL: Record<ApplicationPriority, string> = {
  normal: '正常',
  back: '靠后'
}

export const INTERVIEW_NOTE_TAG_LABEL: Record<InterviewNoteTag, string> = {
  algorithm: '算法',
  fundamentals: '八股',
  project: '项目',
  behavior: '行为',
  system_design: '系统设计'
}

export const SMART_FUNNEL_GROUP_LABEL: Record<SmartFunnelGroup, string> = {
  urgent: '紧急',
  active: '进行中',
  stale: '停滞',
  offered: '已录用',
  ended: '已结束',
  archived: '已归档'
}

// Job-recommendation match tiers (Milestone C). `tier` is a wire value from the
// `score_job_matches` agent step; only the display label translates.
export const JOB_TIER_LABEL: Record<JobMatchResult['tier'], string> = {
  high: '高匹配',
  medium: '中匹配',
  low: '低匹配',
  skip: '不推荐'
}

export const JOB_TIER_COLOR: Record<JobMatchResult['tier'], string> = {
  high: '#86efac',
  medium: '#fcd34d',
  low: '#fca5a5',
  skip: '#6b7280'
}

// Job recommendation bucket labels (校招生 dual-apply). The bucket VALUES
// (`intern`/`campus`) are wire identifiers used by the service to split
// results; only the display label translates.
export const JOB_BUCKET_LABEL: Record<string, string> = {
  intern: '实习',
  campus: '秋招正职'
}

// Notification category labels (Milestone D §D2). The category VALUES are wire
// identifiers (NotificationPrefs.categories keys); only the display label
// translates.
export const NOTIFICATION_CATEGORY_LABEL: Record<string, string> = {
  routine: '例程通知',
  approval: '审批请求',
  info: '其他通知',
  fortune: '每日运势'
}

/** Status badges surface raw enum values; never blank for a new member. */
export function statusLabel<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}
