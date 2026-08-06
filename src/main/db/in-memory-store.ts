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
  ActivityEvent
} from '@shared/types'

export class InMemoryStore implements RoutineStore {
  private routines = new Map<string, RoutineDefinition>()
  private runs = new Map<string, RoutineRun>()
  private runSteps = new Map<string, RoutineRunStep>()
  private tasks = new Map<string, Task>()
  private needToKnow = new Map<string, NeedToKnow>()
  private activity: ActivityEvent[] = []

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

  // ── Need to Know ──────────────────────────────────────────────────────────
  createNeedToKnow(item: NeedToKnow): void {
    this.needToKnow.set(item.id, { ...item })
  }
  listNeedToKnow(): NeedToKnow[] {
    return [...this.needToKnow.values()]
      .filter((n) => !n.dismissedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((n) => ({ ...n }))
  }
  dismissNeedToKnow(id: string): void {
    const n = this.needToKnow.get(id)
    if (n) this.needToKnow.set(id, { ...n, dismissedAt: new Date().toISOString() })
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
}
