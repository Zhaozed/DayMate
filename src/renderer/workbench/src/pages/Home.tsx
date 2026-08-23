import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  Task,
  TaskPriority,
  TaskCreateInput,
  NeedToKnow,
  WeatherBriefing
} from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { TASK_PRIORITY_LABEL, TASK_CATEGORY_LABEL } from '../labels'

// Home (Spec §18, ADR 0026). Three cards: 今日天气 (real wttr.in + LLM-polished
// briefing, cached daily), 今日晨报 (swipeable carousel over the last ~7 days'
// morning-brief NTKs), and 我的 ToDo (manageable list, auto-extracted from
// incremental email). The old 近期动态 activity card + IPC health card + the
// "运行晨报" button are gone — the Home page now answers "what does today
// look like?" at a glance instead of echoing activity log noise.

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

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function HomePage(): ReactElement {
  // ── 天气 ──
  const { data: weather, loading: weatherLoading, refetch: refetchWeather } =
    useAsync<WeatherBriefing | null>(async () => {
      try {
        return (await window.daymate.getWeather()) ?? null
      } catch {
        return null
      }
    })
  const [weatherBusy, setWeatherBusy] = useState(false)
  const generateWeather = async (): Promise<void> => {
    setWeatherBusy(true)
    try {
      await window.daymate.refreshWeather()
      refetchWeather()
    } finally {
      setWeatherBusy(false)
    }
  }

  // ── 晨报 carousel ──
  const { data: briefs, refetch: refetchBriefs } = useAsync<NeedToKnow[]>(
    () => window.daymate.listMorningBriefs()
  )
  const [briefIdx, setBriefIdx] = useState(0)
  useEffect(() => {
    // When the list changes (new brief generated), snap back to the latest.
    setBriefIdx(0)
  }, [briefs])
  const briefsSorted = useMemo(() => {
    const list = (briefs ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return list
  }, [briefs])
  const currentBrief = briefsSorted[Math.min(briefIdx, briefsSorted.length - 1)]
  const [briefRunning, setBriefRunning] = useState(false)
  const runMorningBrief = async (): Promise<void> => {
    setBriefRunning(true)
    try {
      await window.daymate.runRoutine('morning_brief')
      refetchBriefs()
    } finally {
      setBriefRunning(false)
    }
  }

  // ── ToDo ──
  const { data: tasks, setData: setTasks } = useAsync<Task[]>(() =>
    window.daymate.listTasks()
  )
  // Live push: an auto-extracted ToDo (or a manual change elsewhere) refreshes
  // the list without a manual refetch.
  useEffect(() => {
    return window.daymate.onTasksChanged(() => {
      void window.daymate.listTasks().then((next) => setTasks(next))
    })
  }, [setTasks])

  const todoList = useMemo(() => {
    const list = (tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'dismissed')
    return list.sort((a, b) => {
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      if (p !== 0) return p
      if (a.dueAt && b.dueAt) return a.dueAt < b.dueAt ? -1 : 1
      if (a.dueAt) return -1
      if (b.dueAt) return 1
      return a.createdAt < b.createdAt ? 1 : -1
    })
  }, [tasks])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; priority: TaskPriority; dueAt: string }>({
    title: '',
    priority: 'medium',
    dueAt: ''
  })
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

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
      priority: 'medium'
    }
    const created = await window.daymate.createTask(input)
    setTasks((prev) => [...(prev ?? []), created])
    setNewTitle('')
    setCreating(false)
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-white">首页</h1>

      <div className="mt-6 grid grid-cols-2 gap-4">
        {/* ── 今日天气 ── */}
        <div
          className="rounded-lg border border-white/5 p-4"
          style={{ background: 'var(--dm-panel)' }}
        >
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-white/40">今日天气</div>
            <button
              onClick={() => generateWeather()}
              disabled={weatherBusy}
              className="text-xs text-white/60 hover:text-white disabled:opacity-50"
            >
              {weatherBusy ? '生成中…' : '刷新'}
            </button>
          </div>
          {weatherLoading ? (
            <div className="mt-3 text-sm text-white/35">加载中…</div>
          ) : weather ? (
            <div className="mt-3">
              <div className="text-lg font-semibold text-white">{weather.tempText}</div>
              <div className="mt-1 text-sm text-white/70">{weather.summary}</div>
              <div className="mt-2 text-sm text-white/60">
                <span className="text-white/40">穿衣：</span>
                {weather.clothing}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-emerald-400/20 bg-emerald-400/5 p-2">
                  <div className="text-emerald-300/70">宜</div>
                  <ul className="mt-1 space-y-0.5 text-white/70">
                    {weather.yi.map((y, i) => (
                      <li key={i}>{y}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded border border-rose-400/20 bg-rose-400/5 p-2">
                  <div className="text-rose-300/70">忌</div>
                  <ul className="mt-1 space-y-0.5 text-white/70">
                    {weather.ji.map((j, i) => (
                      <li key={i}>{j}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <div className="text-sm text-white/45">今日天气尚未生成。</div>
              <button
                onClick={() => generateWeather()}
                disabled={weatherBusy}
                className="mt-3 rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--dm-accent)' }}
              >
                {weatherBusy ? '生成中…' : '生成今日天气'}
              </button>
            </div>
          )}
        </div>

        {/* ── 今日晨报 (carousel) ── */}
        <div
          className="rounded-lg border border-white/5 p-4"
          style={{ background: 'var(--dm-panel)' }}
        >
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-white/40">今日晨报</div>
            {briefsSorted.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-white/45">
                <button
                  onClick={() => setBriefIdx((i) => Math.min(i + 1, briefsSorted.length - 1))}
                  disabled={briefIdx >= briefsSorted.length - 1}
                  className="disabled:opacity-30"
                >
                  ‹
                </button>
                <span>
                  {briefIdx + 1}/{briefsSorted.length}
                </span>
                <button
                  onClick={() => setBriefIdx((i) => Math.max(i - 1, 0))}
                  disabled={briefIdx <= 0}
                  className="disabled:opacity-30"
                >
                  ›
                </button>
              </div>
            )}
          </div>
          {currentBrief ? (
            <div className="mt-3">
              <div className="text-sm text-white/40">
                {new Date(currentBrief.createdAt).toLocaleDateString('zh-CN')}
              </div>
              <div className="mt-1 text-base font-medium text-white">{currentBrief.title}</div>
              <div className="mt-2 text-sm text-white/70">{currentBrief.summary}</div>
            </div>
          ) : (
            <div className="mt-3">
              <div className="text-sm text-white/45">今日晨报尚未生成。</div>
              <button
                onClick={() => runMorningBrief()}
                disabled={briefRunning}
                className="mt-3 rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--dm-accent)' }}
              >
                {briefRunning ? '生成中…' : '生成今日晨报'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── 我的 ToDo ── */}
      <div
        className="mt-4 rounded-lg border border-white/5 p-4"
        style={{ background: 'var(--dm-panel)' }}
      >
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-white/40">我的 ToDo</div>
          <button
            onClick={() => setCreating((v) => !v)}
            className="text-xs font-medium text-white/70 hover:text-white"
            style={{ color: 'var(--dm-accent)' }}
          >
            + 新建
          </button>
        </div>

        {creating && (
          <div className="mt-3 flex items-center gap-2">
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
              placeholder="新建一条待办…"
              className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-sm text-white outline-none placeholder:text-white/30"
            />
            <button
              onClick={() => createTodo()}
              className="rounded px-2 py-1 text-xs text-white"
              style={{ background: 'var(--dm-accent)' }}
            >
              添加
            </button>
          </div>
        )}

        <ul className="mt-3 space-y-1.5">
          {todoList.map((t) => (
            <li
              key={t.id}
              className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={() => toggleDone(t)}
                className="mt-1 accent-[var(--dm-accent)]"
              />
              <div className="min-w-0 flex-1">
                {editingId === t.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-sm text-white outline-none"
                    />
                    <select
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, priority: e.target.value as TaskPriority }))
                      }
                      className="rounded border border-white/10 bg-black/20 px-1 py-1 text-xs text-white outline-none"
                    >
                      {(['urgent', 'high', 'medium', 'low'] as TaskPriority[]).map((p) => (
                        <option key={p} value={p} className="bg-zinc-800">
                          {TASK_PRIORITY_LABEL[p]}
                        </option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={draft.dueAt}
                      onChange={(e) => setDraft((d) => ({ ...d, dueAt: e.target.value }))}
                      className="rounded border border-white/10 bg-black/20 px-1 py-1 text-xs text-white outline-none"
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
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm ${
                          t.status === 'done' ? 'text-white/35 line-through' : 'text-white/85'
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
                        <span className="text-[10px] text-white/40">{fmtDate(t.dueAt)}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex gap-3 text-[10px] text-white/35">
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
          {todoList.length === 0 && (
            <li className="py-2 text-sm text-white/35">暂无待办，清净的一天。</li>
          )}
        </ul>
      </div>
    </div>
  )
}
