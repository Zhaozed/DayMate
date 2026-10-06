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
  MemoryKey,
  TaskCategory,
  BriefingCategory
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

// ADR 0027 — ToDo category badge (coarse domain tag: 学校/求职/账单/会议/其他).
export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  school: '学校',
  job: '求职',
  bill: '账单',
  meeting: '会议',
  other: '其他'
}

// 邮件聚合页 3 分类标签 (学校 / 求职 / 日常)
export const BRIEFING_CATEGORY_LABEL: Record<BriefingCategory, string> = {
  school: '学校',
  job: '求职',
  daily: '日常'
}

// 邮件聚合页展示顺序 (学校 → 求职 → 日常)
export const BRIEFING_CATEGORY_ORDER: BriefingCategory[] = ['school', 'job', 'daily']

// ADR 0029 — email source provider badge. Maps the wire value to the brand
// label the user recognizes. Gmail has a real deep link; 163 links to the
// webmail root (no per-message deep link on 163).
export const PROVIDER_LABEL: Record<'gmail' | 'mail163', string> = {
  gmail: 'Gmail',
  mail163: '163'
}

// ADR 0029 — 必读 sourceRef type label (replaces the raw `s.type` string that
// used to render as "email：…" inline).
export const SOURCE_REF_TYPE_LABEL: Record<string, string> = {
  email: '邮件',
  calendar: '日历',
  task: '任务',
  activity: '动态'
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
  rejected: '感谢信 / 淘汰',
  withdrawn: '已放弃'
}

/** Interview role label — only for `interview` events. */
export const INTERVIEW_ROLE_LABEL: Record<'hr' | 'tech' | 'business' | 'cross', string> = {
  hr: 'HR',
  tech: '技术',
  business: '业务',
  cross: '交叉'
}

/** Interview/assessment sub-state label. */
export const EVENT_SUBSTATE_LABEL: Record<'scheduled' | 'done', string> = {
  scheduled: '已约',
  done: '已完成'
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



// Notification category labels (Milestone D §D2). The category VALUES are wire
// identifiers (NotificationPrefs.categories keys); only the display label
// translates.
export const NOTIFICATION_CATEGORY_LABEL: Record<string, string> = {
  routine: '例程通知',
  approval: '审批请求',
  info: '其他通知',
  fortune: '每日运势'
}

// Memory key labels (Spec §16, ADR 0009 town-style profile). The key VALUES are
// wire identifiers (stored in the memory_items table, used by the agent's
// memory.search); only the display label translates. Used by the Memory page's
// 用户画像 grouping + the key selector.
export const MEMORY_KEY_LABEL: Record<MemoryKey, string> = {
  email_tone: '邮件语气',
  writing_style: '写作风格',
  persona: '用户画像',
  working_hours: '工作时间',
  meeting_duration: '会议时长',
  contact: '联系人',
  project: '项目',
  notification_prefs: '通知偏好',
  job_search_profile: '求职画像',
  other: '其他'
}

// Which memory keys form the "用户画像" (profile) section vs. the flat lists.
export const PROFILE_MEMORY_KEYS: MemoryKey[] = [
  'persona',
  'writing_style',
  'email_tone',
  'working_hours',
  'job_search_profile',
  'meeting_duration'
]
export const LIST_MEMORY_KEYS: MemoryKey[] = ['contact', 'project', 'notification_prefs']

/** Status badges surface raw enum values; never blank for a new member. */
export function statusLabel<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}
