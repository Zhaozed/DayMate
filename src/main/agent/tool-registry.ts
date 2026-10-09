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
import type { RiskLevel, MemoryKey, NormalizedEmail } from '@shared/types'
import type { EmailProvider } from '../providers/email/email-provider'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type { TaskService } from '../services/task-service'
import type { NeedToKnowService } from '../services/need-to-know-service'
import type { ActivityService } from '../services/activity-service'
import type { MemoryService } from '../services/memory-service'
import type { ApplicationService } from '../services/application-service'
import type { Settings } from '../util/settings'
import { newId } from '../util/ids'
import {
  taskPrioritySchema,
  taskStatusSchema,
  classificationSchema,
  memoryKeySchema,
  applicationCreateInputSchema,
  applicationUpdateFieldsSchema,
  applicationEventTypeSchema,
  interviewNoteInputSchema
} from '@shared/schemas'

// ── web.fetch_jd (post-MVP) ─────────────────────────────────────────────────
// Proxy-aware HTML fetch DI (mirrors GmailFetch/FeishuFetch). The container
// wires Electron's `net.fetch` (Chromium stack → respects system proxy/VPN);
// tests pass a stub. Returns the response body as a string (HTML text). The
// `input` is a full URL. Defined via type queries to avoid bare `Response`/
// `RequestInit` globals (eslint no-undef).
export type WebFetch = (input: string) => Promise<string>

/**
 * Extract plain-text snippets from a DuckDuckGo HTML results page. DDG's
 * `/html/` endpoint renders `<a class="result__snippet">…</a>` text blocks.
 * We strip any nested tags and return an array of clean text snippets. §17:
 * the JD text surfaced by this tool is UNTRUSTED (public web content) — the
 * caller stores it as data and the renderer renders it in a `sandbox=""`
 * iframe, so even if a snippet carried `<script>` it could not execute. This
 * function additionally strips tags so the stored value is plain text.
 */
export function extractSnippets(html: string, max = 5): string[] {
  const out: string[] = []
  const isSpamOrNoise = (t: string): boolean =>
    /(boss直聘|zhipin\.com|和boss开聊|下载boss|58同城|看准网|赶集网|猎聘为您提供|智联招聘为您提供|boss直聘为您提供|汽车之家|懂车帝|太平洋汽车|易车|车系|在售车型|最新报价|首销期|纯电续航|零重力座椅|试驾|超充站|超充桩|指导价|落地价|二手车|汽车频道|在售车系|分期付款|4S店|景点胜地|热门旅游|客路)/i.test(t)

  // Match `<a class="result__snippet"...>…</a>` or `<td class="result-snippet">` blocks (DDG HTML / Lite).
  // Also match Bing snippet blocks: `<div class="b_caption">`, `b_snippet`, `b_lineclamp`.
  const re = /<(?:a|td|div|p)[^>]*class="[^"]*(?:result__snippet|result-snippet|b_caption|b_snippet|b_lineclamp)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|p)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const text = stripTags(m[1]).trim()
    if (text.length > 0 && !out.includes(text) && !isSpamOrNoise(text)) out.push(text)
  }
  if (out.length === 0) {
    // Fallback: grab text from the first few <p>/<li> blocks.
    const fallback = /<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/gi
    while ((m = fallback.exec(html)) !== null && out.length < max) {
      const text = stripTags(m[1]).trim()
      if (text.length > 0 && !out.includes(text) && !isSpamOrNoise(text)) out.push(text)
    }
  }
  return out
}

/** Strip HTML tags + decode the few entities we care about, return plain text. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

export interface ToolContext {
  runId?: string
  routineRunId?: string
  /** All connected email providers; email tools select by `accountId` (Spec §9). */
  emailProviders: EmailProvider[]
  calendarProvider: CalendarProvider
  taskService: TaskService
  needToKnowService: NeedToKnowService
  activityService: ActivityService
  /** Explicit, inspectable, deletable memory (Spec §16). */
  memoryService: MemoryService
  /** 投递漏斗 service (Milestone A) — applications + resume/prep/面经. */
  applicationService: ApplicationService
  /** Plain (non-secret) app settings (LLM config + jobSearch). Read-only for
   *  tools that need user-configured criteria (e.g. `job_search.get_intent`
   *  reads `jobIntent`). Optional: absent in tests that don't exercise it. */
  settings?: Settings
  /** Proxy-aware HTML fetch for `web.fetch_jd` (post-MVP). Optional: absent in
   *  tests; the tool returns an error when it's missing. Wired to Electron's
   *  `net.fetch` in prod (Chromium stack → respects system proxy/VPN). */
  webFetch?: WebFetch
  notify: (message: string) => void
  /** Present only when executing an already-approved action (M2). */
  approval?: { requestId: string }
  /** Agent runtime for intelligent verification / synthesis */
  agentRuntime?: import('./agent-runtime').AgentRuntime
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
        summary: `${name} 需要审批`,
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
        summary: `${name} 失败：${message}`,
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

  // List messages across ALL connected email accounts (Spec §9 multi-provider),
  // deduped by messageId — a forwarded mail present in both Gmail and 163 is
  // triaged once. Per-provider outages are logged as `provider_unavailable` and
  // skipped so the run continues with the surviving providers' mail (Spec M3
  // partial-failure). Account-agnostic: no accountId, so the Auto Inbox
  // Routine works unchanged across mock↔real provider swaps (real Gmail + 163
  // replace the mocks at index 0/1 via refreshEmailProviders).
  registry.register({
    name: 'email.list_all',
    description:
      'List messages across ALL connected email accounts, deduped by messageId. Per-provider outages are logged and skipped.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      unreadOnly: z.boolean().optional(),
      sinceHours: z.number().optional(),
      limit: z.number().optional()
    }),
    async execute(args, ctx) {
      const a = args as { unreadOnly?: boolean; sinceHours?: number; limit?: number }
      if (ctx.emailProviders.length === 0) throw new Error('No email provider connected')
      // Fan out to every provider in parallel; each failure is isolated so one
      // down account never kills the unified feed.
      const perProvider = await Promise.all(
        ctx.emailProviders.map(async (p) => {
          try {
            return await p.listMessages(a)
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            ctx.activityService.record({
              runId: ctx.runId,
              type: 'provider_unavailable',
              summary: `提供方不可用：${p.provider} (${p.accountId}) — ${message}`,
              metadata: { provider: p.provider, accountId: p.accountId, error: message }
            })
            return [] as NormalizedEmail[]
          }
        })
      )
      const all = perProvider.flat()
      // Cross-provider dedupe by RFC822 messageId (same mail forwarded to two
      // accounts is one triage item). Per-account dedup also runs in the
      // classify stub as a belt-and-suspenders guard.
      const seen = new Set<string>()
      const deduped: NormalizedEmail[] = []
      for (const e of all) {
        if (seen.has(e.messageId)) continue
        seen.add(e.messageId)
        deduped.push(e)
      }
      return { status: 'ok', data: deduped }
    }
  })

  // The user's OWN sent mail — the prior-reply tone corpus for draft-mirroring
  // (Spec §13.5). Read-only (R0): sent mail is the user's voice, the opposite
  // of §17-untrusted inbound mail; it is only ever a tone reference, never an
  // instruction source, and never sent anywhere without a separate approval.
  registry.register({
    name: 'email.list_sent',
    description: "List the user's own sent mail as a tone corpus for draft-mirroring (Spec §13.5). Read-only.",
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      accountId: z.string().optional(),
      toAddress: z.string().optional(),
      sinceHours: z.number().optional(),
      limit: z.number().optional()
    }),
    async execute(args, ctx) {
      const a = args as { accountId?: string; toAddress?: string; sinceHours?: number; limit?: number }
      const provider = emailProviderFor(ctx, a.accountId)
      const items = await provider.listSent(a)
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
    // §15 exception (ADR 0022): draft CREATION is R1 (auto, no approval) at
    // the user's explicit opt-out — drafts auto-save to the Drafts folder and
    // the user reviews + sends manually from the mail client, so the only
    // external write here is a low-risk draft insert (never a send). Draft
    // SENDING (email.send_draft below) stays R3 / approval-gated.
    name: 'email.create_draft',
    description:
      'Create an email draft (auto — no approval; §15 exception ADR 0022). The user reviews + sends the draft manually. Sending itself is email.send_draft (R3).',
    risk: 'R1',
    requiresApproval: false,
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
          title: `${c.classification === 'follow_up' ? '跟进' : '回复'}：${c.suggestedAction?.label ?? c.messageId}`,
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

  // ── Memory (Spec §16) — search = R0; save = R1 (local writes) ─────────────
  // memory.save auto-confirms and merges/updates the existing value for that
  // key in place (no manual confirmation gate — user preference). A user-
  // authored value for the same key is protected from agent overwrite (merge,
  // not clobber). Forbidden content (tokens, full email bodies, inferred
  // traits …) is rejected by validateMemoryContent before persisting.
  registry.register({
    name: 'memory.search',
    description: 'Search confirmed memory entries by free-text query.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ query: z.string() }),
    async execute(args, ctx) {
      const q = (args as { query: string }).query
      const items = ctx.memoryService.search(q)
      return { status: 'ok', data: items }
    }
  })

  registry.register({
    name: 'memory.save',
    description:
      'Save a memory entry. Auto-confirms and merges/updates the existing value for that key (user-authored values are protected). Forbidden content is rejected (Spec §16).',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      key: memoryKeySchema,
      value: z.string().min(1).max(2000)
    }),
    async execute(args, ctx) {
      const a = args as { key: MemoryKey; value: string }
      const item = ctx.memoryService.save({
        key: a.key,
        value: a.value,
        source: 'agent',
        routineRunId: ctx.routineRunId
      })
      return { status: 'ok', data: { id: item.id, key: item.key, confirmed: item.confirmed } }
    }
  })

  // Save a batch of passive memory proposals from an agent step (Spec §16).
  // Each proposal loops through MemoryService.save → auto-confirms and merges/
  // updates the existing value for that key (user-authored protected). Per-item
  // try/catch: a rejected item (validateMemoryContent throws on a secret / full
  // email body / forbidden inferred trait) becomes a logged Activity, never
  // fails the run. R0: these are local writes, not external actions.
  registry.register({
    name: 'memory.save_proposals',
    description:
      'Save a batch of memory proposals (Spec §16). Each auto-confirms and merges/updates the existing value for that key. Per-item failures are logged, not fatal.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      proposals: z.array(z.object({ key: memoryKeySchema, value: z.string().min(1).max(2000) })).optional().default([])
    }),
    async execute(args, ctx) {
      const a = args as { proposals?: Array<{ key: MemoryKey; value: string }> }
      const proposals = a.proposals ?? []
      const saved: { id: string; key: MemoryKey; confirmed: boolean }[] = []
      const rejected: { key: string; reason: string }[] = []
      for (const p of proposals) {
        try {
          const item = ctx.memoryService.save({
            key: p.key,
            value: p.value,
            source: 'agent',
            routineRunId: ctx.routineRunId
          })
          saved.push({ id: item.id, key: item.key, confirmed: item.confirmed })
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          rejected.push({ key: p.key, reason })
          ctx.activityService.record({
            runId: ctx.routineRunId,
            type: 'tool_requested',
            summary: `记忆提议被拒绝（${p.key}）：${reason}`
          })
        }
      }
      return { status: 'ok', data: { saved, savedCount: saved.length, rejectedCount: rejected.length } }
    }
  })

  registry.register({
    name: 'memory.delete',
    description: 'Delete a memory entry by id.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({ id: z.string() }),
    async execute(args, ctx) {
      const a = args as { id: string }
      ctx.memoryService.delete(a.id)
      return { status: 'ok', data: { deleted: a.id } }
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

  // ── 投递漏斗 (Milestone A) — application CRUD + resume/prep/面经 ──────────────
  // All local DB writes (R1) — no external effect, no approval needed (Spec §11).
  // JD stored on the application row is UNTRUSTED (§17); it only ever reaches a
  // model via frameJd in a USER message, never the system prompt.
  registry.register({
    name: 'application.search',
    description:
      'Search the active application funnel by company/position/city substring, or fetch one by id. R0 read.',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      id: z.string().optional(),
      company: z.string().optional(),
      position: z.string().optional(),
      city: z.string().optional()
    }),
    async execute(args, ctx) {
      const a = args as { id?: string; company?: string; position?: string; city?: string }
      const views = ctx.applicationService.searchApplications(a)
      return { status: 'ok', data: views }
    }
  })

  registry.register({
    name: 'application.create',
    description: 'Create a manual application (官网/内推) with rich fields. R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: applicationCreateInputSchema,
    async execute(args, ctx) {
      const view = ctx.applicationService.create(args as Parameters<ApplicationService['create']>[0])
      return { status: 'ok', data: view }
    }
  })

  registry.register({
    name: 'application.update_field',
    description: 'Update editable rich fields on an application (single-field refresh). R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: applicationUpdateFieldsSchema.extend({ id: z.string() }),
    async execute(args, ctx) {
      const a = args as { id: string } & Record<string, unknown>
      const { id, ...patch } = a
      const view = ctx.applicationService.updateFields(id, patch)
      if (!view) return { status: 'error', error: `未找到投递记录：${id}` }
      return { status: 'ok', data: view }
    }
  })

  registry.register({
    name: 'application.add_event',
    description: 'Append a manual progress event to an application (locked by default). R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      applicationId: z.string(),
      type: applicationEventTypeSchema,
      round: z.number().optional(),
      role: z.enum(['hr', 'tech', 'business', 'cross']).optional(),
      subState: z.enum(['scheduled', 'done']).optional(),
      evidence: z.string().optional(),
      eventAt: z.string().optional(),
      locked: z.boolean().optional()
    }),
    async execute(args, ctx) {
      const view = ctx.applicationService.addEvent(args as Parameters<ApplicationService['addEvent']>[0])
      return { status: 'ok', data: view }
    }
  })

  registry.register({
    name: 'application.get_latest_resume',
    description: 'Get the latest AI resume version (HTML) for an application. R0 read (transcript routine step).',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ applicationId: z.string() }),
    async execute(args, ctx) {
      const a = args as { applicationId: string }
      const resume = ctx.applicationService.getLatestResume(a.applicationId)
      return { status: 'ok', data: resume ?? null }
    }
  })

  registry.register({
    name: 'application.save_resume',
    description: 'Save a new AI resume version for an application (version = prev+1). R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      applicationId: z.string(),
      html: z.string(),
      modelId: z.string().optional(),
      promptHash: z.string().optional()
    }),
    async execute(args, ctx) {
      const a = args as { applicationId: string; html: string; modelId?: string; promptHash?: string }
      const v = ctx.applicationService.saveResume(a.applicationId, a.html, a.modelId, a.promptHash)
      return { status: 'ok', data: v }
    }
  })

  registry.register({
    name: 'application.save_prep_material',
    description: 'Save a new interview-prep transcript version for an application. R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: z.object({
      applicationId: z.string(),
      html: z.string(),
      modelId: z.string().optional(),
      promptHash: z.string().optional()
    }),
    async execute(args, ctx) {
      const a = args as { applicationId: string; html: string; modelId?: string; promptHash?: string }
      const m = ctx.applicationService.savePrepMaterial(a.applicationId, a.html, a.modelId, a.promptHash)
      return { status: 'ok', data: m }
    }
  })

  registry.register({
    name: 'interview_notes.search',
    description: 'Search the 面经库 (interview-experience notes) by free-text query. R0 read (transcript routine step).',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({ query: z.string().optional() }),
    async execute(args, ctx) {
      const q = (args as { query?: string }).query
      const notes = ctx.applicationService.listInterviewNotes(q)
      return { status: 'ok', data: notes }
    }
  })

  registry.register({
    name: 'interview_notes.create',
    description: 'Create a 面经 (interview-experience note). source is manual (trusted). R1 local write.',
    risk: 'R1',
    requiresApproval: false,
    parameters: interviewNoteInputSchema.extend({ applicationId: z.string().optional() }),
    async execute(args, ctx) {
      const a = (args as { tags: string[]; content: string; company?: string; position?: string; applicationId?: string }) as Parameters<
        ApplicationService['createInterviewNote']
      >[0] & { tags: string[] }
      // interviewNoteInputSchema already validates tags via interviewNoteTagSchema;
      // cast through the input type the service expects.
      const note = ctx.applicationService.createInterviewNote({
        company: a.company,
        position: a.position,
        applicationId: a.applicationId,
        tags: a.tags as Parameters<ApplicationService['createInterviewNote']>[0]['tags'],
        content: a.content
      })
      return { status: 'ok', data: note }
    }
  })

  // ── Web (post-MVP: JD enrichment) ──────────────────────────────────────────
  registry.register({
    name: 'web.fetch_jd',
    description:
      'Fetch a best-effort job-description snippet from the public web (DuckDuckGo HTML) for a company+position+jobCode. R0 read — never sends, never writes externally. The returned text is UNTRUSTED public web content (§17): the caller stores it as data and the renderer renders it in a sandboxed iframe. On-demand only (web quality is inconsistent — the user reviews before accepting).',
    risk: 'R0',
    requiresApproval: false,
    parameters: z.object({
      company: z.string(),
      position: z.string().optional(),
      jobCode: z.string().optional()
    }),
    async execute(args, ctx) {
      if (!ctx.webFetch) {
        return { status: 'error', error: 'web 抓取未配置（无 webFetch 注入）' }
      }
      const a = args as { company: string; position?: string; jobCode?: string }
      const queries: string[] = []
      if (a.company && a.position) {
        const isAutoBrand = /(汽车|车控|动力|出行)/i.test(a.company)
        const negKeywords = isAutoBrand
          ? '-汽车之家 -懂车帝 -报价 -车系 -在售 -车型 -4S店'
          : '-boss直聘 -zhipin'
        if (a.jobCode) {
          queries.push(`"${a.company}" 校园招聘 "${a.jobCode}" 岗位职责 ${negKeywords}`.trim())
          queries.push(`"${a.company}" 校招 "${a.position}" "${a.jobCode}" 任职要求 ${negKeywords}`.trim())
        }
        queries.push(`"${a.company}" 校园招聘 "${a.position}" 岗位职责 任职要求 ${negKeywords}`.trim())
        queries.push(`"${a.company}" 校招 "${a.position}" 招聘官网 岗位职责 ${negKeywords}`.trim())
      } else if (a.company) {
        queries.push(`"${a.company}" 校园招聘官网 职位详情 岗位职责 -boss直聘 -zhipin`)
      } else {
        return { status: 'ok', data: { text: '', note: '缺少公司名称，无法检索 JD' } }
      }

      const allSnippets: string[] = []
      let lastErr: unknown = null
      let successCount = 0
      for (const q of queries) {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q.trim())}`
        const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(q.trim())}`
        let html: string | null = null
        try {
          html = await ctx.webFetch(ddgUrl)
          successCount++
        } catch (ddgErr) {
          lastErr = ddgErr
          try {
            html = await ctx.webFetch(bingUrl)
            successCount++
          } catch (bingErr) {
            lastErr = bingErr
          }
        }
        if (html) {
          const snippets = extractSnippets(html, 5)
          for (const s of snippets) {
            if (!allSnippets.includes(s)) {
              allSnippets.push(s)
            }
          }
          if (allSnippets.length >= 4) break
        }
      }

      if (allSnippets.length === 0 && successCount === 0 && lastErr) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
        return {
          status: 'error',
          error: `web 抓取失败：网络检索受限（${msg}），国内云服务器访问公网搜索可能超时，建议直接手动粘贴 JD`
        }
      }

      if (allSnippets.length === 0) {
        return {
          status: 'ok',
          data: {
            text: '',
            note: '未在公开互联网检索到该岗位的真实校招 JD（已过滤无关产品报价与企业宣传），建议直接手动粘贴补充'
          }
        }
      }

      // If Agent runtime is available, invoke intelligent verification and extraction
      if (ctx.agentRuntime) {
        try {
          const enrichResult = (await ctx.agentRuntime.runAgentStep('enrich_job_description', {
            company: a.company,
            position: a.position || '',
            jobCode: a.jobCode,
            snippets: allSnippets
          })) as { isValid?: boolean; jdText?: string; reason?: string }
          if (enrichResult && enrichResult.isValid && enrichResult.jdText) {
            return { status: 'ok', data: { text: enrichResult.jdText } }
          }
          return {
            status: 'ok',
            data: {
              text: '',
              note: enrichResult?.reason || '未在公开互联网检索到该岗位的真实校招职责描述，建议手动粘贴补充'
            }
          }
        } catch {
          // If Agent runtime call threw, fall back to clean snippets join
        }
      }

      // Plain-text join (§17: tags already stripped in extractSnippets; the
      // stored value is inert text, rendered sandboxed regardless).
      return { status: 'ok', data: { text: allSnippets.join('\n\n') } }
    }
  })

  return registry
}
