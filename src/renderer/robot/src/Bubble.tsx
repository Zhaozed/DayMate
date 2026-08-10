import type { ReactElement } from 'react'

// Proactive bubble (M4 §18). A small card the main process pushes via
// onRobotNotify — e.g. an approval-needed notice or a "draft ready" ping.
// Auto-dismisses after ~5s (the parent owns the timer); a Review deep-link is
// shown when the notification carries an approval context.
export interface BubbleProps {
  message: string
  /** Show the Review button (an approval is pending / a deep-link is set). */
  reviewLabel?: string
  onReview?: () => void
  /** Dismiss immediately (e.g. user clicked Review or the close affordance). */
  onDismiss?: () => void
}

export function Bubble({ message, reviewLabel, onReview, onDismiss }: BubbleProps): ReactElement {
  return (
    <div
      className="pointer-events-auto flex w-full items-center gap-2 rounded-2xl px-3 py-2"
      style={{ background: 'var(--dm-panel)', border: '1px solid #ffffff14', boxShadow: '0 8px 24px 4px #00000055' }}
    >
      <div className="flex-1 text-[12px] leading-snug text-white/85">{message}</div>
      {reviewLabel && (
        <button
          onClick={onReview}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold"
          style={{ background: 'var(--dm-accent)', color: '#fff' }}
        >
          {reviewLabel}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-white/40 hover:text-white/80"
        aria-label="关闭"
      >
        ✕
      </button>
    </div>
  )
}
