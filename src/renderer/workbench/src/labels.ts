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
  ApplicationEventType
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

/** Status badges surface raw enum values; never blank for a new member. */
export function statusLabel<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}
