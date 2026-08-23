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
  ApplicationEvent,
  ResumeVersion,
  PrepMaterial,
  InterviewNote
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
  /** Hard-delete a task (user-removed ToDo). ADR 0026. */
  deleteTask(id: string): void

  // Need to Know
  createNeedToKnow(item: NeedToKnow): void
  listNeedToKnow(): NeedToKnow[]
  dismissNeedToKnow(id: string): void
  /** Delete every non-dismissed NTK item. Used by the 必读 "清空全部" reset. */
  deleteAllNeedToKnow(): void
  /** Last `days` morning-brief NTKs (kind='morning_brief'), newest first, for
   *  the Home 晨报 carousel. ADR 0026. */
  listMorningBriefs(days: number): NeedToKnow[]
  /** Every NTK including dismissed ones, newest first. ADR 0028 purge — the
   *  mock-calendar "Q3 roadmap" briefs a user dismissed before real providers
   *  connected survive `list()` (excludes dismissed) + `listMorningBriefs()`
   *  (kind filter); this scans the full table so the one-time purge can clear
   *  mock-sourced stragglers. */
  listAllNeedToKnow(): NeedToKnow[]
  /** Delete every non-dismissed NTK item whose title matches exactly.
   * One-time boot migration: clears stale "收件箱已分类" noise after the
   * auto_inbox template dropped its publish step. */
  deleteNeedToKnowByTitle(title: string): void
  /** Hard-delete a single NTK item by id (ignores dismissed state). ADR 0027
   *  purge — clears stale email-origin 必读 items so the re-backfill rebuilds
   *  a clean set (a deleted NTK's sourceRef leaves the dedup `seen` set, so
   *  the fixed classify pass re-evaluates the mail and drops junk). */
  deleteNeedToKnowById(id: string): void
  /** Patch a persisted NTK (ADR 0029 thread-merge: append a new email's
   *  sourceRef, bump headline to latest, touch updatedAt). Only the
   *  thread-merge-relevant fields are honored. */
  updateNeedToKnow(id: string, patch: Partial<NeedToKnow>): void

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
  /** Soft-delete (sets deletedAt); visible in the recycle bin until purged. */
  softDeleteApplication(id: string, deletedAt: string): void
  restoreApplication(id: string): void
  /** Hard delete by id (manual early-delete from recycle bin, or auto-purge). */
  purgeApplication(id: string): void
  listDeletedApplications(): Application[]
  listArchivedApplications(): Application[]
  archiveApplication(id: string, archivedAt: string): void

  createApplicationEvent(event: ApplicationEvent): void
  getApplicationEventBySourceRef(applicationId: string, sourceRef: string): ApplicationEvent | undefined
  listApplicationEvents(applicationId: string): ApplicationEvent[]

  // Resume versions (Milestone A §4.2). Latest version = active.
  createResumeVersion(v: ResumeVersion): void
  listResumeVersions(applicationId: string): ResumeVersion[]
  getLatestResumeVersion(applicationId: string): ResumeVersion | undefined

  // Interview prep materials (Milestone A §4.3).
  createPrepMaterial(m: PrepMaterial): void
  listPrepMaterials(applicationId: string): PrepMaterial[]
  getLatestPrepMaterial(applicationId: string): PrepMaterial | undefined

  // 面经库 (Milestone A §6). Standalone, tagged, searchable.
  createInterviewNote(n: InterviewNote): void
  getInterviewNote(id: string): InterviewNote | undefined
  listInterviewNotes(): InterviewNote[]
  updateInterviewNote(id: string, patch: Partial<InterviewNote>): InterviewNote | undefined
  deleteInterviewNote(id: string): void
}
