import { useEffect } from 'react'
import type { ReactElement } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import { APPROVAL_STATUS_LABEL, statusLabel } from '../labels'

// Approval Center (Spec §18). Pending requests first, with full preview
// (recipients / subject / body / source). Approve → the gated action runs;
// Reject → the run is cancelled and nothing is sent (Spec §15). Expired
// requests are disabled; executed ones show their result.
export function ApprovalsPage(): ReactElement {
  const { data: approvals, loading, error, setData, refetch } = useAsync<ApprovalRequest[]>(
    () => window.daymate.listApprovals()
  )

  // Live push: main re-sends the full list whenever an approval changes.
  useEffect(() => {
    return window.daymate.onApprovalChanged((next) => setData(next))
  }, [setData])

  const approve = async (id: string): Promise<void> => {
    try {
      await window.daymate.approveRequest(id)
    } catch (err) {
      console.error(err)
    }
    refetch()
  }

  const reject = async (id: string): Promise<void> => {
    try {
      await window.daymate.rejectRequest(id)
    } catch (err) {
      console.error(err)
    }
    refetch()
  }

  if (loading) return <Loading label="正在加载审批…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = approvals ?? []
  const pending = list.filter((a) => a.status === 'pending')
  const resolved = list.filter((a) => a.status !== 'pending')

  return (
    <div>
      <h1 className="text-xl font-semibold text-white">审批</h1>
      <p className="mt-1 text-sm text-white/45">
        每个外部写入都需要你确认。在你批准之前，什么都不会发出。
      </p>

      {pending.length === 0 ? (
        <EmptyState title="无待审批" hint="外部写入会在此暂停，等你确认。" />
      ) : (
        <div className="mt-6 space-y-3">
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} onApprove={approve} onReject={reject} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">已处理</h2>
          <div className="space-y-2">
            {resolved.slice(0, 20).map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-lg border border-white/5 p-3"
                style={{ background: 'var(--dm-panel)' }}
              >
                <span className="text-xs text-white/50">{a.toolName}</span>
                <span className="flex-1 truncate text-sm text-white/70">{a.title}</span>
                <span className={`text-xs ${statusColor(a.status)}`}>
                  {statusLabel(APPROVAL_STATUS_LABEL, a.status)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ApprovalCard({
  approval,
  onApprove,
  onReject
}: {
  approval: ApprovalRequest
  onApprove: (id: string) => void
  onReject: (id: string) => void
}): ReactElement {
  const p = approval.preview as Record<string, unknown>
  const to = Array.isArray(p.to) ? (p.to as Array<{ name?: string; address: string }>) : []
  const subject = typeof p.subject === 'string' ? p.subject : ''
  const body = typeof p.body === 'string' ? p.body : ''
  const draftId = typeof p.draftId === 'string' ? p.draftId : undefined

  return (
    <div className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-xs text-amber-200">{approval.riskLevel}</span>
        <span className="text-xs text-white/50">{approval.toolName}</span>
      </div>
      <h3 className="mt-2 text-sm font-semibold text-white/90">{approval.title}</h3>

      <div className="mt-3 space-y-1 text-sm text-white/70">
        {to.length > 0 && (
          <div>
            <span className="text-white/40">收件人：</span>
            {to.map((r) => r.name ?? r.address).join(', ')}
          </div>
        )}
        {subject && (
          <div>
            <span className="text-white/40">主题：</span>
            {subject}
          </div>
        )}
        {draftId && (
          <div className="text-xs text-white/35">草稿：{draftId}</div>
        )}
        {body && (
          <pre className="mt-2 whitespace-pre-wrap rounded bg-black/20 p-2 text-xs text-white/60">{body}</pre>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onApprove(approval.id)}
          className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
        >
          批准并发送
        </button>
        <button
          onClick={() => onReject(approval.id)}
          className="rounded bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

function statusColor(status: ApprovalRequest['status']): string {
  switch (status) {
    case 'approved':
    case 'executed':
      return 'text-emerald-400'
    case 'rejected':
      return 'text-rose-400'
    case 'expired':
      return 'text-amber-400'
    default:
      return 'text-white/40'
  }
}
