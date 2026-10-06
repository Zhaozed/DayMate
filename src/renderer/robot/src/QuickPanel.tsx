import type { ReactElement } from 'react'
import type { RobotState, NeedToKnow } from '@shared/types'

// Quick panel (M4 §18). The ambient robot's click surface: current state, the
// latest Need-to-Know summary, pending approvals (with a Review deep-link), and
// quick actions (Run Morning Brief, Open Workbench). No free-text agent chat —
// the full conversational Assistant is M5.

const STATE_LABEL: Record<RobotState, string> = {
  idle: '空闲',
  observing: '观察中',
  thinking: '思考中',
  working: '工作中',
  need_approval: '待审批',
  done: '完成',
  error: '错误'
}

const STATE_COLOR: Record<RobotState, string> = {
  idle: '#8a8f98',
  observing: '#ff8a3b',
  thinking: '#ffb020',
  working: '#7ed321',
  need_approval: '#ff3b3b',
  done: '#3bd671',
  error: '#ff3b3b'
}

export interface QuickPanelProps {
  state: RobotState
  latestNtk: NeedToKnow | null
  pendingApprovalCount: number
  onReview: () => void
  onOpenWorkbench: () => void
  onClose: () => void
}

export function QuickPanel({
  state,
  latestNtk,
  pendingApprovalCount,
  onReview,
  onOpenWorkbench,
  onClose
}: QuickPanelProps): ReactElement {
  return (
    <div
      className="pointer-events-auto flex h-full w-full flex-col rounded-2xl"
      style={{ background: 'var(--dm-panel)', border: '1px solid #ffffff14', boxShadow: '0 12px 40px 6px #00000066' }}
    >
      {/* Header: status + close */}
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: STATE_COLOR[state], boxShadow: `0 0 8px 1px ${STATE_COLOR[state]}99` }}
          />
          <span className="text-[12px] font-semibold text-white/90">{STATE_LABEL[state]}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-white/40 hover:text-white/80"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      {/* Latest Need to Know */}
      <div className="mt-2 px-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white/35">最新动态</div>
        {latestNtk ? (
          <div className="mt-1">
            <div className="text-[12px] font-medium text-white/85">{latestNtk.title}</div>
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/50">{latestNtk.summary}</div>
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-white/35">暂无最新动态。</div>
        )}
      </div>

      {/* Approvals */}
      <div className="mt-3 px-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white/35">审批</div>
        <button
          onClick={onReview}
          className="mt-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left"
          style={{
            background: pendingApprovalCount > 0 ? '#ff3b3b22' : '#ffffff08',
            border: pendingApprovalCount > 0 ? '1px solid #ff3b3b55' : '1px solid #ffffff10'
          }}
        >
          <span className="text-[11px] text-white/80">
            {pendingApprovalCount > 0
              ? `${pendingApprovalCount} 项待审批`
              : '无待办'}
          </span>
          <span className="text-[11px] font-semibold text-white/70">去审批 →</span>
        </button>
      </div>

      {/* Actions */}
      <div className="mt-auto flex flex-col gap-2 p-3">
        <button
          onClick={onOpenWorkbench}
          className="w-full rounded-md px-2 py-2 text-[12px] font-semibold text-white"
          style={{ background: 'var(--dm-accent)' }}
        >
          打开工作台
        </button>
      </div>
    </div>
  )
}
