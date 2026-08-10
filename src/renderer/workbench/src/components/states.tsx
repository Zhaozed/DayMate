import type { ReactElement } from 'react'

// Shared loading / empty / error states for workbench pages (Spec §18: surface
// clear user-facing errors; no silent swallowing). Use these instead of bare
// "暂无内容" text so the triad stays consistent across pages.

export function Loading({ label = '加载中…' }: { label?: string }): ReactElement {
  return (
    <div className="mt-6 flex items-center gap-2 text-sm text-white/45">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/15 border-t-white/60" />
      {label}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div
      className="mt-6 rounded-lg border border-white/5 p-6 text-center"
      style={{ background: 'var(--dm-panel)' }}
    >
      <div className="text-sm text-white/55">{title}</div>
      {hint && <div className="mt-1 text-xs text-white/35">{hint}</div>}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry
}: {
  message: string
  onRetry?: () => void
}): ReactElement {
  return (
    <div
      className="mt-6 rounded-lg border border-rose-500/20 p-4"
      style={{ background: 'rgba(120,0,40,0.08)' }}
    >
      <div className="text-sm text-rose-200">⚠ 出错了</div>
      <div className="mt-1 text-xs text-white/55">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
        >
          重试
        </button>
      )}
    </div>
  )
}
