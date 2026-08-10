// Approval Service — the gate in front of every external write (Spec §8, §11,
// §15). R2/R3 actions do not execute until the user approves. The service owns
// the ApprovalRequest lifecycle: create → (approve | reject | expire) →
// markExecuted, plus the content-immutability check.
//
// Content immutability (§15): the SHA-256 of canonical JSON of the action's
// args is captured at preview time and stored as `contentHash`. Before the
// action executes, the engine recomputes the hash from the resolved args and
// asks `verifyContent`; any mismatch refuses the action ("content changed
// since preview → request a new approval").

import type { RoutineStore } from '../db/store'
import type { ApprovalRequest } from '@shared/types'
import { APPROVAL_TTL_HOURS } from '@shared/constants'
import { contentHashOf } from '../util/hash'
import { newId, nowIso } from '../util/ids'

export interface CreateApprovalInput {
  routineRunId?: string
  toolCallId: string
  toolName: string
  riskLevel: ApprovalRequest['riskLevel']
  title: string
  // Human-facing display surfaced in the Approval Center (recipients/subject/
  // body, source). Redacted by ActivityService before logging.
  preview: Record<string, unknown>
  // The args the tool will actually execute. Hashed for immutability. Kept out
  // of `preview` so the display layer never needs to reason about it.
  args: Record<string, unknown>
}

/** An approval is stale (and must not be executed) past its TTL. (Spec §20) */
export function isApprovalStale(request: ApprovalRequest, now = nowIso()): boolean {
  const ageMs = Date.parse(now) - Date.parse(request.createdAt)
  return Number.isNaN(ageMs) ? false : ageMs > APPROVAL_TTL_HOURS * 60 * 60 * 1000
}

export class ApprovalService {
  constructor(private readonly store: RoutineStore) {}

  /** Create a pending ApprovalRequest, capturing the content hash of `args`. */
  create(input: CreateApprovalInput): ApprovalRequest {
    const request: ApprovalRequest = {
      id: newId('appr'),
      routineRunId: input.routineRunId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      riskLevel: input.riskLevel,
      title: input.title,
      preview: input.preview,
      contentHash: contentHashOf(input.args),
      status: 'pending',
      createdAt: nowIso()
    }
    this.store.createApproval(request)
    return request
  }

  list(pendingOnly = false): ApprovalRequest[] {
    return this.store.listApprovals(pendingOnly)
  }

  get(id: string): ApprovalRequest | undefined {
    return this.store.getApproval(id)
  }

  /**
   * Mark a pending request approved. Throws if the request is missing, already
   * resolved, or stale (past TTL). Returns the updated request.
   */
  approve(id: string): ApprovalRequest {
    const existing = this.store.getApproval(id)
    if (!existing) throw new Error(`未找到审批：${id}`)
    if (existing.status !== 'pending') {
      throw new Error(`审批已处理：${existing.status}`)
    }
    if (isApprovalStale(existing)) {
      this.store.updateApprovalStatus(id, 'expired', nowIso())
      throw new Error(`审批已过期（超过有效期）：${id}`)
    }
    const updated = this.store.updateApprovalStatus(id, 'approved', nowIso())
    if (!updated) throw new Error(`审批批准失败：${id}`)
    return updated
  }

  /** Mark a pending request rejected. The action never executes. */
  reject(id: string): ApprovalRequest {
    const existing = this.store.getApproval(id)
    if (!existing) throw new Error(`未找到审批：${id}`)
    if (existing.status !== 'pending') {
      throw new Error(`审批已处理：${existing.status}`)
    }
    const updated = this.store.updateApprovalStatus(id, 'rejected', nowIso())
    if (!updated) throw new Error(`审批拒绝失败：${id}`)
    return updated
  }

  /** Flip an approved request to executed after the action runs. */
  markExecuted(id: string): ApprovalRequest {
    const existing = this.store.getApproval(id)
    if (!existing) throw new Error(`未找到审批：${id}`)
    if (existing.status !== 'approved') {
      throw new Error(`无法从状态 ${existing.status} 标记为已执行`)
    }
    const updated = this.store.updateApprovalStatus(id, 'executed', nowIso())
    if (!updated) throw new Error(`审批标记执行失败：${id}`)
    return updated
  }

  /**
   * Recompute the content hash of the args about to be executed and compare to
   * the hash captured at preview time. Mismatch → the action's content changed
   * since approval and must NOT execute (Spec §15).
   */
  verifyContent(request: ApprovalRequest, args: unknown): boolean {
    return contentHashOf(args) === request.contentHash
  }
}
