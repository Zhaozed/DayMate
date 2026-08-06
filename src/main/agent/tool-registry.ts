// Tool Registry — the ONLY path the Agent uses to reach external systems
// (Spec §11). Tools are registered with a Zod parameter schema, a risk level,
// and an execute function. The registry validates every call's parameters
// (Spec §17.3) and gates external writes by risk:
//
//   R0/R1  — automatic (R1 also logs an Activity event)
//   R2/R3  — approval required; calling without an approval context returns
//            `{ status: 'needs_approval' }` and the action is NOT executed.
//            The Routine Engine pauses and surfaces it. (Approval execution
//            lands in M2; the gating shape is defined here.)
//   R4     — forbidden in MVP; registration throws.
//
// The Agent may select tools but cannot bypass the registry or the Approval
// Service (Spec §11).

import { z } from 'zod'
import type { RiskLevel } from '@shared/types'
import type { EmailProvider } from '../providers/email/email-provider'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type { TaskService } from '../services/task-service'
import type { NeedToKnowService } from '../services/need-to-know-service'
import type { ActivityService } from '../services/activity-service'
import { newId } from '../util/ids'
import { taskPrioritySchema, taskStatusSchema, classificationSchema } from '@shared/schemas'

export interface ToolContext {
  runId?: string
  routineRunId?: string
  /** All connected email providers; email tools select by `accountId` (Spec §9). */
  emailProviders: EmailProvider[]
  calendarProvider: CalendarProvider
  taskService: TaskService
  needToKnowService: NeedToKnowService
  activityService: ActivityService
  /** M1 in-process memory stub (real Memory Service is M5). */
  memory: Map<string, string>
  notify: (message: string) => void
  /** Present only when executing an already-approved action (M2). */
  approval?: { requestId: string }
}

/** Resolve the email provider for an `accountId`; throws if none matches. */
function emailProviderFor(ctx: ToolContext, accountId?: string): EmailProvider {
  if (!accountId) {
    // No account specified — use the first connected provider (convenience
    // for single-account routines; multi-account routines must be explicit).
    const [p] = ctx.emailProviders
    if (!p) throw new Error('No email provider connected')
    return p
  }
  const p = ctx.emailProviders.find((x) => x.accountId === accountId)
  if (!p) throw new Error(`No email provider for accountId: ${accountId}`)
  return p
}

export type ToolResult =
  | { status: 'ok'; data: unknown }
  | { status: 'needs_approval'; risk: 'R2' | 'R3'; toolCallId: string; preview: Record<string, unknown> }
  | { status: 'error'; error: string }

export interface RegisteredTool {
  name: string
  description: string
  risk: RiskLevel
  requiresApproval: boolean
  parameters: z.ZodTypeAny
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    if (tool.risk === 'R4') {
      // Spec §11: R4 (delete external data) is forbidden in MVP.
      throw new Error(`R4 tools are forbidden in MVP: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { status: 'error', error: `Unknown tool: ${name}` }

    // Spec §17.3: validate every parameter.
    const parsed = tool.parameters.safeParse(rawArgs)
    if (!parsed.success) {
      return { status: 'error', error: `Invalid parameters: ${parsed.error.message}` }
    }

    // Risk gate: external writes require an approval context.
    if (tool.requiresApproval && !ctx.approval) {
      const toolCallId = newId('call')
      ctx.activityService.record({
        runId: ctx.runId,
        type: 'approval_requested',
        summary: `Approval requested for ${name}`,
        metadata: { tool: name, risk: tool.risk, toolCallId }
      })
      return {
        status: 'needs_approval',
        risk: tool.risk === 'R2' || tool.risk === 'R3' ? tool.risk : 'R3',
        toolCallId,
        preview: (parsed.data as Record<string, unknown>) ?? {}
      }
    }

    try {
      const result = await tool.execute(parsed.data, ctx)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.activityService.record({
        runId: ctx.runId,
        type: 'tool_failed',
        summary: `${name} failed: ${message}`,
        metadata: { tool: name, error: message }
      })
      return { status: 'error', error: message }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function rangeBounds(range: 'today' | 'this_week'): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  if (range === 'today') {
    end.setHours(23, 59, 59, 999)
  } else {
    // this_week: Sunday → Saturday
    const day = now.getDay()
    start.setDate(now.getDate() - day)
    start.setHours(0, 0, 0, 0)
    end.setDate(now.getDate() - day + 6)
    end.setHours(23, 59, 59, 999)
  }
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── P0 tool factory ──────────────────────────────────────────────────────────
// Wires the mock providers and services into the registry. The same registry
// shape will hold real Gmail/163/Feishu-backed tools in M2/M3.

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // ── Email (read = R0) ─────────────────────────────────────────────────────
  registry.register({
    name: 'email.list',
    description: 'List messages from a connected email account.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      accountId: z.string().optional(),
      unreadOnly: z.boolean().optional(),
      sinceHours: z.number().optional(),
      limit: z.number().optional()
    }),
    async execute(args, ctx) {
      const a = args as { accountId?: string; unreadOnly?: boolean; sinceHours?: number; limit?: number }
      const provider = emailProviderFor(ctx, a.accountId)
      const items = await provider.listMessages(a)
      return { status: 'ok', data: items }
    }
  })

  registry.register({
    name: 'email.search',
    description: 'Search messages by text query on a connected account.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ accountId: z.string().optional(), query: z.string(), limit: z.number().optional() }),
    async execute(args, ctx) {
      const a = args as { accountId?: string; query: string; limit?: number }
      const provider = emailProviderFor(ctx, a.accountId)
      const items = await provider.searchMessages(a.query, a.limit)
      return { status: 'ok', data: items }
    }
  })

  registry.register({
    name: 'email.get',
    description: 'Get a single message by id from a connected account.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ accountId: z.string().optional(), messageId: z.string() }),
    async execute(args, ctx) {
      const a = args as { accountId?: string; messageId: string }
      const provider = emailProviderFor(ctx, a.accountId)
      const msg = await provider.getMessage(a.messageId)
      return { status: 'ok', data: msg }
    }
  })

  registry.register({
    name: 'email.create_draft',
    description: 'Create an email draft. R3 — preview + approval required before send.',
    risk: 'R3',
    requiresApproval: true,
    parameters: z.object({
      accountId: z.string(),
      threadId: z.string().optional(),
      to: z.array(z.object({ name: z.string().optional(), address: z.string() })),
      cc: z.array(z.object({ name: z.string().optional(), address: z.string() })).optional(),
      subject: z.string(),
      body: z.string()
    }),
    async execute(args, ctx) {
      const a = args as Parameters<EmailProvider['createDraft']>[0]
      const provider = emailProviderFor(ctx, a.accountId)
      const draft = await provider.createDraft(a)
      return { status: 'ok', data: draft }
    }
  })

  registry.register({
    name: 'email.send_draft',
    description: 'Send an existing draft. R3 — preview + approval required. No send without approval.',
    risk: 'R3',
    requiresApproval: true,
    parameters: z.object({ accountId: z.string(), draftId: z.string() }),
    async execute(args, ctx) {
      const a = args as { accountId: string; draftId: string }
      const provider = emailProviderFor(ctx, a.accountId)
      const result = await provider.sendDraft(a.draftId)
      return { status: 'ok', data: result }
    }
  })

  // ── Calendar (read = R0; create/update = R2) ──────────────────────────────
  registry.register({
    name: 'calendar.list',
    description: 'List calendar events in a date range (explicit start/end, or a relative range).',
    risk: 'R0',
    requiresApproval: false,
    parameters: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        range: z.enum(['today', 'this_week']).optional()
      })
      .refine((v) => (v.start && v.end) || v.range, {
        message: 'Provide start+end or a range'
      }),
    async execute(args, ctx) {
      const a = args as { start?: string; end?: string; range?: 'today' | 'this_week' }
      let { start, end } = a
      if (a.range) {
        const bounds = rangeBounds(a.range)
        start = bounds.start
        end = bounds.end
      }
      const items = await ctx.calendarProvider.listEvents({ start: start!, end: end! })
      return { status: 'ok', data: items }
    }
  })

  registry.register({
    name: 'calendar.get',
    description: 'Get a single calendar event by id.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ eventId: z.string() }),
    async execute(args, ctx) {
      const a = args as { eventId: string }
      const evt = await ctx.calendarProvider.getEvent(a.eventId)
      return { status: 'ok', data: evt }
    }
  })

  // ── Tasks (R1 — local writes, automatic + log) ────────────────────────────
  registry.register({
    name: 'task.list',
    description: 'List all Tasks.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({}),
    async execute(_args, ctx) {
      return { status: 'ok', data: ctx.taskService.list() }
    }
  })

  registry.register({
    name: 'task.create',
    description: 'Create a Task. Idempotent by sourceId.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      title: z.string(),
      description: z.string().optional(),
      priority: taskPrioritySchema.optional(),
      dueAt: z.string().optional(),
      sourceId: z.string().optional()
    }),
    async execute(args, ctx) {
      const a = args as {
        title: string
        description?: string
        priority?: 'low' | 'medium' | 'high' | 'urgent'
        dueAt?: string
        sourceId?: string
      }
      const task = ctx.taskService.create({
        title: a.title,
        description: a.description,
        priority: a.priority,
        dueAt: a.dueAt,
        sourceType: 'routine',
        sourceId: a.sourceId,
        routineRunId: ctx.routineRunId
      })
      return { status: 'ok', data: task }
    }
  })

  registry.register({
    name: 'task.update',
    description: 'Update a Task (status, priority).',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      id: z.string(),
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional()
    }),
    async execute(args, ctx) {
      const a = args as { id: string; status?: Parameters<typeof ctx.taskService.update>[1]['status']; priority?: 'low' | 'medium' | 'high' | 'urgent' }
      const task = ctx.taskService.update(a.id, { status: a.status, priority: a.priority })
      return { status: 'ok', data: task }
    }
  })

  registry.register({
    name: 'task.complete',
    description: 'Mark a Task done.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ id: z.string() }),
    async execute(args, ctx) {
      const a = args as { id: string }
      const task = ctx.taskService.complete(a.id)
      return { status: 'ok', data: task }
    }
  })

  // ── Inbox — turn classifications into Tasks (R1, idempotent by messageId) ──
  registry.register({
    name: 'inbox.create_tasks',
    description:
      'Create a Task for each actionable (non-ignore, non-untrusted) Auto Inbox classification. Idempotent by sourceId = messageId.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ classifications: z.array(classificationSchema) }),
    async execute(args, ctx) {
      const a = args as { classifications: Array<{ provider: string; accountId: string; messageId: string; classification: string; untrusted: boolean; reason: string; suggestedAction?: { label: string } }> }
      const created = []
      for (const c of a.classifications) {
        // Ignore / untrusted items never produce a Task (Spec §17).
        if (c.classification === 'ignore' || c.untrusted) continue
        const task = ctx.taskService.create({
          title: `${c.classification === 'follow_up' ? 'Follow up' : 'Reply'}: ${c.suggestedAction?.label ?? c.messageId}`,
          sourceType: 'email',
          sourceId: `${c.provider}:${c.messageId}`,
          priority: c.classification === 'follow_up' ? 'high' : 'medium',
          routineRunId: ctx.routineRunId
        })
        created.push(task)
      }
      return { status: 'ok', data: { created, count: created.length } }
    }
  })

  // ── Memory (R0/R1; real Memory Service is M5) ─────────────────────────────
  registry.register({
    name: 'memory.search',
    description: 'Search saved memory entries (M1 stub).',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ query: z.string() }),
    async execute(args, ctx) {
      const q = (args as { query: string }).query.toLowerCase()
      const out: Record<string, string> = {}
      for (const [k, v] of ctx.memory) {
        if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) out[k] = v
      }
      return { status: 'ok', data: out }
    }
  })

  registry.register({
    name: 'memory.save',
    description: 'Save a memory entry (M1 stub; real confirmation flow in M5).',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ key: z.string(), value: z.string() }),
    async execute(args, ctx) {
      const a = args as { key: string; value: string }
      ctx.memory.set(a.key, a.value)
      return { status: 'ok', data: { key: a.key } }
    }
  })

  registry.register({
    name: 'memory.delete',
    description: 'Delete a memory entry (M1 stub).',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ key: z.string() }),
    async execute(args, ctx) {
      const a = args as { key: string }
      ctx.memory.delete(a.key)
      return { status: 'ok', data: { deleted: a.key } }
    }
  })

  // ── Desktop notify (R1) ──────────────────────────────────────────────────
  registry.register({
    name: 'desktop.notify',
    description: 'Send a desktop notification via the robot surface.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ message: z.string().optional() }),
    async execute(args, ctx) {
      const message = (args as { message?: string }).message ?? 'Daymate update'
      ctx.notify(message)
      return { status: 'ok', data: { notified: true } }
    }
  })

  return registry
}
