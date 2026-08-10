// Task Service — the follow-through center (Spec §8, §3).
// CRUD with two invariant protections required by the spec:
//
//  1. Idempotent create by source — creating a Task with the same
//     (sourceType, sourceId) twice returns the existing Task. This is the
//     foundation for the M2 duplicate-send protection (Spec §19 release gate:
//     "no duplicate email sending in retry test") applied to Tasks now.
//
//  2. Valid status transitions — only allowed transitions are accepted so a
//     done task cannot silently reopen, etc.

import type { RoutineStore } from '../db/store'
import type { Task, TaskCreateInput, TaskStatus, TaskUpdate } from '@shared/types'
import { newId, nowIso } from '../util/ids'

// Directed transition graph. (Spec §8 statuses.)
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  need_to_know: ['need_approval', 'todo', 'done', 'dismissed'],
  need_approval: ['todo', 'done', 'dismissed'],
  todo: ['waiting', 'done', 'dismissed'],
  waiting: ['todo', 'done', 'dismissed'],
  done: ['todo', 'dismissed'],
  dismissed: ['todo']
}

export function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export class TaskService {
  constructor(private readonly store: RoutineStore) {}

  /** Create a Task, deduplicating by (sourceType, sourceId) when sourceId is set. */
  create(input: TaskCreateInput): Task {
    if (input.sourceId) {
      const existing = this.store.getTaskBySource(input.sourceType, input.sourceId)
      if (existing) return existing
    }
    const now = nowIso()
    const task: Task = {
      id: newId('task'),
      title: input.title,
      description: input.description,
      status: 'todo',
      priority: input.priority ?? 'medium',
      dueAt: input.dueAt,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      routineRunId: input.routineRunId,
      createdAt: now,
      updatedAt: now
    }
    this.store.createTask(task)
    return task
  }

  list(): Task[] {
    return this.store.listTasks()
  }

  get(id: string): Task | undefined {
    return this.store.getTask(id)
  }

  update(id: string, patch: TaskUpdate): Task {
    const existing = this.store.getTask(id)
    if (!existing) throw new Error(`未找到任务：${id}`)
    if (patch.status && !isAllowedTransition(existing.status, patch.status)) {
      throw new Error(`无效的任务状态转换：${existing.status} -> ${patch.status}`)
    }
    const updated = this.store.updateTask(id, patch)
    if (!updated) throw new Error(`任务更新失败：${id}`)
    return updated
  }

  complete(id: string): Task {
    return this.update(id, { status: 'done' })
  }
}
