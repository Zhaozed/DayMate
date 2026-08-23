// Routine Engine (Spec §12). Schema-driven, deterministic execution order,
// agent reasoning only inside explicit agent steps, resumable after approval,
// idempotent, observable, capped, extendable.
//
// Required behavior (Spec §12 "Required behavior"):
//   1. create Routine Run record
//   2. persist current step before execution
//   3. write an Activity Event for every step
//   4. on approval requirement, persist context and pause
//   5. after approval, resume from the same step
//   6. prevent duplicate external writes using idempotency key
//   7. stop after configured maximum steps
//   8. surface clear user-facing error
//   9. never silently skip failed high-risk steps

import type { RoutineStore } from '../db/store'
import type { ToolRegistry, ToolContext } from '../agent/tool-registry'
import type { ToolResult } from '../agent/tool-registry'
import type { ActivityService } from '../services/activity-service'
import type { TaskService } from '../services/task-service'
import type { NeedToKnowService } from '../services/need-to-know-service'
import type { ApprovalService } from '../services/approval-service'
import type { MemoryService } from '../services/memory-service'
import type { EmailProvider } from '../providers/email/email-provider'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type { BossProvider } from '../providers/boss/boss-provider'
import type { ApplicationService } from '../services/application-service'
import type { Settings } from '../util/settings'
import type {
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  RoutineStep
} from '@shared/types'
import type { PublishableBrief, AgentRuntime } from '../agent/agent-runtime'
import { resolveTemplate } from './template'
import { newId, nowIso } from '../util/ids'
import { ROUTINE_MAX_STEPS } from '@shared/constants'
import { routineTemplateSchema } from '@shared/schemas'
import { PRESET_IDS } from './presets'

/** The only agent actions a custom Routine may reference (Spec §14). */
const KNOWN_AGENT_ACTIONS = new Set([
  'generate_morning_brief',
  'classify_inbox',
  'generate_meeting_prep',
  'generate_work_summary',
  'generate_resume',
  'generate_interview_transcript',
  'classify_application_email',
  'generate_funnel_review',
  'score_job_matches',
  'generate_daily_fortune'
])

export interface RunOptions {
  manual?: boolean
  /** Explicit idempotency key — when set, a second run with the same key is a no-op. */
  idempotencyKey?: string
  inputs?: Record<string, unknown>
}

export interface ResumeOptions {
  /** Present only when resuming an approved action (M2 wires the approval UI). */
  approval: { requestId: string }
}

export interface EngineDeps {
  store: RoutineStore
  toolRegistry: ToolRegistry
  activityService: ActivityService
  taskService: TaskService
  needToKnowService: NeedToKnowService
  approvalService: ApprovalService
  emailProviders: EmailProvider[]
  calendarProvider: CalendarProvider
  /** BOSS 直聘 provider (boss-cli); single account. */
  bossProvider: BossProvider
  /**
   * The agent runtime that executes `agent` steps (Spec §12: agent reasoning
   * only inside explicit agent steps). Key-gated: no LLM key → deterministic
   * stub; key configured → real model via the ModelGateway (M3).
   */
  agentRuntime: AgentRuntime
  /** Explicit, inspectable, deletable memory (Spec §16). */
  memoryService: MemoryService
  /** 投递漏斗 service (Milestone A) — wired into ToolContext for app tools. */
  applicationService: ApplicationService
  /** Plain (non-secret) app settings — wired into ToolContext for tools that
   *  read user-configured criteria (Milestone C: `job_search.get_intent`).
   *  Optional so tests constructing a minimal EngineDeps compile unchanged. */
  settings?: Settings
  /** Proxy-aware HTML fetch for `web.fetch_jd` (post-MVP JD enrichment).
   *  Optional: the tool returns an error when absent. Wired to Electron
   *  `net.fetch` in prod; tests omit it. */
  webFetch?: import('../agent/tool-registry').WebFetch
  /** Push a notification to the robot surface. */
  notify: (message: string) => void
  /** Rich notify path (Milestone D §D2): carries the firing routineId +
   *  category so NotificationService can apply per-routine / per-category
   *  toggles + quiet hours + aggregation. When present, `execNotifyStep`
   *  prefers it over the plain `notify`. Optional — tests use the plain path. */
  notifyRich?: (input: {
    message: string
    category?: 'routine' | 'approval' | 'info'
    routineId?: string
    navigateTo?: import('@shared/types').WorkbenchPage
  }) => void
}

interface StepOutcome {
  output: unknown
  /** Set when the step paused waiting for approval (Spec §12.4). */
  paused?: boolean
}

export class RoutineEngine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Create a custom routine from builder JSON (Spec §14). The def is parsed
   * against the Routine Schema — a malformed routine is refused, so users can
   * never inject arbitrary steps ("Users cannot insert arbitrary code" §14).
   * Preset ids are reserved; a custom routine cannot shadow one.
   */
  async createRoutine(def: Omit<RoutineDefinition, 'createdAt' | 'updatedAt'>): Promise<RoutineDefinition> {
    const parsed = routineTemplateSchema.parse(def) // throws on malformed shape
    if (PRESET_IDS.includes(parsed.id)) {
      throw new Error(`无法创建例程：id「${parsed.id}」是受保留的预设 id`)
    }
    if (this.deps.store.getRoutine(parsed.id)) {
      throw new Error(`id 为「${parsed.id}」的例程已存在`)
    }
    // Spec §14 "Users cannot insert arbitrary code": constrain every tool /
    // approval step to a Tool Registry entry. The schema alone accepts any
    // string toolName; this is the defence-in-depth gate.
    for (const step of parsed.steps) {
      const name = step.type === 'tool' ? step.tool : step.type === 'approval' ? step.toolName : undefined
      if (name && !this.deps.toolRegistry.get(name)) {
        throw new Error(`步骤 ${step.id} 中存在未知工具：${name}`)
      }
      if (step.type === 'agent' && !KNOWN_AGENT_ACTIONS.has(step.action)) {
        throw new Error(`步骤 ${step.id} 中存在未知智能动作：${step.action}`)
      }
    }
    const now = nowIso()
    const full: RoutineDefinition = { ...parsed, createdAt: now, updatedAt: now }
    this.deps.store.saveRoutine(full)
    this.deps.activityService.record({
      type: 'routine_started',
      summary: `已创建自定义例程：${parsed.name}`,
      metadata: { routineId: parsed.id, custom: true }
    })
    return full
  }

  /**
   * Delete a custom routine. Preset routines are reserved and cannot be deleted
   * (M5 §14). A routine with an in-flight run is refused (§20: a paused run
   * waiting approval must not be orphaned).
   */
  async deleteRoutine(routineId: string): Promise<void> {
    if (PRESET_IDS.includes(routineId)) {
      throw new Error(`无法删除预设例程：${routineId}`)
    }
    const existing = this.deps.store.getRoutine(routineId)
    if (!existing) return // idempotent
    const inflight = this.deps.store
      .listRuns(routineId)
      .find((r) => r.status === 'running' || r.status === 'waiting_approval')
    if (inflight) {
      throw new Error(`无法删除例程 ${routineId}：存在 ${inflight.status} 状态的运行`)
    }
    this.deps.store.deleteRoutine(routineId)
    this.deps.activityService.record({
      type: 'routine_completed',
      summary: `已删除自定义例程：${existing.name}`,
      metadata: { routineId, deleted: true }
    })
  }

  /**
   * Run a Routine. Idempotent by `idempotencyKey`: a second call with the same
   * key returns the existing run and does NOT re-execute (Spec §12.6).
   */
  async run(routineId: string, opts: RunOptions = {}): Promise<RoutineRun> {
    const routine = this.deps.store.getRoutine(routineId)
    if (!routine) throw new Error(`未找到例程：${routineId}`)
    if (!routine.enabled) throw new Error(`例程已禁用：${routineId}`)

    const idempotencyKey = opts.idempotencyKey ?? this.makeManualKey(routineId)
    const existing = this.deps.store.getRunByIdempotencyKey(idempotencyKey)
    if (existing) {
      // Idempotent no-op: do not re-run, do not duplicate external writes.
      return existing
    }

    const runId = newId('run')
    const startedAt = nowIso()
    const run: RoutineRun = {
      id: runId,
      routineId,
      status: 'pending',
      triggerType: opts.manual ? 'manual' : routine.trigger.type,
      idempotencyKey,
      currentStepId: undefined,
      inputs: { ...routine.inputs, ...(opts.inputs ?? {}) },
      stepOutputs: {},
      startedAt
    }
    this.deps.store.createRun(run)

    this.deps.activityService.record({
      runId,
      type: 'routine_started',
      summary: `例程已启动：${routine.name}`,
      metadata: { routineId, trigger: run.triggerType, idempotencyKey }
    })

    await this.executeFrom(run, routine, 0, undefined)

    const finalRun = this.deps.store.getRun(runId)
    return finalRun ?? run
  }

  /**
   * Resume a paused run from its current step, with an approval context that
   * lets the previously-gated action proceed (Spec §12.5). Verifies the
   * approval is `approved` and that the action's content hash still matches
   * the args captured at preview time — any mismatch refuses execution
   * (Spec §15 content immutability) and fails the run.
   */
  async resume(runId: string, opts: ResumeOptions): Promise<RoutineRun> {
    const run = this.deps.store.getRun(runId)
    if (!run) throw new Error(`未找到运行：${runId}`)
    if (run.status !== 'waiting_approval') throw new Error(`运行未暂停：${run.status}`)
    const routine = this.deps.store.getRoutine(run.routineId)
    if (!routine) throw new Error(`未找到例程：${run.routineId}`)

    const startIndex = routine.steps.findIndex((s) => s.id === run.currentStepId)
    if (startIndex < 0) throw new Error(`无法恢复：找不到当前步骤 ${run.currentStepId}`)

    // Spec §15: verify the approval is approved AND the content is unchanged.
    const approval = this.deps.approvalService.get(opts.approval.requestId)
    if (!approval) throw new Error(`未找到审批：${opts.approval.requestId}`)
    if (approval.routineRunId && approval.routineRunId !== runId) {
      throw new Error(`审批不属于运行 ${runId}`)
    }
    if (approval.status !== 'approved') {
      throw new Error(`审批未获批准：${approval.status}`)
    }
    const step = routine.steps[startIndex]
    // Re-resolve the step's templated args against the run's persisted
    // stepOutputs — the same outputs that produced them at preview time. They
    // are stable across pause/resume (earlier steps don't re-run), so the hash
    // matches unless something genuinely changed (Spec §15).
    const resolvedArgs = this.resolveStepArgs(step, run)
    if (!this.deps.approvalService.verifyContent(approval, resolvedArgs)) {
      this.fail(run, `审批内容自预览后已变更 —— 拒绝执行 ${approval.toolName}`)
      this.deps.activityService.record({
        runId,
        type: 'approval_resolved',
        summary: `审批内容不一致 — 拒绝执行`,
        metadata: { requestId: approval.id, tool: approval.toolName }
      })
      const failed = this.deps.store.getRun(runId)
      return failed ?? run
    }

    this.deps.activityService.record({
      runId,
      type: 'approval_resolved',
      summary: `审批后从步骤「${run.currentStepId}」恢复运行`,
      metadata: { requestId: opts.approval.requestId }
    })

    await this.executeFrom(run, routine, startIndex, opts.approval)

    const finalRun = this.deps.store.getRun(runId)
    return finalRun ?? run
  }

  /**
   * Cancel a paused run — used when the user rejects the approval. The gated
   * action NEVER executes (sends nothing, writes nothing) (Spec §15, §19).
   */
  async cancelPausedRun(runId: string): Promise<RoutineRun> {
    const run = this.deps.store.getRun(runId)
    if (!run) throw new Error(`未找到运行：${runId}`)
    if (run.status !== 'waiting_approval') throw new Error(`运行未暂停：${run.status}`)
    this.deps.store.updateRun(runId, {
      status: 'cancelled',
      completedAt: nowIso(),
      currentStepId: undefined
    })
    this.deps.activityService.record({
      runId,
      type: 'approval_resolved',
      summary: `运行已取消 — 审批被拒绝`,
      metadata: { stepId: run.currentStepId }
    })
    const finalRun = this.deps.store.getRun(runId)
    return finalRun ?? run
  }

  private makeManualKey(routineId: string): string {
    // Unique per call — manual triggers always run fresh.
    return `manual:${routineId}:${newId()}`
  }

  private async executeFrom(
    run: RoutineRun,
    routine: RoutineDefinition,
    startIndex: number,
    approval: { requestId: string } | undefined
  ): Promise<void> {
    this.deps.store.updateRun(run.id, { status: 'running' })
    run.status = 'running'

    const steps = routine.steps
    const ctx = this.buildContext(run, approval)

    for (let i = startIndex; i < steps.length; i++) {
      if (i - startIndex >= ROUTINE_MAX_STEPS) {
        this.fail(run, `Exceeded maximum steps (${ROUTINE_MAX_STEPS})`)
        return
      }
      const step = steps[i]

      // Persist current step before execution (Spec §12.2).
      this.deps.store.updateRun(run.id, { currentStepId: step.id })

      const runStep: RoutineRunStep = {
        id: newId('step'),
        runId: run.id,
        stepId: step.id,
        status: 'running',
        startedAt: nowIso()
      }
      this.deps.store.createRunStep(runStep)

      try {
        const outcome = await this.executeStep(step, run, ctx)
        if (outcome.paused) {
          // Spec §12.4: persist context and pause. Do not advance.
          this.deps.store.updateRunStep(runStep.id, { status: 'waiting_approval' })
          this.deps.store.updateRun(run.id, { status: 'waiting_approval', currentStepId: step.id })
          return
        }
        // On resume, the first (paused) step just executed under approval —
        // flip its ApprovalRequest to executed, then drop the approval context
        // so later steps don't inherit it.
        if (approval && i === startIndex) {
          this.deps.approvalService.markExecuted(approval.requestId)
          ctx.approval = undefined
        }
        this.deps.store.updateRunStep(runStep.id, {
          status: 'completed',
          output: outcome.output,
          completedAt: nowIso()
        })

        // Store output under outputKey (or step.id) for template resolution.
        const key = ('outputKey' in step && step.outputKey) || step.id
        run.stepOutputs[key] = outcome.output
        this.deps.store.updateRun(run.id, { stepOutputs: run.stepOutputs })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.store.updateRunStep(runStep.id, {
          status: 'failed',
          error: message,
          completedAt: nowIso()
        })
        // Spec §12.9: never silently skip failed high-risk steps. A failed step
        // fails the run with a clear error (Spec §12.8).
        this.fail(run, `Step "${step.id}" failed: ${message}`)
        return
      }
    }

    this.deps.store.updateRun(run.id, { status: 'completed', completedAt: nowIso(), currentStepId: undefined })
    this.deps.activityService.record({
      runId: run.id,
      type: 'routine_completed',
      summary: `例程已完成：${routine.name}`,
      metadata: { routineId: routine.id, steps: steps.length }
    })
  }

  /**
   * The template-resolution context for a run: run inputs as the base layer,
   * overlaid by accumulated step outputs. This lets a trigger pass context
   * (e.g. the scheduler hands Meeting Prep the target `targetEventId`) that
   * steps can reference via `{{targetEventId}}`, exactly like step outputs.
   * stepOutputs take precedence over inputs on key collision.
   */
  private ctx(run: RoutineRun): Record<string, unknown> {
    return { ...run.inputs, ...run.stepOutputs }
  }

  private buildContext(run: RoutineRun, approval?: { requestId: string }): ToolContext {
    return {
      runId: run.id,
      routineRunId: run.id,
      emailProviders: this.deps.emailProviders,
      calendarProvider: this.deps.calendarProvider,
      bossProvider: this.deps.bossProvider,
      taskService: this.deps.taskService,
      needToKnowService: this.deps.needToKnowService,
      activityService: this.deps.activityService,
      memoryService: this.deps.memoryService,
      applicationService: this.deps.applicationService,
      settings: this.deps.settings,
      webFetch: this.deps.webFetch,
      notify: this.deps.notify,
      approval
    }
  }

  /**
   * Resolve a step's tool args against the run's accumulated step outputs (for
   * content-hash verification on resume). Must use the same outputs that
   * produced the args at preview time, so templated args (`{{gmailEmails[0].…}}`)
   * hash identically before and after the pause (Spec §15).
   */
  private resolveStepArgs(step: RoutineStep, run: RoutineRun): Record<string, unknown> {
    if (step.type === 'tool') return resolveTemplate(step.args ?? {}, this.ctx(run)) as Record<string, unknown>
    if (step.type === 'approval') return resolveTemplate(step.args, this.ctx(run)) as Record<string, unknown>
    return {}
  }

  /**
   * Create an ApprovalRequest (capturing the content hash of the resolved
   * args), record an `approval_requested` Activity event, and return a paused
   * outcome. Used by both `tool` steps hitting an R2/R3 tool and explicit
   * `approval` steps (Spec §12.4, §15).
   */
  private pauseForApproval(
    run: RoutineRun,
    step: RoutineStep,
    toolName: string,
    result: Extract<ToolResult, { status: 'needs_approval' }>,
    resolvedArgs: Record<string, unknown>
  ): StepOutcome {
    const title = step.type === 'approval' ? step.title : `批准：${toolName}`
    const request = this.deps.approvalService.create({
      routineRunId: run.id,
      toolCallId: result.toolCallId,
      toolName,
      riskLevel: result.risk,
      title,
      preview: result.preview,
      args: resolvedArgs
    })
    this.deps.activityService.record({
      runId: run.id,
      type: 'approval_requested',
      summary: `${toolName} 需要审批（风险等级 ${result.risk}）`,
      metadata: { tool: toolName, toolCallId: result.toolCallId, stepId: step.id, requestId: request.id }
    })
    return { output: undefined, paused: true }
  }

  private async executeStep(step: RoutineStep, run: RoutineRun, ctx: ToolContext): Promise<StepOutcome> {
    switch (step.type) {
      case 'tool':
        return this.execToolStep(step, run, ctx)
      case 'agent':
        return this.execAgentStep(step, run)
      case 'condition':
        return { output: this.execConditionStep(step, run) }
      case 'create_task':
        return { output: this.execCreateTaskStep(step, run) }
      case 'need_to_know':
        return { output: this.execNeedToKnowStep(step, run) }
      case 'approval':
        return this.execApprovalStep(step, run, ctx)
      case 'notify':
        return { output: this.execNotifyStep(step, run, ctx) }
      default:
        throw new Error(`未知步骤类型：${(step as { type: string }).type}`)
    }
  }

  private async execToolStep(step: Extract<RoutineStep, { type: 'tool' }>, run: RoutineRun, ctx: ToolContext): Promise<StepOutcome> {
    const args = resolveTemplate(step.args ?? {}, this.ctx(run))
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_requested',
      summary: `工具：${step.tool}`,
      metadata: { tool: step.tool, stepId: step.id }
    })
    const result: ToolResult = await this.deps.toolRegistry.execute(step.tool, args, ctx)
    if (result.status === 'needs_approval') {
      // Spec §12.4 + §15: create the approval request (hashing the resolved
      // args) and pause — do not execute the action.
      return this.pauseForApproval(run, step, step.tool, result, args as Record<string, unknown>)
    }
    if (result.status === 'error') {
      // Spec M3 partial-failure: a step marked `continueOnError` (e.g. an
      // email.list against a down provider) records a `provider_unavailable`
      // outage, stores `undefined`, and lets the run continue with the other
      // providers. Without the flag, the step fails the run (Spec §12.8/§12.9).
      if (step.continueOnError) {
        this.deps.activityService.record({
          runId: run.id,
          type: 'provider_unavailable',
          summary: `提供方不可用：${step.tool} — ${result.error}`,
          metadata: { tool: step.tool, stepId: step.id, error: result.error }
        })
        return { output: undefined }
      }
      throw new Error(result.error)
    }
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `工具完成：${step.tool}`,
      metadata: { tool: step.tool, stepId: step.id }
    })
    return { output: result.data }
  }

  private async execAgentStep(step: Extract<RoutineStep, { type: 'agent' }>, run: RoutineRun): Promise<StepOutcome> {
    const inputs = resolveTemplate(step.inputs ?? {}, this.ctx(run))
    this.deps.activityService.record({
      runId: run.id,
      type: 'agent_started',
      summary: `智能动作：${step.action}`,
      metadata: { action: step.action, stepId: step.id }
    })
    try {
      const output = await this.deps.agentRuntime.runAgentStep(
        step.action,
        inputs as Record<string, unknown>,
        run.id
      )
      this.deps.activityService.record({
        runId: run.id,
        type: 'agent_completed',
        summary: `智能步骤完成：${step.action}`,
        metadata: { action: step.action, stepId: step.id }
      })
      return { output }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        runId: run.id,
        type: 'agent_failed',
        summary: `智能步骤失败：${step.action} — ${message}`,
        metadata: { action: step.action, stepId: step.id, error: message }
      })
      throw err
    }
  }

  private execConditionStep(step: Extract<RoutineStep, { type: 'condition' }>, run: RoutineRun): unknown {
    const resolved = resolveTemplate(step.expression, this.ctx(run))
    const truthy =
      resolved === 'true' ||
      (resolved !== false &&
        resolved !== 'false' &&
        resolved !== '0' &&
        resolved !== '' &&
        resolved != null &&
        !(Array.isArray(resolved) && resolved.length === 0))
    return { branch: truthy ? step.thenStepId ?? null : step.elseStepId ?? null }
  }

  private execCreateTaskStep(step: Extract<RoutineStep, { type: 'create_task' }>, run: RoutineRun): unknown {
    const title = resolveTemplate(step.title, this.ctx(run))
    const sourceId = step.sourceId ? resolveTemplate(step.sourceId, this.ctx(run)) : undefined
    const task = this.deps.taskService.create({
      title: String(title),
      description: step.description ? String(resolveTemplate(step.description, this.ctx(run))) : undefined,
      priority: step.priority,
      dueAt: step.dueAt,
      sourceType: 'routine',
      sourceId: typeof sourceId === 'string' ? sourceId : undefined,
      routineRunId: run.id
    })
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `已创建任务：${task.title}`,
      metadata: { taskId: task.id, stepId: step.id }
    })
    return task
  }

  private execNeedToKnowStep(step: Extract<RoutineStep, { type: 'need_to_know' }>, run: RoutineRun): unknown {
    if (step.fromKey) {
      const brief = resolveTemplate(`{{${step.fromKey}}}`, this.ctx(run)) as PublishableBrief | undefined
      if (brief) {
        const item = this.deps.needToKnowService.create({
          title: brief.title,
          summary: brief.summary,
          reason: brief.reason,
          priority: brief.priority,
          sourceRefs: brief.sourceRefs,
          suggestedActions: brief.suggestedActions,
          routineRunId: run.id,
          kind: step.kind ?? null
        })
        this.deps.activityService.record({
          runId: run.id,
          type: 'tool_completed',
          summary: `已发布必读：${item.title}`,
          metadata: { needToKnowId: item.id, stepId: step.id }
        })
        return item
      }
    }
    const item = this.deps.needToKnowService.create({
      title: step.title ? String(resolveTemplate(step.title, this.ctx(run))) : 'Untitled',
      summary: step.summary ? String(resolveTemplate(step.summary, this.ctx(run))) : '',
      reason: step.reason ? String(resolveTemplate(step.reason, this.ctx(run))) : '',
      priority: step.priority,
      kind: step.kind ?? null
    })
    return item
  }

  private async execApprovalStep(step: Extract<RoutineStep, { type: 'approval' }>, run: RoutineRun, ctx: ToolContext): Promise<StepOutcome> {
    // Explicit approval step — the action is gated. On first pass (no
    // ctx.approval) the registry returns needs_approval; we create the
    // ApprovalRequest and pause. On resume (ctx.approval set) the gate passes
    // and the action executes; executeFrom then marks the request executed.
    const args = resolveTemplate(step.args, this.ctx(run))
    const result = await this.deps.toolRegistry.execute(step.toolName, args, ctx)
    if (result.status === 'needs_approval') {
      return this.pauseForApproval(run, step, step.toolName, result, args as Record<string, unknown>)
    }
    if (result.status === 'error') throw new Error(result.error)
    return { output: result.status === 'ok' ? result.data : null }
  }

  private execNotifyStep(step: Extract<RoutineStep, { type: 'notify' }>, run: RoutineRun, ctx: ToolContext): unknown {
    const message = step.message ? String(resolveTemplate(step.message, this.ctx(run))) : 'Daymate update'
    if (step.channel === 'desktop_robot') {
      // Prefer the rich path so prefs (per-routine toggle / quiet hours /
      // aggregation) apply; fall back to the plain legacy notify for tests.
      if (this.deps.notifyRich) {
        this.deps.notifyRich({ message, category: 'routine', routineId: run.routineId })
      } else {
        ctx.notify(message)
      }
    }
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `已通知（${step.channel}）：${message}`,
      metadata: { channel: step.channel, stepId: step.id }
    })
    return { notified: true }
  }

  private fail(run: RoutineRun, message: string): void {
    this.deps.store.updateRun(run.id, {
      status: 'failed',
      completedAt: nowIso(),
      currentStepId: undefined,
      error: message
    })
    this.deps.activityService.record({
      runId: run.id,
      type: 'routine_failed',
      summary: `例程失败：${message}`,
      metadata: { routineId: run.routineId, error: message }
    })
  }
}
