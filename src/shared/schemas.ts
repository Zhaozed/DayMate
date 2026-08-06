// Zod schemas for validating external and model outputs.
// Spec §5: "Validation: Zod; TypeBox only where required by Pi tools."
// Spec §11: "Tool Registry validates every parameter."
// Spec §12: Routine Schema is the contract a Routine JSON template must satisfy.

import { z } from 'zod'
import {
  ROBOT_STATES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_SOURCE_TYPES,
  APPROVAL_POLICIES,
  ROUTINE_OUTPUTS,
  ROUTINE_RUN_STATUSES,
  STEP_STATUSES,
  ACTIVITY_EVENT_TYPES,
  ACCOUNT_PROVIDERS,
  INTEGRATION_STATUSES,
  RISK_LEVELS
} from './constants'

// ── Robot / app ──────────────────────────────────────────────────────────────
export const robotStateSchema = z.enum(ROBOT_STATES)
export type RobotStateZod = z.infer<typeof robotStateSchema>

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string()
})

// ── Accounts ─────────────────────────────────────────────────────────────────
export const accountProviderSchema = z.enum(ACCOUNT_PROVIDERS)
export const integrationStatusSchema = z.enum(INTEGRATION_STATUSES)
export const riskLevelSchema = z.enum(RISK_LEVELS)

// ── Email / calendar primitives ─────────────────────────────────────────────
export const mailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string()
})

export const normalizedEmailSchema = z.object({
  provider: z.enum(['gmail', 'mail163']),
  accountId: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  from: mailAddressSchema,
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  subject: z.string(),
  textBody: z.string(),
  receivedAt: z.string(),
  unread: z.boolean(),
  labels: z.array(z.string()),
  sourceUrl: z.string().optional()
})

export const calendarEventSchema = z.object({
  provider: z.literal('feishu'),
  accountId: z.string(),
  eventId: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  attendees: z.array(mailAddressSchema),
  description: z.string().optional(),
  sourceUrl: z.string().optional()
})

// ── Task / Need to Know / Activity ──────────────────────────────────────────
export const taskStatusSchema = z.enum(TASK_STATUSES)
export const taskPrioritySchema = z.enum(TASK_PRIORITIES)
export const taskSourceTypeSchema = z.enum(TASK_SOURCE_TYPES)

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  dueAt: z.string().optional(),
  sourceType: taskSourceTypeSchema,
  sourceId: z.string().optional(),
  routineRunId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const activityEventTypeSchema = z.enum(ACTIVITY_EVENT_TYPES)
export const activityEventSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  type: activityEventTypeSchema,
  summary: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string()
})

// ── Routine Schema (Spec §12) ────────────────────────────────────────────────
// A Routine JSON template must validate against this. The engine refuses to run
// a Routine that does not parse, so malformed templates fail loudly.
export const routineTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('schedule'), cron: z.string(), timezone: z.string() }),
  z.object({ type: z.literal('email_poll'), intervalMinutes: z.number().int().positive() }),
  z.object({ type: z.literal('calendar_before'), minutesBefore: z.number().int().positive() })
])

export const routineStepSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('tool'),
    tool: z.string(),
    args: z.record(z.unknown()).optional(),
    outputKey: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('agent'),
    action: z.string(),
    inputs: z.record(z.unknown()).optional(),
    outputSchema: z.string().optional(),
    outputKey: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('condition'),
    expression: z.string(),
    thenStepId: z.string().optional(),
    elseStepId: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('create_task'),
    title: z.string(),
    description: z.string().optional(),
    priority: taskPrioritySchema.optional(),
    dueAt: z.string().optional(),
    sourceId: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('need_to_know'),
    fromKey: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    priority: z.enum(['medium', 'high', 'urgent']).optional(),
    reason: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('approval'),
    toolName: z.string(),
    args: z.record(z.unknown()),
    title: z.string()
  }),
  z.object({
    id: z.string(),
    type: z.literal('notify'),
    channel: z.enum(['desktop_robot', 'system']),
    message: z.string().optional()
  })
])

export const routineDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  trigger: routineTriggerSchema,
  inputs: z.record(z.unknown()),
  steps: z.array(routineStepSchema),
  approvalPolicy: z.enum(APPROVAL_POLICIES),
  output: z.enum(ROUTINE_OUTPUTS),
  createdAt: z.string(),
  updatedAt: z.string()
})

// Template form (no timestamps — seeded by the presets loader).
export const routineTemplateSchema = routineDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true
})

// ── Run state ────────────────────────────────────────────────────────────────
export const routineRunStatusSchema = z.enum(ROUTINE_RUN_STATUSES)
export const stepStatusSchema = z.enum(STEP_STATUSES)
