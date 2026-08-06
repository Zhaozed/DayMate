// SQLite-backed RoutineStore. Uses Drizzle ORM query builder over
// better-sqlite3 (Spec §5 stack). JSON-valued domain fields are stringified on
// write and parsed on read; the Drizzle schema columns are TEXT.
//
// See ADR 0002 for why the engine depends on the RoutineStore interface, not
// this class.

import { eq, desc, and, isNull } from 'drizzle-orm'
import type { RoutineStore } from './store'
import type { AppDb } from './client'
import {
  tasks as tasksTbl,
  routines as routinesTbl,
  routineRuns as runsTbl,
  routineRunSteps as runStepsTbl,
  activityEvents as activityTbl,
  needToKnow as ntkTbl
} from './schema'
import type {
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  Task,
  NeedToKnow,
  ActivityEvent
} from '@shared/types'

type TaskRow = typeof tasksTbl.$inferSelect
type RoutineRow = typeof routinesTbl.$inferSelect
type RunRow = typeof runsTbl.$inferSelect
type RunStepRow = typeof runStepsTbl.$inferSelect
type ActivityRow = typeof activityTbl.$inferSelect
type NtkRow = typeof ntkTbl.$inferSelect

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ── Mappers: row <-> domain object ───────────────────────────────────────────
function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    status: r.status as Task['status'],
    priority: r.priority as Task['priority'],
    dueAt: r.dueAt ?? undefined,
    sourceType: r.sourceType as Task['sourceType'],
    sourceId: r.sourceId ?? undefined,
    routineRunId: r.routineRunId ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function rowToRoutine(r: RoutineRow): RoutineDefinition {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: Number(r.version),
    enabled: r.enabled === '1',
    trigger: parseJson(r.trigger, { type: 'manual' }),
    inputs: parseJson(r.inputs, {}),
    steps: parseJson(r.steps, []),
    approvalPolicy: r.approvalPolicy as RoutineDefinition['approvalPolicy'],
    output: r.output as RoutineDefinition['output'],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function rowToRun(r: RunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routineId,
    status: r.status as RoutineRun['status'],
    triggerType: r.triggerType,
    idempotencyKey: r.idempotencyKey,
    currentStepId: r.currentStepId ?? undefined,
    inputs: parseJson(r.inputs, {}),
    stepOutputs: parseJson(r.stepOutputs, {}),
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? undefined,
    error: r.error ?? undefined
  }
}

function rowToRunStep(r: RunStepRow): RoutineRunStep {
  return {
    id: r.id,
    runId: r.runId,
    stepId: r.stepId,
    status: r.status as RoutineRunStep['status'],
    output: parseJson(r.output, undefined),
    error: r.error ?? undefined,
    startedAt: r.startedAt ?? undefined,
    completedAt: r.completedAt ?? undefined
  }
}

function rowToActivity(r: ActivityRow): ActivityEvent {
  return {
    id: r.id,
    runId: r.runId ?? undefined,
    type: r.type as ActivityEvent['type'],
    summary: r.summary,
    metadata: parseJson(r.metadata, {}),
    createdAt: r.createdAt
  }
}

function rowToNtk(r: NtkRow): NeedToKnow {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    reason: r.reason,
    priority: r.priority as NeedToKnow['priority'],
    sourceRefs: parseJson(r.sourceRefs, []),
    suggestedActions: parseJson(r.suggestedActions, []),
    readAt: r.readAt ?? undefined,
    dismissedAt: r.dismissedAt ?? undefined,
    createdAt: r.createdAt
  }
}

export class SqliteStore implements RoutineStore {
  constructor(private readonly db: AppDb) {}

  // ── Routines ──────────────────────────────────────────────────────────────
  listRoutines(): RoutineDefinition[] {
    return this.db.select().from(routinesTbl).all().map(rowToRoutine)
  }
  getRoutine(id: string): RoutineDefinition | undefined {
    const r = this.db.select().from(routinesTbl).where(eq(routinesTbl.id, id)).get()
    return r ? rowToRoutine(r) : undefined
  }
  saveRoutine(def: RoutineDefinition): void {
    this.db
      .insert(routinesTbl)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        version: String(def.version),
        enabled: def.enabled ? '1' : '0',
        trigger: JSON.stringify(def.trigger),
        inputs: JSON.stringify(def.inputs),
        steps: JSON.stringify(def.steps),
        approvalPolicy: def.approvalPolicy,
        output: def.output,
        createdAt: def.createdAt,
        updatedAt: def.updatedAt
      })
      .onConflictDoUpdate({
        target: routinesTbl.id,
        set: {
          name: def.name,
          description: def.description,
          version: String(def.version),
          enabled: def.enabled ? '1' : '0',
          trigger: JSON.stringify(def.trigger),
          inputs: JSON.stringify(def.inputs),
          steps: JSON.stringify(def.steps),
          approvalPolicy: def.approvalPolicy,
          output: def.output,
          updatedAt: def.updatedAt
        }
      })
      .run()
  }
  setRoutineEnabled(id: string, enabled: boolean): RoutineDefinition | undefined {
    const updatedAt = new Date().toISOString()
    this.db
      .update(routinesTbl)
      .set({ enabled: enabled ? '1' : '0', updatedAt })
      .where(eq(routinesTbl.id, id))
      .run()
    return this.getRoutine(id)
  }

  // ── Runs ──────────────────────────────────────────────────────────────────
  createRun(run: RoutineRun): void {
    this.db
      .insert(runsTbl)
      .values({
        id: run.id,
        routineId: run.routineId,
        status: run.status,
        triggerType: run.triggerType,
        idempotencyKey: run.idempotencyKey,
        currentStepId: run.currentStepId ?? null,
        inputs: JSON.stringify(run.inputs),
        stepOutputs: JSON.stringify(run.stepOutputs),
        startedAt: run.startedAt,
        completedAt: run.completedAt ?? null,
        error: run.error ?? null
      })
      .run()
  }
  getRun(id: string): RoutineRun | undefined {
    const r = this.db.select().from(runsTbl).where(eq(runsTbl.id, id)).get()
    return r ? rowToRun(r) : undefined
  }
  getRunByIdempotencyKey(key: string): RoutineRun | undefined {
    const r = this.db.select().from(runsTbl).where(eq(runsTbl.idempotencyKey, key)).get()
    return r ? rowToRun(r) : undefined
  }
  listRuns(routineId?: string): RoutineRun[] {
    const rows = routineId
      ? this.db.select().from(runsTbl).where(eq(runsTbl.routineId, routineId)).orderBy(desc(runsTbl.startedAt)).all()
      : this.db.select().from(runsTbl).orderBy(desc(runsTbl.startedAt)).all()
    return rows.map(rowToRun)
  }
  updateRun(id: string, patch: Partial<RoutineRun>): RoutineRun | undefined {
    const set: Record<string, unknown> = {}
    if (patch.status) set.status = patch.status
    if (patch.currentStepId !== undefined) set.currentStepId = patch.currentStepId ?? null
    if (patch.inputs) set.inputs = JSON.stringify(patch.inputs)
    if (patch.stepOutputs) set.stepOutputs = JSON.stringify(patch.stepOutputs)
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt ?? null
    if (patch.error !== undefined) set.error = patch.error ?? null
    this.db.update(runsTbl).set(set).where(eq(runsTbl.id, id)).run()
    return this.getRun(id)
  }
  createRunStep(step: RoutineRunStep): void {
    this.db
      .insert(runStepsTbl)
      .values({
        id: step.id,
        runId: step.runId,
        stepId: step.stepId,
        status: step.status,
        output: step.output != null ? JSON.stringify(step.output) : null,
        error: step.error ?? null,
        startedAt: step.startedAt ?? null,
        completedAt: step.completedAt ?? null
      })
      .run()
  }
  updateRunStep(id: string, patch: Partial<RoutineRunStep>): RoutineRunStep | undefined {
    const set: Record<string, unknown> = {}
    if (patch.status) set.status = patch.status
    if (patch.output !== undefined) set.output = patch.output == null ? null : JSON.stringify(patch.output)
    if (patch.error !== undefined) set.error = patch.error ?? null
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt ?? null
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt ?? null
    this.db.update(runStepsTbl).set(set).where(eq(runStepsTbl.id, id)).run()
    const r = this.db.select().from(runStepsTbl).where(eq(runStepsTbl.id, id)).get()
    return r ? rowToRunStep(r) : undefined
  }
  getRunStep(runId: string, stepId: string): RoutineRunStep | undefined {
    const r = this.db
      .select()
      .from(runStepsTbl)
      .where(and(eq(runStepsTbl.runId, runId), eq(runStepsTbl.stepId, stepId)))
      .get()
    return r ? rowToRunStep(r) : undefined
  }
  listRunSteps(runId: string): RoutineRunStep[] {
    return this.db
      .select()
      .from(runStepsTbl)
      .where(eq(runStepsTbl.runId, runId))
      .orderBy(runStepsTbl.startedAt)
      .all()
      .map(rowToRunStep)
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  createTask(task: Task): void {
    this.db
      .insert(tasksTbl)
      .values({
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt ?? null,
        sourceType: task.sourceType,
        sourceId: task.sourceId ?? null,
        routineRunId: task.routineRunId ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      })
      .run()
  }
  getTask(id: string): Task | undefined {
    const r = this.db.select().from(tasksTbl).where(eq(tasksTbl.id, id)).get()
    return r ? rowToTask(r) : undefined
  }
  getTaskBySource(sourceType: string, sourceId?: string): Task | undefined {
    const r = this.db
      .select()
      .from(tasksTbl)
      .where(
        sourceId != null
          ? and(eq(tasksTbl.sourceType, sourceType), eq(tasksTbl.sourceId, sourceId))
          : eq(tasksTbl.sourceType, sourceType)
      )
      .get()
    return r ? rowToTask(r) : undefined
  }
  listTasks(): Task[] {
    return this.db.select().from(tasksTbl).orderBy(desc(tasksTbl.createdAt)).all().map(rowToTask)
  }
  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) set.title = patch.title
    if (patch.description !== undefined) set.description = patch.description ?? null
    if (patch.status) set.status = patch.status
    if (patch.priority) set.priority = patch.priority
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt ?? null
    set.updatedAt = new Date().toISOString()
    this.db.update(tasksTbl).set(set).where(eq(tasksTbl.id, id)).run()
    const r = this.db.select().from(tasksTbl).where(eq(tasksTbl.id, id)).get()
    return r ? rowToTask(r) : undefined
  }

  // ── Need to Know ──────────────────────────────────────────────────────────
  createNeedToKnow(item: NeedToKnow): void {
    this.db
      .insert(ntkTbl)
      .values({
        id: item.id,
        title: item.title,
        summary: item.summary,
        reason: item.reason,
        priority: item.priority,
        sourceRefs: JSON.stringify(item.sourceRefs),
        suggestedActions: JSON.stringify(item.suggestedActions),
        readAt: item.readAt ?? null,
        dismissedAt: item.dismissedAt ?? null,
        createdAt: item.createdAt
      })
      .run()
  }
  dismissNeedToKnow(id: string): void {
    this.db.update(ntkTbl).set({ dismissedAt: new Date().toISOString() }).where(eq(ntkTbl.id, id)).run()
  }
  listNeedToKnow(): NeedToKnow[] {
    return this.db
      .select()
      .from(ntkTbl)
      .where(isNull(ntkTbl.dismissedAt))
      .orderBy(desc(ntkTbl.createdAt))
      .all()
      .map(rowToNtk)
  }

  // ── Activity ───────────────────────────────────────────────────────────────
  createActivity(event: ActivityEvent): void {
    this.db
      .insert(activityTbl)
      .values({
        id: event.id,
        runId: event.runId ?? null,
        type: event.type,
        summary: event.summary,
        metadata: JSON.stringify(event.metadata),
        createdAt: event.createdAt
      })
      .run()
  }
  listActivity(runId?: string): ActivityEvent[] {
    const rows = runId
      ? this.db.select().from(activityTbl).where(eq(activityTbl.runId, runId)).orderBy(desc(activityTbl.createdAt)).all()
      : this.db.select().from(activityTbl).orderBy(desc(activityTbl.createdAt)).all()
    return rows.map(rowToActivity)
  }
}
