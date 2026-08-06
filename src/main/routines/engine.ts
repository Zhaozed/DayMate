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
import type { EmailProvider } from '../providers/email/email-provider'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type {
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  RoutineStep
} from '@shared/types'
import type { MorningBriefOutput } from '../agent/agent-runtime'
import { runAgentStep } from '../agent/agent-runtime'
import { resolveTemplate } from './template'
import { newId, nowIso } from '../util/ids'
import { ROUTINE_MAX_STEPS } from '@shared/constants'

export interface RunOptions {
  manual?: boolean
  /** Explicit idempotency key — when set, a second run with the same key is a no-op. */
  idempotencyKey?: string
  inputs?: Record<string, unknown>
}

export interface ResumeOptions {
  /** Present only when resuming an approved action (M2 wires the approval UI). */
  approval?: { requestId: string }
}

export interface EngineDeps {
  store: RoutineStore
  toolRegistry: ToolRegistry
  activityService: ActivityService
  taskService: TaskService
  needToKnowService: NeedToKnowService
  emailProvider: EmailProvider
  calendarProvider: CalendarProvider
  /** Shared in-process memory (M1 stub; real Memory Service in M5). */
  memory: Map<string, string>
  /** Push a notification to the robot surface. */
  notify: (message: string) => void
}

interface StepOutcome {
  output: unknown
  /** Set when the step paused waiting for approval (Spec §12.4). */
  paused?: boolean
}

export class RoutineEngine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Run a Routine. Idempotent by `idempotencyKey`: a second call with the same
   * key returns the existing run and does NOT re-execute (Spec §12.6).
   */
  async run(routineId: string, opts: RunOptions = {}): Promise<RoutineRun> {
    const routine = this.deps.store.getRoutine(routineId)
    if (!routine) throw new Error(`Routine not found: ${routineId}`)
    if (!routine.enabled) throw new Error(`Routine is disabled: ${routineId}`)

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
      summary: `Routine started: ${routine.name}`,
      metadata: { routineId, trigger: run.triggerType, idempotencyKey }
    })

    await this.executeFrom(run, routine, 0, undefined)

    const finalRun = this.deps.store.getRun(runId)
    return finalRun ?? run
  }

  /**
   * Resume a paused run from its current step, with an approval context that
   * lets the previously-gated action proceed (Spec §12.5).
   */
  async resume(runId: string, opts: ResumeOptions = {}): Promise<RoutineRun> {
    const run = this.deps.store.getRun(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    if (run.status !== 'waiting_approval') throw new Error(`Run is not paused: ${run.status}`)
    const routine = this.deps.store.getRoutine(run.routineId)
    if (!routine) throw new Error(`Routine not found: ${run.routineId}`)

    const startIndex = routine.steps.findIndex((s) => s.id === run.currentStepId)
    if (startIndex < 0) throw new Error(`Cannot resume: current step ${run.currentStepId} not found`)

    this.deps.activityService.record({
      runId,
      type: 'approval_resolved',
      summary: `Resuming run after approval at step "${run.currentStepId}"`,
      metadata: { requestId: opts.approval?.requestId }
    })

    await this.executeFrom(run, routine, startIndex, opts.approval)

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
      summary: `Routine completed: ${routine.name}`,
      metadata: { routineId: routine.id, steps: steps.length }
    })
  }

  private buildContext(run: RoutineRun, approval?: { requestId: string }): ToolContext {
    return {
      runId: run.id,
      routineRunId: run.id,
      emailProvider: this.deps.emailProvider,
      calendarProvider: this.deps.calendarProvider,
      taskService: this.deps.taskService,
      needToKnowService: this.deps.needToKnowService,
      activityService: this.deps.activityService,
      memory: this.deps.memory,
      notify: this.deps.notify,
      approval
    }
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
        throw new Error(`Unknown step type: ${(step as { type: string }).type}`)
    }
  }

  private async execToolStep(step: Extract<RoutineStep, { type: 'tool' }>, run: RoutineRun, ctx: ToolContext): Promise<StepOutcome> {
    const args = resolveTemplate(step.args ?? {}, run.stepOutputs)
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_requested',
      summary: `Tool: ${step.tool}`,
      metadata: { tool: step.tool, stepId: step.id }
    })
    const result: ToolResult = await this.deps.toolRegistry.execute(step.tool, args, ctx)
    if (result.status === 'needs_approval') {
      // Spec §12.4: persist context and pause — do not execute the action.
      this.deps.activityService.record({
        runId: run.id,
        type: 'approval_requested',
        summary: `Approval required for ${step.tool} (risk ${result.risk})`,
        metadata: { tool: step.tool, toolCallId: result.toolCallId, stepId: step.id }
      })
      return { output: undefined, paused: true }
    }
    if (result.status === 'error') {
      throw new Error(result.error)
    }
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `Tool completed: ${step.tool}`,
      metadata: { tool: step.tool, stepId: step.id }
    })
    return { output: result.data }
  }

  private async execAgentStep(step: Extract<RoutineStep, { type: 'agent' }>, run: RoutineRun): Promise<StepOutcome> {
    const inputs = resolveTemplate(step.inputs ?? {}, run.stepOutputs)
    this.deps.activityService.record({
      runId: run.id,
      type: 'agent_started',
      summary: `Agent action: ${step.action}`,
      metadata: { action: step.action, stepId: step.id }
    })
    const output = await runAgentStep(step.action, inputs as Record<string, unknown>)
    return { output }
  }

  private execConditionStep(step: Extract<RoutineStep, { type: 'condition' }>, run: RoutineRun): unknown {
    const resolved = resolveTemplate(step.expression, run.stepOutputs)
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
    const title = resolveTemplate(step.title, run.stepOutputs)
    const sourceId = step.sourceId ? resolveTemplate(step.sourceId, run.stepOutputs) : undefined
    const task = this.deps.taskService.create({
      title: String(title),
      description: step.description ? String(resolveTemplate(step.description, run.stepOutputs)) : undefined,
      priority: step.priority,
      dueAt: step.dueAt,
      sourceType: 'routine',
      sourceId: typeof sourceId === 'string' ? sourceId : undefined,
      routineRunId: run.id
    })
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `Created task: ${task.title}`,
      metadata: { taskId: task.id, stepId: step.id }
    })
    return task
  }

  private execNeedToKnowStep(step: Extract<RoutineStep, { type: 'need_to_know' }>, run: RoutineRun): unknown {
    if (step.fromKey) {
      const brief = resolveTemplate(`{{${step.fromKey}}}`, run.stepOutputs) as MorningBriefOutput | undefined
      if (brief) {
        const item = this.deps.needToKnowService.create({
          title: brief.title,
          summary: brief.summary,
          reason: brief.reason,
          priority: brief.priority,
          sourceRefs: brief.sourceRefs,
          suggestedActions: brief.suggestedActions,
          routineRunId: run.id
        })
        this.deps.activityService.record({
          runId: run.id,
          type: 'tool_completed',
          summary: `Published Need to Know: ${item.title}`,
          metadata: { needToKnowId: item.id, stepId: step.id }
        })
        return item
      }
    }
    const item = this.deps.needToKnowService.create({
      title: step.title ? String(resolveTemplate(step.title, run.stepOutputs)) : 'Untitled',
      summary: step.summary ? String(resolveTemplate(step.summary, run.stepOutputs)) : '',
      reason: step.reason ? String(resolveTemplate(step.reason, run.stepOutputs)) : '',
      priority: step.priority
    })
    return item
  }

  private async execApprovalStep(step: Extract<RoutineStep, { type: 'approval' }>, run: RoutineRun, ctx: ToolContext): Promise<StepOutcome> {
    // Explicit approval step — the action is gated.
    const args = resolveTemplate(step.args, run.stepOutputs)
    const result = await this.deps.toolRegistry.execute(step.toolName, args, ctx)
    if (result.status === 'needs_approval') {
      this.deps.activityService.record({
        runId: run.id,
        type: 'approval_requested',
        summary: `Approval required for ${step.toolName}`,
        metadata: { tool: step.toolName, toolCallId: result.toolCallId, stepId: step.id }
      })
      return { output: undefined, paused: true }
    }
    if (result.status === 'error') throw new Error(result.error)
    return { output: result.status === 'ok' ? result.data : null }
  }

  private execNotifyStep(step: Extract<RoutineStep, { type: 'notify' }>, run: RoutineRun, ctx: ToolContext): unknown {
    const message = step.message ? String(resolveTemplate(step.message, run.stepOutputs)) : 'Daymate update'
    if (step.channel === 'desktop_robot') {
      ctx.notify(message)
    }
    this.deps.activityService.record({
      runId: run.id,
      type: 'tool_completed',
      summary: `Notified (${step.channel}): ${message}`,
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
      summary: `Routine failed: ${message}`,
      metadata: { routineId: run.routineId, error: message }
    })
  }
}
