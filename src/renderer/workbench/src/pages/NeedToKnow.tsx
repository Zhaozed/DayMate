import type { ReactElement } from 'react'
import type { NeedToKnow } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'

// Need to Know (Spec §18). Surfaces the items the Agent decided you must see —
// with priority, reason, sources and any suggested action.
export function NeedToKnowPage(): ReactElement {
  const { data: items, loading, error, refetch } = useAsync(() => window.daymate.listNeedToKnow())

  if (loading) return <Loading label="正在加载必读…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = items ?? []
  if (list.length === 0) {
    return (
      <div>
        <Header />
        <EmptyState title="暂无内容" hint="例程会在此发布事项。" />
      </div>
    )
  }

  return (
    <div>
      <Header />
      <div className="mt-6 space-y-3">
        {list.map((n) => (
          <div
            key={n.id}
            className="rounded-lg border border-white/5 p-4"
            style={{ background: 'var(--dm-panel)' }}
          >
            <div className="flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-xs"
                style={{ background: priorityColor(n.priority) }}
              >
                {n.priority}
              </span>
              <h3 className="text-sm font-semibold text-white/90">{n.title}</h3>
            </div>
            <p className="mt-2 text-sm text-white/70">{n.summary}</p>
            <p className="mt-1 text-xs text-white/40">{n.reason}</p>

            {n.sourceRefs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {n.sourceRefs.map((s) => (
                  <span key={s.id} className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/50">
                    {s.type}：{s.label ?? s.id}
                  </span>
                ))}
              </div>
            )}

            {n.suggestedActions.length > 0 && (
              <div className="mt-2 text-xs text-white/45">
                建议：{n.suggestedActions.map((a) => a.label).join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">必读</h1>
      <p className="mt-1 text-sm text-white/45">助手标记的重要事项。</p>
    </div>
  )
}

function priorityColor(p: NeedToKnow['priority']): string {
  switch (p) {
    case 'urgent':
      return '#7f1d1d'
    case 'high':
      return '#9a3412'
    default:
      return '#3b4252'
  }
}
