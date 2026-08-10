import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ApprovalService, isApprovalStale } from '../../src/main/services/approval-service'
import { contentHashOf } from '../../src/main/util/hash'

function makeService() {
  return new ApprovalService(new InMemoryStore())
}

const baseInput = {
  toolCallId: 'call-1',
  toolName: 'email.send_draft',
  riskLevel: 'R3' as const,
  title: 'Send draft',
  preview: { accountId: 'mock-gmail-001', draftId: 'draft-1' },
  args: { accountId: 'mock-gmail-001', draftId: 'draft-1' }
}

describe('approval service', () => {
  it('creates a pending request and hashes the args', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    expect(req.status).toBe('pending')
    expect(req.contentHash).toBe(contentHashOf(baseInput.args))
    expect(req.toolCallId).toBe('call-1')
  })

  it('approves a pending request', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    const approved = svc.approve(req.id)
    expect(approved.status).toBe('approved')
    expect(approved.resolvedAt).toBeTruthy()
  })

  it('rejects a pending request and never executes', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    const rejected = svc.reject(req.id)
    expect(rejected.status).toBe('rejected')
  })

  it('throws when approving an already-resolved request', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    svc.approve(req.id)
    expect(() => svc.approve(req.id)).toThrow(/已处理/)
  })

  it('markExecuted flips an approved request to executed', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    svc.approve(req.id)
    const executed = svc.markExecuted(req.id)
    expect(executed.status).toBe('executed')
  })

  it('verifyContent passes for unchanged args and fails on tamper', () => {
    const svc = makeService()
    const req = svc.create(baseInput)
    expect(svc.verifyContent(req, baseInput.args)).toBe(true)
    // Tamper the draftId after preview — content changed, must refuse.
    expect(svc.verifyContent(req, { accountId: 'mock-gmail-001', draftId: 'draft-TAMPERED' })).toBe(false)
  })

  it('verifyContent is order-independent (canonical JSON)', () => {
    const svc = makeService()
    const req = svc.create({ ...baseInput, args: { a: 1, b: 2 } })
    expect(svc.verifyContent(req, { b: 2, a: 1 })).toBe(true)
  })

  it('isApprovalStale is true past the TTL', () => {
    const old = {
      id: 'appr-old',
      toolCallId: 'c',
      toolName: 'email.send_draft',
      riskLevel: 'R3' as const,
      title: 'old',
      preview: {},
      contentHash: 'x',
      status: 'pending' as const,
      createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() // 25h > 24h TTL
    }
    expect(isApprovalStale(old)).toBe(true)
  })

  it('approving a stale request expires it instead', () => {
    const store = new InMemoryStore()
    const svc = new ApprovalService(store)
    const req = svc.create(baseInput)
    // Backdate the stored record by re-inserting it with an old createdAt.
    store.createApproval({ ...req, createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() })
    expect(() => svc.approve(req.id)).toThrow(/已过期/)
    expect(svc.get(req.id)?.status).toBe('expired')
  })
})
