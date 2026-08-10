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
  ApprovalRequest,
  MemoryItem,
  Application,
  ApplicationEvent
} from '@shared/types'

export interface RoutineStore {
  // Routines
  listRoutines(): RoutineDefinition[]
  getRoutine(id: string): RoutineDefinition | undefined
  saveRoutine(def: RoutineDefinition): void
  setRoutineEnabled(id: string, enabled: boolean): RoutineDefinition | undefined
  deleteRoutine(id: string): void

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

  // Memory (Spec §16)
  createMemory(item: MemoryItem): void
  getMemory(id: string): MemoryItem | undefined
  listMemory(): MemoryItem[]
  updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem | undefined
  deleteMemory(id: string): void
  /** Delete every memory item for a key (used when confirming a revision). */
  deleteMemoryByKey(key: string): void

  // Job applications (boss-cli integration) — the cross-channel funnel.
  // Applications are upserted by `bossSecurityId` on boss sync; manual entries
  // have no securityId. Events are idempotent by `sourceRef` (emailId/bossChatId).
  createApplication(app: Application): void
  getApplication(id: string): Application | undefined
  getApplicationByBossSecurityId(securityId: string): Application | undefined
  listApplications(): Application[]
  updateApplication(id: string, patch: Partial<Application>): Application | undefined

  createApplicationEvent(event: ApplicationEvent): void
  getApplicationEventBySourceRef(applicationId: string, sourceRef: string): ApplicationEvent | undefined
  listApplicationEvents(applicationId: string): ApplicationEvent[]
}
