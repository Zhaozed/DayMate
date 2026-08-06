// The persistence seam. The Routine Engine and services depend on this
// interface, never on Drizzle or better-sqlite3 directly. This keeps domain
// logic testable in plain Node (InMemoryStore) without loading the native
// addon — sidestepping the node-vs-Electron ABI problem. See ADR 0002.
//
// Production wires SqliteStore (drizzle + better-sqlite3); tests wire
// InMemoryStore. All methods are synchronous because better-sqlite3 is
// synchronous and the engine is single-threaded per run.

import type {
  RoutineDefinition,
  RoutineRun,
  RoutineRunStep,
  Task,
  NeedToKnow,
  ActivityEvent,
  ApprovalRequest
} from '@shared/types'

export interface RoutineStore {
  // Routines
  listRoutines(): RoutineDefinition[]
  getRoutine(id: string): RoutineDefinition | undefined
  saveRoutine(def: RoutineDefinition): void
  setRoutineEnabled(id: string, enabled: boolean): RoutineDefinition | undefined

  // Routine runs
  createRun(run: RoutineRun): void
  getRun(id: string): RoutineRun | undefined
  getRunByIdempotencyKey(key: string): RoutineRun | undefined
  listRuns(routineId?: string): RoutineRun[]
  updateRun(id: string, patch: Partial<RoutineRun>): RoutineRun | undefined
  createRunStep(step: RoutineRunStep): void
  updateRunStep(id: string, patch: Partial<RoutineRunStep>): RoutineRunStep | undefined
  getRunStep(runId: string, stepId: string): RoutineRunStep | undefined
  listRunSteps(runId: string): RoutineRunStep[]

  // Tasks
  createTask(task: Task): void
  getTask(id: string): Task | undefined
  getTaskBySource(sourceType: string, sourceId?: string): Task | undefined
  listTasks(): Task[]
  updateTask(id: string, patch: Partial<Task>): Task | undefined

  // Need to Know
  createNeedToKnow(item: NeedToKnow): void
  listNeedToKnow(): NeedToKnow[]
  dismissNeedToKnow(id: string): void

  // Activity
  createActivity(event: ActivityEvent): void
  listActivity(runId?: string): ActivityEvent[]

  // Approvals (Spec §8, §15)
  createApproval(request: ApprovalRequest): void
  getApproval(id: string): ApprovalRequest | undefined
  listApprovals(pendingOnly?: boolean): ApprovalRequest[]
  updateApprovalStatus(id: string, status: ApprovalRequest['status'], resolvedAt: string): ApprovalRequest | undefined
}
