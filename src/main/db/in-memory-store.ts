// In-memory implementation of RoutineStore. Pure TypeScript, no native deps.
// Used by unit/integration tests so the engine logic runs under plain vitest
// regardless of the better-sqlite3 ABI build state. See ADR 0002.

import type { RoutineStore } from './store'
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
  ApplicationUpdateFields,
  ApplicationEvent,
  ResumeVersion,
  PrepMaterial,
  InterviewNote
} from '@shared/types'

export class InMemoryStore implements RoutineStore {
  private routines = new Map<string, RoutineDefinition>()
  private runs = new Map<string, RoutineRun>()
  private runSteps = new Map<string, RoutineRunStep>()
  private tasks = new Map<string, Task>()
  private needToKnow = new Map<string, NeedToKnow>()
  private activity: ActivityEvent[] = []
  private approvals = new Map<string, ApprovalRequest>()
  private memory = new Map<string, MemoryItem>()
  private applications = new Map<string, Application>()
  private applicationEvents = new Map<string, ApplicationEvent>()
  private resumeVersions = new Map<string, ResumeVersion>()
  private prepMaterials = new Map<string, PrepMaterial>()
  private interviewNotes = new Map<string, InterviewNote>()

  // ── Routines ──────────────────────────────────────────────────────────────
  listRoutines(): RoutineDefinition[] {
    return [...this.routines.values()]
  }
  getRoutine(id: string): RoutineDefinition | undefined {
    return this.routines.get(id)
  }
  saveRoutine(def: RoutineDefinition): void {
    this.routines.set(def.id, { ...def })
  }
  setRoutineEnabled(id: string, enabled: boolean): RoutineDefinition | undefined {
    const r = this.routines.get(id)
    if (!r) return undefined
    const next = { ...r, enabled, updatedAt: new Date().toISOString() }
    this.routines.set(id, next)
    return next
  }
  deleteRoutine(id: string): void {
    this.routines.delete(id)
  }

  // ── Runs ──────────────────────────────────────────────────────────────────
  createRun(run: RoutineRun): void {
    this.runs.set(run.id, { ...run, stepOutputs: { ...run.stepOutputs } })
  }
  getRun(id: string): RoutineRun | undefined {
    const r = this.runs.get(id)
    return r ? { ...r, stepOutputs: { ...r.stepOutputs } } : undefined
  }
  getRunByIdempotencyKey(key: string): RoutineRun | undefined {
    for (const r of this.runs.values()) {
      if (r.idempotencyKey === key) return this.getRun(r.id)
    }
    return undefined
  }
  listRuns(routineId?: string): RoutineRun[] {
    const all = [...this.runs.values()]
    const filtered = routineId ? all.filter((r) => r.routineId === routineId) : all
    return filtered
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map((r) => ({ ...r, stepOutputs: { ...r.stepOutputs } }))
  }
  updateRun(id: string, patch: Partial<RoutineRun>): RoutineRun | undefined {
    const r = this.runs.get(id)
    if (!r) return undefined
    const next = { ...r, ...patch, stepOutputs: patch.stepOutputs ? { ...patch.stepOutputs } : r.stepOutputs }
    this.runs.set(id, next)
    return this.getRun(id)
  }
  createRunStep(step: RoutineRunStep): void {
    this.runSteps.set(step.id, { ...step })
  }
  updateRunStep(id: string, patch: Partial<RoutineRunStep>): RoutineRunStep | undefined {
    const s = this.runSteps.get(id)
    if (!s) return undefined
    const next = { ...s, ...patch }
    this.runSteps.set(id, next)
    return { ...next }
  }
  getRunStep(runId: string, stepId: string): RoutineRunStep | undefined {
    for (const s of this.runSteps.values()) {
      if (s.runId === runId && s.stepId === stepId) return { ...s }
    }
    return undefined
  }
  listRunSteps(runId: string): RoutineRunStep[] {
    return [...this.runSteps.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => (a.startedAt ?? '') < (b.startedAt ?? '') ? -1 : 1)
      .map((s) => ({ ...s }))
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  createTask(task: Task): void {
    this.tasks.set(task.id, { ...task })
  }
  getTask(id: string): Task | undefined {
    const t = this.tasks.get(id)
    return t ? { ...t } : undefined
  }
  getTaskBySource(sourceType: string, sourceId?: string): Task | undefined {
    for (const t of this.tasks.values()) {
      if (t.sourceType === sourceType && t.sourceId === sourceId) return { ...t }
    }
    return undefined
  }
  listTasks(): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((t) => ({ ...t }))
  }
  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const t = this.tasks.get(id)
    if (!t) return undefined
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() }
    this.tasks.set(id, next)
    return { ...next }
  }
  deleteTask(id: string): void {
    this.tasks.delete(id)
  }

  // ── Need to Know ──────────────────────────────────────────────────────────
  createNeedToKnow(item: NeedToKnow): void {
    this.needToKnow.set(item.id, { ...item })
  }
  listNeedToKnow(): NeedToKnow[] {
    // 必读 excludes morning-brief NTKs (they live on the Home 晨报 carousel).
    return [...this.needToKnow.values()]
      .filter((n) => !n.dismissedAt && n.kind !== 'morning_brief')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((n) => ({ ...n }))
  }
  listMorningBriefs(days: number): NeedToKnow[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    return [...this.needToKnow.values()]
      .filter((n) => n.kind === 'morning_brief' && n.createdAt > cutoff)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((n) => ({ ...n }))
  }
  listAllNeedToKnow(): NeedToKnow[] {
    // ADR 0028 purge — includes dismissed mock-calendar stragglers.
    return [...this.needToKnow.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((n) => ({ ...n }))
  }
  dismissNeedToKnow(id: string): void {
    const n = this.needToKnow.get(id)
    if (n) this.needToKnow.set(id, { ...n, dismissedAt: new Date().toISOString() })
  }
  deleteAllNeedToKnow(): void {
    for (const [id, n] of this.needToKnow) if (!n.dismissedAt) this.needToKnow.delete(id)
  }
  deleteNeedToKnowByTitle(title: string): void {
    for (const [id, n] of this.needToKnow)
      if (!n.dismissedAt && n.title === title) this.needToKnow.delete(id)
  }
  deleteNeedToKnowById(id: string): void {
    this.needToKnow.delete(id)
  }
  updateNeedToKnow(id: string, patch: Partial<NeedToKnow>): void {
    // ADR 0029 — thread-merge: bump headline + append sourceRef + touch updatedAt.
    const n = this.needToKnow.get(id)
    if (!n) return
    this.needToKnow.set(id, {
      ...n,
      ...patch,
      updatedAt: new Date().toISOString()
    })
  }

  // ── Activity ───────────────────────────────────────────────────────────────
  createActivity(event: ActivityEvent): void {
    this.activity.push({ ...event })
  }
  listActivity(runId?: string): ActivityEvent[] {
    const filtered = runId ? this.activity.filter((e) => e.runId === runId) : this.activity
    return [...filtered]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((e) => ({ ...e }))
  }

  // ── Approvals (Spec §8, §15) ────────────────────────────────────────────────
  createApproval(request: ApprovalRequest): void {
    this.approvals.set(request.id, { ...request, preview: { ...request.preview } })
  }
  getApproval(id: string): ApprovalRequest | undefined {
    const a = this.approvals.get(id)
    return a ? { ...a, preview: { ...a.preview } } : undefined
  }
  listApprovals(pendingOnly = false): ApprovalRequest[] {
    const all = [...this.approvals.values()]
    const filtered = pendingOnly ? all.filter((a) => a.status === 'pending') : all
    return filtered
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((a) => ({ ...a, preview: { ...a.preview } }))
  }
  updateApprovalStatus(
    id: string,
    status: ApprovalRequest['status'],
    resolvedAt: string
  ): ApprovalRequest | undefined {
    const a = this.approvals.get(id)
    if (!a) return undefined
    const next = { ...a, status, resolvedAt }
    this.approvals.set(id, next)
    return { ...next, preview: { ...next.preview } }
  }

  // ── Memory (Spec §16) ──────────────────────────────────────────────────────
  createMemory(item: MemoryItem): void {
    this.memory.set(item.id, { ...item })
  }
  getMemory(id: string): MemoryItem | undefined {
    const m = this.memory.get(id)
    return m ? { ...m } : undefined
  }
  listMemory(): MemoryItem[] {
    return [...this.memory.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((m) => ({ ...m }))
  }
  updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem | undefined {
    const m = this.memory.get(id)
    if (!m) return undefined
    const next = { ...m, ...patch, updatedAt: new Date().toISOString() }
    this.memory.set(id, next)
    return { ...next }
  }
  deleteMemory(id: string): void {
    this.memory.delete(id)
  }
  deleteMemoryByKey(key: string): void {
    for (const [id, m] of [...this.memory.entries()]) {
      if (m.key === key) this.memory.delete(id)
    }
  }

  // ── Job applications ──────────────────────────────────────────────────────
  createApplication(app: Application): void {
    this.applications.set(app.id, { ...app })
  }
  getApplication(id: string): Application | undefined {
    const a = this.applications.get(id)
    return a ? { ...a } : undefined
  }
  getApplicationByBossSecurityId(securityId: string): Application | undefined {
    for (const a of this.applications.values()) {
      if (a.bossSecurityId === securityId) return { ...a }
    }
    return undefined
  }
  listApplications(): Application[] {
    return [...this.applications.values()]
      .filter((a) => !a.deletedAt && !a.archivedAt)
      .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1))
      .map((a) => ({ ...a }))
  }
  listDeletedApplications(): Application[] {
    return [...this.applications.values()]
      .filter((a) => a.deletedAt)
      .sort((a, b) => ((a.deletedAt ?? '') < (b.deletedAt ?? '') ? 1 : -1))
      .map((a) => ({ ...a }))
  }
  listArchivedApplications(): Application[] {
    return [...this.applications.values()]
      .filter((a) => a.archivedAt && !a.deletedAt)
      .sort((a, b) => ((a.archivedAt ?? '') < (b.archivedAt ?? '') ? 1 : -1))
      .map((a) => ({ ...a }))
  }
  updateApplication(id: string, patch: Partial<Application> | ApplicationUpdateFields): Application | undefined {
    const a = this.applications.get(id)
    if (!a) return undefined
    const cleanedPatch = { ...patch } as Record<string, unknown>
    for (const [k, v] of Object.entries(cleanedPatch)) {
      if (v === null) cleanedPatch[k] = undefined
    }
    const next = { ...a, ...cleanedPatch, updatedAt: new Date().toISOString() } as Application
    this.applications.set(id, next)
    return { ...next }
  }
  softDeleteApplication(id: string, deletedAt: string): void {
    const a = this.applications.get(id)
    if (!a) return
    this.applications.set(id, { ...a, deletedAt, updatedAt: new Date().toISOString() })
  }
  restoreApplication(id: string): void {
    const a = this.applications.get(id)
    if (!a) return
    const next: Application = { ...a, deletedAt: undefined, updatedAt: new Date().toISOString() }
    this.applications.set(id, next)
  }
  purgeApplication(id: string): void {
    this.applications.delete(id)
    for (const [eid, e] of [...this.applicationEvents.entries()]) {
      if (e.applicationId === id) this.applicationEvents.delete(eid)
    }
    for (const [rid, r] of [...this.resumeVersions.entries()]) {
      if (r.applicationId === id) this.resumeVersions.delete(rid)
    }
    for (const [pid, p] of [...this.prepMaterials.entries()]) {
      if (p.applicationId === id) this.prepMaterials.delete(pid)
    }
  }
  archiveApplication(id: string, archivedAt: string): void {
    const a = this.applications.get(id)
    if (!a) return
    this.applications.set(id, { ...a, archivedAt, updatedAt: new Date().toISOString() })
  }

  createApplicationEvent(event: ApplicationEvent): void {
    this.applicationEvents.set(event.id, { ...event })
  }
  getApplicationEventBySourceRef(applicationId: string, sourceRef: string): ApplicationEvent | undefined {
    for (const e of this.applicationEvents.values()) {
      if (e.applicationId === applicationId && e.sourceRef === sourceRef) return { ...e }
    }
    return undefined
  }
  listApplicationEvents(applicationId: string): ApplicationEvent[] {
    return [...this.applicationEvents.values()]
      .filter((e) => e.applicationId === applicationId)
      .sort((a, b) => (a.eventAt < b.eventAt ? -1 : 1))
      .map((e) => ({ ...e }))
  }
  deleteApplicationEvent(id: string): void {
    this.applicationEvents.delete(id)
  }

  // ── Resume versions (Milestone A) ──────────────────────────────────────────
  createResumeVersion(v: ResumeVersion): void {
    this.resumeVersions.set(v.id, { ...v })
  }
  listResumeVersions(applicationId: string): ResumeVersion[] {
    return [...this.resumeVersions.values()]
      .filter((r) => r.applicationId === applicationId)
      .sort((a, b) => (a.version < b.version ? 1 : -1))
      .map((r) => ({ ...r }))
  }
  getLatestResumeVersion(applicationId: string): ResumeVersion | undefined {
    const list = this.listResumeVersions(applicationId)
    return list[0] ? { ...list[0] } : undefined
  }

  // ── Prep materials (Milestone A) ───────────────────────────────────────────
  createPrepMaterial(m: PrepMaterial): void {
    this.prepMaterials.set(m.id, { ...m })
  }
  listPrepMaterials(applicationId: string): PrepMaterial[] {
    return [...this.prepMaterials.values()]
      .filter((m) => m.applicationId === applicationId)
      .sort((a, b) => (a.version < b.version ? 1 : -1))
      .map((m) => ({ ...m }))
  }
  getLatestPrepMaterial(applicationId: string): PrepMaterial | undefined {
    const list = this.listPrepMaterials(applicationId)
    return list[0] ? { ...list[0] } : undefined
  }

  // ── 面经库 (Milestone A) ───────────────────────────────────────────────────
  createInterviewNote(n: InterviewNote): void {
    this.interviewNotes.set(n.id, { ...n })
  }
  getInterviewNote(id: string): InterviewNote | undefined {
    const n = this.interviewNotes.get(id)
    return n ? { ...n } : undefined
  }
  listInterviewNotes(): InterviewNote[] {
    return [...this.interviewNotes.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((n) => ({ ...n }))
  }
  updateInterviewNote(id: string, patch: Partial<InterviewNote>): InterviewNote | undefined {
    const n = this.interviewNotes.get(id)
    if (!n) return undefined
    const next = { ...n, ...patch, updatedAt: new Date().toISOString() }
    this.interviewNotes.set(id, next)
    return { ...next }
  }
  deleteInterviewNote(id: string): void {
    this.interviewNotes.delete(id)
  }
}
