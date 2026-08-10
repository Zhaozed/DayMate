import type { ReactElement } from 'react'
import type { TaskStatus, TaskPriority } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import { TASK_STATUS_LABEL, TASK_PRIORITY_LABEL, statusLabel } from '../labels'

// Task Center (Spec §18). Tasks grouped by status, with source reference and
// allowed status transitions.
const STATUS_GROUPS: TaskStatus[] = ['need_approval', 'todo', 'waiting', 'need_to_know', 'done', 'dismissed']

export function TasksPage(): ReactElement {
  const { data: tasks, loading, error, setData, refetch } = useAsync(() => window.daymate.listTasks())

  const transition = async (id: string, status: TaskStatus): Promise<void> => {
    try {
      const updated = await window.daymate.updateTask(id, { status })
      setData((prev) => (prev ?? []).map((t) => (t.id === id ? updated : t)))
    } catch (err) {
      console.error(err)
    }
  }

  if (loading) return <Loading label="正在加载任务…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const list = tasks ?? []
  if (list.length === 0) {
    return (
      <div>
        <Header />
        <EmptyState title="暂无任务" hint="例程会在此创建任务。" />
      </div>
    )
  }

  return (
    <div>
      <Header />
      <div className="mt-6 space-y-6">
        {STATUS_GROUPS.map((status) => {
          const group = list.filter((t) => t.status === status)
          if (group.length === 0) return null
          return (
            <section key={status}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
                {statusLabel(TASK_STATUS_LABEL, status)}
              </h2>
              <div className="space-y-2">
                {group.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-lg border border-white/5 p-3" style={{ background: 'var(--dm-panel)' }}>
                    <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: priorityColor(t.priority) }}>
                      {statusLabel(TASK_PRIORITY_LABEL, t.priority)}
                    </span>
                    <div className="flex-1">
                      <div className="text-sm text-white/90">{t.title}</div>
                      {t.sourceId && (
                        <div className="text-xs text-white/35">
                          {t.sourceType} · {t.sourceId}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {status !== 'done' && (
                        <button onClick={() => transition(t.id, 'done')} className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10">
                          完成
                        </button>
                      )}
                      {status !== 'dismissed' && (
                        <button onClick={() => transition(t.id, 'dismissed')} className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10">
                          忽略
                        </button>
                      )}
                      {status === 'done' && (
                        <button onClick={() => transition(t.id, 'todo')} className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10">
                          重开
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">任务</h1>
      <p className="mt-1 text-sm text-white/45">跟进中心。</p>
    </div>
  )
}

function priorityColor(p: TaskPriority): string {
  switch (p) {
    case 'urgent':
      return '#7f1d1d'
    case 'high':
      return '#9a3412'
    case 'medium':
      return '#3b4252'
    default:
      return '#3b4252'
  }
}
