import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { Task, TaskPriority, TaskCreateInput } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, ErrorState } from '../components/states'
import { TASK_PRIORITY_LABEL, TASK_CATEGORY_LABEL } from '../labels'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3
}

const PROVIDER_LABEL: Record<NonNullable<Task['sourceProvider']>, string> = {
  gmail: 'Gmail',
  mail163: '163'
}

type FilterTab = 'active' | 'all' | 'done'
type DomainCategory = 'all' | 'job' | 'school' | 'daily'

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function TasksPage(): ReactElement {
  const { data: tasks, loading, error, setData: setTasks, refetch } = useAsync<Task[]>(() =>
    window.daymate.listTasks()
  )

  const [filterTab, setFilterTab] = useState<FilterTab>('active')
  const [domainFilter, setDomainFilter] = useState<DomainCategory>('all')
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium')
  const [newDueAt, setNewDueAt] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; priority: TaskPriority; dueAt: string }>({
    title: '',
    priority: 'medium',
    dueAt: ''
  })

  // Live push: auto-extracted ToDos from incoming mail or manual updates elsewhere
  useEffect(() => {
    return window.daymate.onTasksChanged(() => {
      void window.daymate.listTasks().then((next) => setTasks(next))
    })
  }, [setTasks])

  const allTasks = useMemo(() => tasks ?? [], [tasks])

  const activeCount = useMemo(
    () => allTasks.filter((t) => t.status !== 'done' && t.status !== 'dismissed').length,
    [allTasks]
  )
  const doneCount = useMemo(
    () => allTasks.filter((t) => t.status === 'done').length,
    [allTasks]
  )

  const filteredTasks = useMemo(() => {
    let list = allTasks
    if (filterTab === 'active') {
      list = list.filter((t) => t.status !== 'done' && t.status !== 'dismissed')
    } else if (filterTab === 'done') {
      list = list.filter((t) => t.status === 'done')
    }

    if (domainFilter === 'job') {
      list = list.filter((t) => t.category === 'job')
    } else if (domainFilter === 'school') {
      list = list.filter((t) => t.category === 'school')
    } else if (domainFilter === 'daily') {
      list = list.filter((t) => t.category === 'bill' || t.category === 'meeting' || t.category === 'other' || !t.category)
    }

    return list.slice().sort((a, b) => {
      // Completed items go to bottom if viewed in 'all'
      if (filterTab === 'all') {
        const aDone = a.status === 'done' || a.status === 'dismissed'
        const bDone = b.status === 'done' || b.status === 'dismissed'
        if (aDone !== bDone) return aDone ? 1 : -1
      }
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      if (p !== 0) return p
      if (a.dueAt && b.dueAt) return a.dueAt < b.dueAt ? -1 : 1
      if (a.dueAt) return -1
      if (b.dueAt) return 1
      return a.createdAt < b.createdAt ? 1 : -1
    })
  }, [allTasks, filterTab, domainFilter])

  const toggleDone = async (t: Task): Promise<void> => {
    const next = t.status === 'done' ? 'todo' : 'done'
    const updated = await window.daymate.updateTask(t.id, { status: next })
    setTasks((prev) => (prev ?? []).map((x) => (x.id === t.id ? updated : x)))
  }

  const startEdit = (t: Task): void => {
    setEditingId(t.id)
    setDraft({
      title: t.title,
      priority: t.priority,
      dueAt: t.dueAt ? t.dueAt.slice(0, 10) : ''
    })
  }

  const saveEdit = async (t: Task): Promise<void> => {
    const patch: { title: string; priority: TaskPriority; dueAt?: string } = {
      title: draft.title.trim() || t.title,
      priority: draft.priority
    }
    if (draft.dueAt) patch.dueAt = new Date(draft.dueAt).toISOString()
    const updated = await window.daymate.updateTask(t.id, patch)
    setTasks((prev) => (prev ?? []).map((x) => (x.id === t.id ? updated : x)))
    setEditingId(null)
  }

  const removeTask = async (t: Task): Promise<void> => {
    await window.daymate.deleteTask(t.id)
    setTasks((prev) => (prev ?? []).filter((x) => x.id !== t.id))
  }

  const createTodo = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    const input: TaskCreateInput = {
      title,
      sourceType: 'assistant',
      priority: newPriority
    }
    if (newDueAt) {
      input.dueAt = new Date(newDueAt).toISOString()
    }
    const created = await window.daymate.createTask(input)
    setTasks((prev) => [...(prev ?? []), created])
    setNewTitle('')
    setNewDueAt('')
    setNewPriority('medium')
    setCreating(false)
  }

  if (loading && allTasks.length === 0) return <Loading label="正在加载待办…" />
  if (error && allTasks.length === 0) return <ErrorState message={error.message} onRetry={refetch} />

  return (
    <div>
      {/* ── 顶部标题 ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">待办</h1>
          <p className="mt-1 text-sm text-white/45">邮件与投递跟进 · 自动提取与个人待办</p>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--dm-accent)' }}
        >
          {creating ? '取消' : '+ 新建待办'}
        </button>
      </div>

      {/* ── 新建表单 ── */}
      {creating && (
        <div
          className="mt-4 rounded-lg border border-white/10 p-4"
          style={{ background: 'var(--dm-panel)' }}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-white/50">
            新建待办事项
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createTodo()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewTitle('')
                }
              }}
              placeholder="待办内容…"
              className="min-w-[240px] flex-1 rounded border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/20"
            />
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
              className="rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none focus:border-white/20"
            >
              {(['urgent', 'high', 'medium', 'low'] as TaskPriority[]).map((p) => (
                <option key={p} value={p} className="bg-zinc-900">
                  {TASK_PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={newDueAt}
              onChange={(e) => setNewDueAt(e.target.value)}
              className="rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none focus:border-white/20"
            />
            <button
              onClick={() => createTodo()}
              className="rounded px-3 py-1.5 text-xs font-medium text-white"
              style={{ background: 'var(--dm-accent)' }}
            >
              添加
            </button>
          </div>
        </div>
      )}

      {/* ── 过滤 Tab ── */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFilterTab('active')}
            className={`rounded px-3 py-1 text-xs transition-colors ${
              filterTab === 'active'
                ? 'bg-white/10 font-medium text-white'
                : 'text-white/45 hover:text-white/70'
            }`}
          >
            进行中 {activeCount > 0 && <span className="ml-1 text-white/40">({activeCount})</span>}
          </button>
          <button
            onClick={() => setFilterTab('all')}
            className={`rounded px-3 py-1 text-xs transition-colors ${
              filterTab === 'all'
                ? 'bg-white/10 font-medium text-white'
                : 'text-white/45 hover:text-white/70'
            }`}
          >
            全部 {allTasks.length > 0 && <span className="ml-1 text-white/40">({allTasks.length})</span>}
          </button>
          <button
            onClick={() => setFilterTab('done')}
            className={`rounded px-3 py-1 text-xs transition-colors ${
              filterTab === 'done'
                ? 'bg-white/10 font-medium text-white'
                : 'text-white/45 hover:text-white/70'
            }`}
          >
            已完成 {doneCount > 0 && <span className="ml-1 text-white/40">({doneCount})</span>}
          </button>
        </div>

        {/* ── 领域分类 (求职 / 学校 / 日常) ── */}
        <div className="flex items-center gap-1 bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.06]">
          {(
            [
              { key: 'all', label: '全部' },
              { key: 'job', label: '💼 求职' },
              { key: 'school', label: '🎓 学校' },
              { key: 'daily', label: '☕ 日常' }
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              onClick={() => setDomainFilter(item.key)}
              className={`rounded-md px-2.5 py-0.5 text-xs transition-all ${
                domainFilter === item.key
                  ? 'bg-white/15 font-medium text-white shadow-sm'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 列表 ── */}
      <div className="mt-4">
        {filteredTasks.length === 0 ? (
          <div className="rounded-lg border border-white/5 py-12 text-center text-sm text-white/35" style={{ background: 'var(--dm-panel)' }}>
            {filterTab === 'active'
              ? '暂无进行中的待办事项，一切就绪。'
              : filterTab === 'done'
                ? '暂无已完成的待办事项。'
                : '暂无待办事项，清净的一天。'}
          </div>
        ) : (
          <ul
            className="divide-y divide-white/5 rounded-lg border border-white/5"
            style={{ background: 'var(--dm-panel)' }}
          >
            {filteredTasks.map((t) => (
              <li
                key={t.id}
                className="flex items-start gap-3 p-3 transition-colors hover:bg-white/[0.02]"
              >
                <input
                  type="checkbox"
                  checked={t.status === 'done'}
                  onChange={() => toggleDone(t)}
                  className="mt-1 cursor-pointer accent-[var(--dm-accent)]"
                />
                <div className="min-w-0 flex-1">
                  {editingId === t.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={draft.title}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-sm text-white outline-none focus:border-white/20"
                      />
                      <select
                        value={draft.priority}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, priority: e.target.value as TaskPriority }))
                        }
                        className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
                      >
                        {(['urgent', 'high', 'medium', 'low'] as TaskPriority[]).map((p) => (
                          <option key={p} value={p} className="bg-zinc-900">
                            {TASK_PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        value={draft.dueAt}
                        onChange={(e) => setDraft((d) => ({ ...d, dueAt: e.target.value }))}
                        className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
                      />
                      <button
                        onClick={() => saveEdit(t)}
                        className="text-xs text-emerald-300/80 hover:text-emerald-300"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-xs text-white/40 hover:text-white/60"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-sm ${
                            t.status === 'done' ? 'text-white/35 line-through' : 'text-white/90'
                          }`}
                        >
                          {t.title}
                        </span>

                        {t.sourceProvider &&
                          (t.sourceLink ? (
                            <a
                              href={t.sourceLink}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/55 hover:text-white/80"
                            >
                              {PROVIDER_LABEL[t.sourceProvider]}
                            </a>
                          ) : (
                            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/55">
                              {PROVIDER_LABEL[t.sourceProvider]}
                            </span>
                          ))}

                        <span
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{
                            background:
                              t.priority === 'urgent'
                                ? 'rgba(244,63,94,0.15)'
                                : t.priority === 'high'
                                  ? 'rgba(251,191,36,0.15)'
                                  : 'rgba(255,255,255,0.08)',
                            color:
                              t.priority === 'urgent'
                                ? 'rgb(253,164,175)'
                                : t.priority === 'high'
                                  ? 'rgb(252,211,77)'
                                  : 'rgba(255,255,255,0.6)'
                          }}
                        >
                          {TASK_PRIORITY_LABEL[t.priority]}
                        </span>

                        {t.category && (
                          <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300/70">
                            {TASK_CATEGORY_LABEL[t.category]}
                          </span>
                        )}

                        {t.dueAt && (
                          <span className="text-[10px] text-white/40">截止: {fmtDate(t.dueAt)}</span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-3 text-[11px] text-white/35">
                        <button onClick={() => startEdit(t)} className="hover:text-white/60">
                          编辑
                        </button>
                        <button onClick={() => removeTask(t)} className="hover:text-rose-300/70">
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
