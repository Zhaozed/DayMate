// SQLite-backed RoutineStore. Uses Drizzle ORM query builder over
// better-sqlite3 (Spec §5 stack). JSON-valued domain fields are stringified on
// write and parsed on read; the Drizzle schema columns are TEXT.
//
// See ADR 0002 for why the engine depends on the RoutineStore interface, not
// this class.

import { eq, desc, and, isNull, isNotNull } from 'drizzle-orm'
import type { RoutineStore } from './store'
import type { AppDb } from './client'
import {
  tasks as tasksTbl,
  routines as routinesTbl,
  routineRuns as runsTbl,
  routineRunSteps as runStepsTbl,
  activityEvents as activityTbl,
  needToKnow as ntkTbl,
  approvalRequests as approvalsTbl,
  memoryItems as memoryTbl,
  applications as applicationsTbl,
  applicationEvents as applicationEventsTbl,
  resumeVersions as resumeVersionsTbl,
  prepMaterials as prepMaterialsTbl,
  interviewNotes as interviewNotesTbl
} from './schema'
import type {
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  Task,
  NeedToKnow,
  ActivityEvent,
  ApprovalRequest,
  MemoryItem,
  Application,
  ApplicationEvent,
  ResumeVersion,
  PrepMaterial,
  InterviewNote
} from '@shared/types'

type TaskRow = typeof tasksTbl.$inferSelect
type RoutineRow = typeof routinesTbl.$inferSelect
type RunRow = typeof runsTbl.$inferSelect
type RunStepRow = typeof runStepsTbl.$inferSelect
type ActivityRow = typeof activityTbl.$inferSelect
type NtkRow = typeof ntkTbl.$inferSelect
type ApprovalRow = typeof approvalsTbl.$inferSelect
type MemoryRow = typeof memoryTbl.$inferSelect
type ApplicationRow = typeof applicationsTbl.$inferSelect
type ApplicationEventRow = typeof applicationEventsTbl.$inferSelect
type ResumeVersionRow = typeof resumeVersionsTbl.$inferSelect
type PrepMaterialRow = typeof prepMaterialsTbl.$inferSelect
type InterviewNoteRow = typeof interviewNotesTbl.$inferSelect

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

function rowToApproval(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    routineRunId: r.routineRunId ?? undefined,
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    riskLevel: r.riskLevel as ApprovalRequest['riskLevel'],
    title: r.title,
    preview: parseJson(r.preview, {}),
    contentHash: r.contentHash,
    status: r.status as ApprovalRequest['status'],
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? undefined
  }
}

function rowToMemory(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    key: r.key as MemoryItem['key'],
    value: r.value,
    source: r.source,
    confirmed: r.confirmed === '1',
    routineRunId: r.routineRunId ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function rowToApplication(r: ApplicationRow): Application {
  return {
    id: r.id,
    company: r.company,
    position: r.position,
    source: r.source as Application['source'],
    bossSecurityId: r.bossSecurityId ?? undefined,
    appliedAt: r.appliedAt,
    channelRef: r.channelRef ?? undefined,
    notes: r.notes ?? undefined,
    city: r.city ?? undefined,
    salaryRange: r.salaryRange ?? undefined,
    jdText: r.jdText ?? undefined,
    stage: r.stage ?? undefined,
    stageDeadline: r.stageDeadline ?? undefined,
    interviewLink: r.interviewLink ?? undefined,
    priority: (r.priority as Application['priority']) ?? 'normal',
    emailRefId: r.emailRefId ?? undefined,
    deletedAt: r.deletedAt ?? undefined,
    archivedAt: r.archivedAt ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function rowToApplicationEvent(r: ApplicationEventRow): ApplicationEvent {
  return {
    id: r.id,
    applicationId: r.applicationId,
    type: r.type as ApplicationEvent['type'],
    round: r.round != null ? Number(r.round) : undefined,
    role: (r.role as ApplicationEvent['role']) ?? undefined,
    subState: (r.subState as ApplicationEvent['subState']) ?? undefined,
    source: r.source as ApplicationEvent['source'],
    sourceRef: r.sourceRef ?? undefined,
    evidence: r.evidence ?? undefined,
    locked: r.locked === '1',
    eventAt: r.eventAt,
    createdAt: r.createdAt
  }
}

function rowToResumeVersion(r: ResumeVersionRow): ResumeVersion {
  return {
    id: r.id,
    applicationId: r.applicationId,
    version: Number(r.version),
    html: r.html,
    modelId: r.modelId ?? undefined,
    promptHash: r.promptHash ?? undefined,
    createdAt: r.createdAt
  }
}

function rowToPrepMaterial(r: PrepMaterialRow): PrepMaterial {
  return {
    id: r.id,
    applicationId: r.applicationId,
    version: Number(r.version),
    html: r.html,
    modelId: r.modelId ?? undefined,
    promptHash: r.promptHash ?? undefined,
    createdAt: r.createdAt
  }
}

function rowToInterviewNote(r: InterviewNoteRow): InterviewNote {
  return {
    id: r.id,
    company: r.company ?? undefined,
    position: r.position ?? undefined,
    applicationId: r.applicationId ?? undefined,
    tags: parseJson(r.tags, [] as string[]) as InterviewNote['tags'],
    content: r.content,
    source: r.source as InterviewNote['source'],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
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
  deleteRoutine(id: string): void {
    this.db.delete(routinesTbl).where(eq(routinesTbl.id, id)).run()
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

  // ── Approvals (Spec §8, §15) ────────────────────────────────────────────────
  createApproval(request: ApprovalRequest): void {
    this.db
      .insert(approvalsTbl)
      .values({
        id: request.id,
        routineRunId: request.routineRunId ?? null,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        riskLevel: request.riskLevel,
        title: request.title,
        preview: JSON.stringify(request.preview),
        contentHash: request.contentHash,
        status: request.status,
        createdAt: request.createdAt,
        resolvedAt: request.resolvedAt ?? null
      })
      .run()
  }
  getApproval(id: string): ApprovalRequest | undefined {
    const r = this.db.select().from(approvalsTbl).where(eq(approvalsTbl.id, id)).get()
    return r ? rowToApproval(r) : undefined
  }
  listApprovals(pendingOnly = false): ApprovalRequest[] {
    const rows = pendingOnly
      ? this.db.select().from(approvalsTbl).where(eq(approvalsTbl.status, 'pending')).orderBy(desc(approvalsTbl.createdAt)).all()
      : this.db.select().from(approvalsTbl).orderBy(desc(approvalsTbl.createdAt)).all()
    return rows.map(rowToApproval)
  }
  updateApprovalStatus(
    id: string,
    status: ApprovalRequest['status'],
    resolvedAt: string
  ): ApprovalRequest | undefined {
    this.db
      .update(approvalsTbl)
      .set({ status, resolvedAt })
      .where(eq(approvalsTbl.id, id))
      .run()
    const r = this.db.select().from(approvalsTbl).where(eq(approvalsTbl.id, id)).get()
    return r ? rowToApproval(r) : undefined
  }

  // ── Memory (Spec §16) ──────────────────────────────────────────────────────
  createMemory(item: MemoryItem): void {
    this.db
      .insert(memoryTbl)
      .values({
        id: item.id,
        key: item.key,
        value: item.value,
        source: item.source,
        confirmed: item.confirmed ? '1' : '0',
        routineRunId: item.routineRunId ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })
      .run()
  }
  getMemory(id: string): MemoryItem | undefined {
    const r = this.db.select().from(memoryTbl).where(eq(memoryTbl.id, id)).get()
    return r ? rowToMemory(r) : undefined
  }
  listMemory(): MemoryItem[] {
    return this.db.select().from(memoryTbl).orderBy(desc(memoryTbl.createdAt)).all().map(rowToMemory)
  }
  updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem | undefined {
    const set: Record<string, unknown> = {}
    if (patch.value !== undefined) set.value = patch.value
    if (patch.confirmed !== undefined) set.confirmed = patch.confirmed ? '1' : '0'
    if (patch.routineRunId !== undefined) set.routineRunId = patch.routineRunId ?? null
    set.updatedAt = new Date().toISOString()
    this.db.update(memoryTbl).set(set).where(eq(memoryTbl.id, id)).run()
    const r = this.db.select().from(memoryTbl).where(eq(memoryTbl.id, id)).get()
    return r ? rowToMemory(r) : undefined
  }
  deleteMemory(id: string): void {
    this.db.delete(memoryTbl).where(eq(memoryTbl.id, id)).run()
  }
  deleteMemoryByKey(key: string): void {
    this.db.delete(memoryTbl).where(eq(memoryTbl.key, key)).run()
  }

  // ── Job applications (boss-cli integration) ────────────────────────────────
  createApplication(app: Application): void {
    this.db
      .insert(applicationsTbl)
      .values({
        id: app.id,
        company: app.company,
        position: app.position,
        source: app.source,
        bossSecurityId: app.bossSecurityId ?? null,
        appliedAt: app.appliedAt,
        channelRef: app.channelRef ?? null,
        notes: app.notes ?? null,
        city: app.city ?? null,
        salaryRange: app.salaryRange ?? null,
        jdText: app.jdText ?? null,
        stage: app.stage ?? null,
        stageDeadline: app.stageDeadline ?? null,
        interviewLink: app.interviewLink ?? null,
        priority: app.priority ?? 'normal',
        emailRefId: app.emailRefId ?? null,
        deletedAt: app.deletedAt ?? null,
        archivedAt: app.archivedAt ?? null,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt
      })
      .onConflictDoUpdate({
        target: applicationsTbl.id,
        set: {
          company: app.company,
          position: app.position,
          source: app.source,
          bossSecurityId: app.bossSecurityId ?? null,
          appliedAt: app.appliedAt,
          channelRef: app.channelRef ?? null,
          notes: app.notes ?? null,
          updatedAt: app.updatedAt
        }
      })
      .run()
  }
  getApplication(id: string): Application | undefined {
    const r = this.db.select().from(applicationsTbl).where(eq(applicationsTbl.id, id)).get()
    return r ? rowToApplication(r) : undefined
  }
  getApplicationByBossSecurityId(securityId: string): Application | undefined {
    const r = this.db
      .select()
      .from(applicationsTbl)
      .where(eq(applicationsTbl.bossSecurityId, securityId))
      .get()
    return r ? rowToApplication(r) : undefined
  }
  listApplications(): Application[] {
    // Active funnel only: exclude soft-deleted (deletedAt) AND archived apps.
    // archivedAt has no value on pre-Milestone-A rows, so the filter is a no-op
    // for existing dev data. (Spec §A: listApplications default = both NULL.)
    return this.db
      .select()
      .from(applicationsTbl)
      .where(and(isNull(applicationsTbl.deletedAt), isNull(applicationsTbl.archivedAt)))
      .orderBy(desc(applicationsTbl.appliedAt))
      .all()
      .map(rowToApplication)
  }
  listDeletedApplications(): Application[] {
    return this.db
      .select()
      .from(applicationsTbl)
      .where(isNotNull(applicationsTbl.deletedAt))
      .orderBy(desc(applicationsTbl.deletedAt))
      .all()
      .map(rowToApplication)
  }
  listArchivedApplications(): Application[] {
    // archived but not soft-deleted (deleted_at takes precedence).
    return this.db
      .select()
      .from(applicationsTbl)
      .where(and(isNotNull(applicationsTbl.archivedAt), isNull(applicationsTbl.deletedAt)))
      .orderBy(desc(applicationsTbl.archivedAt))
      .all()
      .map(rowToApplication)
  }
  updateApplication(id: string, patch: Partial<Application>): Application | undefined {
    const set: Record<string, unknown> = {}
    if (patch.company !== undefined) set.company = patch.company
    if (patch.position !== undefined) set.position = patch.position
    if (patch.source !== undefined) set.source = patch.source
    if (patch.bossSecurityId !== undefined) set.bossSecurityId = patch.bossSecurityId ?? null
    if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt
    if (patch.channelRef !== undefined) set.channelRef = patch.channelRef ?? null
    if (patch.notes !== undefined) set.notes = patch.notes ?? null
    if (patch.city !== undefined) set.city = patch.city ?? null
    if (patch.salaryRange !== undefined) set.salaryRange = patch.salaryRange ?? null
    if (patch.jdText !== undefined) set.jdText = patch.jdText ?? null
    if (patch.stage !== undefined) set.stage = patch.stage ?? null
    if (patch.stageDeadline !== undefined) set.stageDeadline = patch.stageDeadline ?? null
    if (patch.interviewLink !== undefined) set.interviewLink = patch.interviewLink ?? null
    if (patch.priority !== undefined) set.priority = patch.priority
    if (patch.emailRefId !== undefined) set.emailRefId = patch.emailRefId ?? null
    set.updatedAt = new Date().toISOString()
    this.db.update(applicationsTbl).set(set).where(eq(applicationsTbl.id, id)).run()
    return this.getApplication(id)
  }
  softDeleteApplication(id: string, deletedAt: string): void {
    this.db
      .update(applicationsTbl)
      .set({ deletedAt, updatedAt: new Date().toISOString() })
      .where(eq(applicationsTbl.id, id))
      .run()
  }
  restoreApplication(id: string): void {
    this.db
      .update(applicationsTbl)
      .set({ deletedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(applicationsTbl.id, id))
      .run()
  }
  purgeApplication(id: string): void {
    this.db.delete(applicationsTbl).where(eq(applicationsTbl.id, id)).run()
    this.db.delete(applicationEventsTbl).where(eq(applicationEventsTbl.applicationId, id)).run()
    this.db.delete(resumeVersionsTbl).where(eq(resumeVersionsTbl.applicationId, id)).run()
    this.db.delete(prepMaterialsTbl).where(eq(prepMaterialsTbl.applicationId, id)).run()
  }
  archiveApplication(id: string, archivedAt: string): void {
    this.db
      .update(applicationsTbl)
      .set({ archivedAt, updatedAt: new Date().toISOString() })
      .where(eq(applicationsTbl.id, id))
      .run()
  }

  createApplicationEvent(event: ApplicationEvent): void {
    this.db
      .insert(applicationEventsTbl)
      .values({
        id: event.id,
        applicationId: event.applicationId,
        type: event.type,
        round: event.round != null ? String(event.round) : null,
        role: event.role ?? null,
        subState: event.subState ?? null,
        source: event.source,
        sourceRef: event.sourceRef ?? null,
        evidence: event.evidence ?? null,
        locked: event.locked ? '1' : '0',
        eventAt: event.eventAt,
        createdAt: event.createdAt
      })
      .run()
  }
  getApplicationEventBySourceRef(applicationId: string, sourceRef: string): ApplicationEvent | undefined {
    const r = this.db
      .select()
      .from(applicationEventsTbl)
      .where(
        and(
          eq(applicationEventsTbl.applicationId, applicationId),
          eq(applicationEventsTbl.sourceRef, sourceRef)
        )
      )
      .get()
    return r ? rowToApplicationEvent(r) : undefined
  }
  listApplicationEvents(applicationId: string): ApplicationEvent[] {
    return this.db
      .select()
      .from(applicationEventsTbl)
      .where(eq(applicationEventsTbl.applicationId, applicationId))
      .orderBy(applicationEventsTbl.eventAt)
      .all()
      .map(rowToApplicationEvent)
  }

  // ── Resume versions (Milestone A) ──────────────────────────────────────────
  createResumeVersion(v: ResumeVersion): void {
    this.db
      .insert(resumeVersionsTbl)
      .values({
        id: v.id,
        applicationId: v.applicationId,
        version: String(v.version),
        html: v.html,
        modelId: v.modelId ?? null,
        promptHash: v.promptHash ?? null,
        createdAt: v.createdAt
      })
      .run()
  }
  listResumeVersions(applicationId: string): ResumeVersion[] {
    return this.db
      .select()
      .from(resumeVersionsTbl)
      .where(eq(resumeVersionsTbl.applicationId, applicationId))
      .orderBy(desc(resumeVersionsTbl.version))
      .all()
      .map(rowToResumeVersion)
  }
  getLatestResumeVersion(applicationId: string): ResumeVersion | undefined {
    const r = this.db
      .select()
      .from(resumeVersionsTbl)
      .where(eq(resumeVersionsTbl.applicationId, applicationId))
      .orderBy(desc(resumeVersionsTbl.version))
      .limit(1)
      .get()
    return r ? rowToResumeVersion(r) : undefined
  }

  // ── Prep materials (Milestone A) ───────────────────────────────────────────
  createPrepMaterial(m: PrepMaterial): void {
    this.db
      .insert(prepMaterialsTbl)
      .values({
        id: m.id,
        applicationId: m.applicationId,
        version: String(m.version),
        html: m.html,
        modelId: m.modelId ?? null,
        promptHash: m.promptHash ?? null,
        createdAt: m.createdAt
      })
      .run()
  }
  listPrepMaterials(applicationId: string): PrepMaterial[] {
    return this.db
      .select()
      .from(prepMaterialsTbl)
      .where(eq(prepMaterialsTbl.applicationId, applicationId))
      .orderBy(desc(prepMaterialsTbl.version))
      .all()
      .map(rowToPrepMaterial)
  }
  getLatestPrepMaterial(applicationId: string): PrepMaterial | undefined {
    const r = this.db
      .select()
      .from(prepMaterialsTbl)
      .where(eq(prepMaterialsTbl.applicationId, applicationId))
      .orderBy(desc(prepMaterialsTbl.version))
      .limit(1)
      .get()
    return r ? rowToPrepMaterial(r) : undefined
  }

  // ── 面经库 (Milestone A) ───────────────────────────────────────────────────
  createInterviewNote(n: InterviewNote): void {
    this.db
      .insert(interviewNotesTbl)
      .values({
        id: n.id,
        company: n.company ?? null,
        position: n.position ?? null,
        applicationId: n.applicationId ?? null,
        tags: JSON.stringify(n.tags),
        content: n.content,
        source: n.source,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
      })
      .run()
  }
  getInterviewNote(id: string): InterviewNote | undefined {
    const r = this.db
      .select()
      .from(interviewNotesTbl)
      .where(eq(interviewNotesTbl.id, id))
      .get()
    return r ? rowToInterviewNote(r) : undefined
  }
  listInterviewNotes(): InterviewNote[] {
    return this.db
      .select()
      .from(interviewNotesTbl)
      .orderBy(desc(interviewNotesTbl.updatedAt))
      .all()
      .map(rowToInterviewNote)
  }
  updateInterviewNote(id: string, patch: Partial<InterviewNote>): InterviewNote | undefined {
    const set: Record<string, unknown> = {}
    if (patch.company !== undefined) set.company = patch.company ?? null
    if (patch.position !== undefined) set.position = patch.position ?? null
    if (patch.applicationId !== undefined) set.applicationId = patch.applicationId ?? null
    if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags)
    if (patch.content !== undefined) set.content = patch.content
    if (patch.source !== undefined) set.source = patch.source
    set.updatedAt = new Date().toISOString()
    this.db.update(interviewNotesTbl).set(set).where(eq(interviewNotesTbl.id, id)).run()
    return this.getInterviewNote(id)
  }
  deleteInterviewNote(id: string): void {
    this.db.delete(interviewNotesTbl).where(eq(interviewNotesTbl.id, id)).run()
  }
}
