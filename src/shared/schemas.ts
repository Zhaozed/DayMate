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
  RISK_LEVELS,
  APPROVAL_STATUSES,
  EMAIL_CLASSIFICATIONS,
  EMAIL_TOPICS,
  LLM_PROVIDERS,
  DEFAULT_LLM_MODEL_IDS,
  MEMORY_KEYS,
  APPLICATION_SOURCES,
  APPLICATION_EVENT_TYPES
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
    outputKey: z.string().optional(),
    continueOnError: z.boolean().optional()
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

// ── Approval (Spec §8, §15) ───────────────────────────────────────────────────
// approvalRequestSchema validates an ApprovalRequest surfaced to the renderer.
// `contentHash` is the SHA-256 of canonical JSON of the action args captured at
// preview time; it is rechecked at execution and any mismatch refuses the
// action (Spec §15 content immutability).
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES)
export const emailClassificationSchema = z.enum(EMAIL_CLASSIFICATIONS)
export const emailTopicSchema = z.enum(EMAIL_TOPICS)

export const approvalRequestSchema = z.object({
  id: z.string(),
  routineRunId: z.string().optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  riskLevel: z.enum(['R1', 'R2', 'R3']),
  title: z.string(),
  preview: z.record(z.unknown()),
  contentHash: z.string(),
  status: approvalStatusSchema,
  createdAt: z.string(),
  resolvedAt: z.string().optional()
})

// Result of classifying a single email in Auto Inbox (Spec §13.2). The agent
// step returns an array of these; the engine turns `reply`/`follow_up`/
// `information` (non-ignore) into tasks / need-to-knows, and never acts on an
// `untrusted` item (prompt-injection / SPAM fixture).
export const suggestedActionSchema = z.object({
  label: z.string(),
  toolName: z.string().optional(),
  args: z.record(z.unknown()).optional()
})

// Memory key + a passive memory proposal (Spec §16). Declared here (before the
// output schemas) because the agent-step outputs carry optional memoryProposals.
export const memoryKeySchema = z.enum(MEMORY_KEYS)

// A passive memory proposal. Optional on every agent-step output so the model
// may omit it without failing validation; the deterministic stubs populate it
// when there is something worth remembering. `memory.save_proposals` loops
// these through MemoryService.save → each lands confirmed:false.
export const memoryProposalSchema = z.object({
  key: memoryKeySchema,
  value: z.string().min(1).max(2000)
})

export const classificationSchema = z.object({
  provider: z.enum(['gmail', 'mail163']),
  accountId: z.string(),
  messageId: z.string(),
  classification: emailClassificationSchema,
  topic: emailTopicSchema,
  untrusted: z.boolean(),
  reason: z.string(),
  suggestedAction: suggestedActionSchema.optional()
})

// ── LLM configuration (M3) ──────────────────────────────────────────────────
export const llmProviderSchema = z.enum(LLM_PROVIDERS)

export const llmConfigInputSchema = z.object({
  provider: llmProviderSchema,
  modelId: z.string().min(1)
})

// Full LLM config surfaced to the renderer (key is represented only as a flag).
export const llmConfigSchema = llmConfigInputSchema.extend({
  keyConfigured: z.boolean()
})

// ── Agent-step output schemas (M3) ───────────────────────────────────────────
// Authoritative Zod schemas for the two agent-step outputs. The deterministic
// stubs produce values matching these shapes; the real LLM path validates the
// model's captured tool args against the same schemas before returning. These
// are the load-bearing contracts downstream routine templates read.
export const sourceRefSchema = z.object({
  type: z.enum(['email', 'calendar', 'task', 'activity']),
  id: z.string(),
  label: z.string().optional()
})

export const morningBriefOutputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  reason: z.string(),
  priority: z.enum(['medium', 'high', 'urgent']),
  sourceRefs: z.array(sourceRefSchema),
  suggestedActions: z.array(suggestedActionSchema),
  taskToCreate: z
    .object({
      title: z.string(),
      sourceId: z.string(),
      priority: z.enum(['low', 'medium', 'high', 'urgent'])
    })
    .nullable(),
  memoryProposals: z.array(memoryProposalSchema).optional()
})

export const classifyInboxOutputSchema = z.object({
  results: z.array(classificationSchema),
  counts: z.object({
    reply: z.number(),
    follow_up: z.number(),
    information: z.number(),
    ignore: z.number()
  }),
  topicCounts: z.object({
    fees_billing: z.number(),
    recruiting: z.number(),
    ads: z.number(),
    meeting: z.number(),
    general: z.number()
  }),
  memoryProposals: z.array(memoryProposalSchema).optional()
})

// Default model id helper (re-exported for the settings UI / gateway).
export function defaultModelIdFor(provider: 'anthropic' | 'openai'): string {
  return DEFAULT_LLM_MODEL_IDS[provider]
}

// ── Memory (Spec §16) ───────────────────────────────────────────────────────
// (memoryKeySchema + memoryProposalSchema are declared above, near the agent
// output schemas that reference them.)

export const memoryItemSchema = z.object({
  id: z.string(),
  key: memoryKeySchema,
  value: z.string(),
  source: z.string(),
  confirmed: z.boolean(),
  routineRunId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})

// ── Meeting Prep agent-step output (Spec §13.3) ─────────────────────────────
// Produces the meeting objective, context, and questions to publish as a Need
// to Know. `sourceRefs` tie each claim back to the email/calendar data so the
// user can verify (Spec §17.15: show source references).
export const meetingPrepOutputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  reason: z.string(),
  priority: z.enum(['medium', 'high', 'urgent']),
  objective: z.string(),
  context: z.array(z.string()),
  questions: z.array(z.string()),
  openActions: z.array(z.string()),
  sourceRefs: z.array(sourceRefSchema),
  suggestedActions: z.array(suggestedActionSchema),
  memoryProposals: z.array(memoryProposalSchema).optional()
})

// ── Daily Work Summary agent-step output (Spec §13.4) ────────────────────────
// Built ONLY from data Daymate actually handled (processed emails, created/
// completed tasks, meetings attended, waiting items, tomorrow's events). Must
// NOT infer productivity or slacking time (§13.4).
export const workSummaryOutputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  reason: z.string(),
  priority: z.enum(['medium', 'high', 'urgent']),
  processedEmails: z.number().int(),
  tasksCreated: z.number().int(),
  tasksCompleted: z.number().int(),
  meetingsAttended: z.number().int(),
  waitingItems: z.array(z.string()),
  tomorrowHighlights: z.array(z.string()),
  sourceRefs: z.array(sourceRefSchema),
  suggestedActions: z.array(suggestedActionSchema),
  memoryProposals: z.array(memoryProposalSchema).optional()
})

// ── Draft Reply agent-step output (Spec §13.5 tone-mirroring) ────────────────
// The body mirrors the user's own prior-reply voice. Never produced for an
// untrusted email (§17 — the deterministic overlay refuses + the model is
// instructed to decline). The approval step wraps `email.create_draft` with
// this body; contentHash is over the resolved args (§15).
export const draftReplyOutputSchema = z.object({
  to: z.array(mailAddressSchema),
  subject: z.string(),
  body: z.string().min(1),
  memoryProposals: z.array(memoryProposalSchema).optional()
})

// ── Job applications (boss-cli integration) ──────────────────────────────────
// `source` and event `type` are closed enums so a malformed payload (from a
// routine step arg or a manual IPC call) is rejected (Spec §5 Zod validation).
export const applicationSourceSchema = z.enum(APPLICATION_SOURCES)
export const applicationEventTypeSchema = z.enum(APPLICATION_EVENT_TYPES)

export const applicationSchema = z.object({
  id: z.string(),
  company: z.string(),
  position: z.string(),
  source: applicationSourceSchema,
  bossSecurityId: z.string().optional(),
  appliedAt: z.string(),
  channelRef: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const applicationEventSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  type: applicationEventTypeSchema,
  round: z.number().int().positive().optional(),
  role: z.enum(['hr', 'tech', 'business', 'cross']).optional(),
  subState: z.enum(['scheduled', 'done']).optional(),
  source: z.enum(['boss', 'email', 'manual']),
  sourceRef: z.string().optional(),
  evidence: z.string().optional(),
  locked: z.boolean().optional(),
  eventAt: z.string(),
  createdAt: z.string()
})

export const applicationViewSchema = z.object({
  application: applicationSchema,
  events: z.array(applicationEventSchema),
  currentStatus: applicationEventTypeSchema,
  currentRound: z.number().int().positive().optional(),
  isTerminal: z.boolean(),
  lastEventAt: z.string().optional(),
  daysSinceLastEvent: z.number().optional()
})

// Inputs from the renderer (manual create / manual event). Narrower than the
// stored shape — the service fills id/timestamps/source.
export const applicationCreateInputSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1),
  source: applicationSourceSchema.optional(),
  appliedAt: z.string().optional(),
  channelRef: z.string().optional(),
  notes: z.string().optional()
})

export const applicationEventInputSchema = z.object({
  applicationId: z.string().min(1),
  type: applicationEventTypeSchema,
  round: z.number().int().positive().optional(),
  role: z.enum(['hr', 'tech', 'business', 'cross']).optional(),
  subState: z.enum(['scheduled', 'done']).optional(),
  eventAt: z.string().optional(),
  evidence: z.string().optional(),
  locked: z.boolean().optional()
})

// boss-cli DTOs surfaced by the boss.* tools. Fields are optional/defensive
// because the real boss-cli envelope shape is reverse-engineered and may vary;
// the provider maps what it can. Mock fixtures fill the same shape.
export const bossJobSchema = z.object({
  provider: z.literal('boss'),
  accountId: z.string(),
  securityId: z.string(),
  jobName: z.string(),
  companyName: z.string(),
  salary: z.string().optional(),
  city: z.string().optional(),
  experience: z.string().optional(),
  degree: z.string().optional(),
  hrName: z.string().optional(),
  brandName: z.string().optional(),
  jobLabels: z.array(z.string()).optional()
})

