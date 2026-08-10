import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { MemoryItem, MemoryKey, MemorySaveInput } from '@shared/types'
import { MEMORY_KEYS } from '@shared/constants'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'

// Memory page (Spec §18/§16). Memory is explicit, inspectable, deletable.
// Proposed memories (agent proposals awaiting confirmation) are shown separately
// from confirmed memories (active / searchable). The user confirms, edits or
// deletes here — nothing is auto-saved or auto-active.
export function MemoryPage(): ReactElement {
  const { data, loading, error, setData, refetch } = useAsync<MemoryItem[]>(() =>
    window.daymate.listMemory()
  )

  // Live push: memory changes (an agent proposal, a confirm elsewhere) refresh
  // the list so the user always sees the latest proposals.
  useEffect(() => {
    return window.daymate.onMemoryChanged((items) => setData(() => items))
  }, [setData])

  if (loading) return <Loading label="正在加载记忆…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const all = data ?? []
  const proposed = all.filter((m) => !m.confirmed)
  const confirmed = all.filter((m) => m.confirmed)

  return (
    <div>
      <Header />
      <NewMemoryCard onSaved={() => refetch()} />

      <Section title={`待确认（${proposed.length}）`} hint="助手提案 — 确认后生效，或忽略。">
        {proposed.length === 0 ? (
          <EmptyState title="无待确认记忆" hint="助手提案会出现在此处等你确认。" />
        ) : (
          <div className="space-y-2">
            {proposed.map((m) => (
              <MemoryRow key={m.id} item={m} onSaved={refetch} confirmable />
            ))}
          </div>
        )}
      </Section>

      <Section title={`已确认（${confirmed.length}）`} hint="助手可通过 memory.search 读取的活跃记忆。">
        {confirmed.length === 0 ? (
          <EmptyState title="无已确认记忆" hint="在上方添加一条，或确认一条提案。" />
        ) : (
          <div className="space-y-2">
            {confirmed.map((m) => (
              <MemoryRow key={m.id} item={m} onSaved={refetch} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">记忆</h1>
      <p className="mt-1 text-sm text-white/45">
        显式、可检视、可删除。助手提案需要你确认。
      </p>
    </div>
  )
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: ReactElement
}): ReactElement {
  return (
    <div className="mt-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-white/80">{title}</h2>
        {hint && <span className="text-xs text-white/35">{hint}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function NewMemoryCard({ onSaved }: { onSaved: () => void }): ReactElement {
  const [key, setKey] = useState<MemoryKey>('other')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const input: MemorySaveInput = { key, value: value.trim(), source: 'user', confirmed: true }
      await window.daymate.saveMemory(input)
      setValue('')
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide text-white/40">添加记忆</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={key}
          onChange={(e) => setKey(e.target.value as MemoryKey)}
          className="rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
        >
          {MEMORY_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如：偏好简洁回复；工作时间 9–18"
          className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <button
          onClick={save}
          disabled={busy || !value.trim()}
          className="rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-rose-300/80">{err}</div>}
    </div>
  )
}

function MemoryRow({
  item,
  onSaved,
  confirmable
}: {
  item: MemoryItem
  onSaved: () => void
  confirmable?: boolean
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.value)
  const [err, setErr] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    try {
      await window.daymate.updateMemory(item.id, { confirmed: true })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const dismiss = async (): Promise<void> => {
    try {
      await window.daymate.deleteMemory(item.id)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const saveEdit = async (): Promise<void> => {
    try {
      await window.daymate.updateMemory(item.id, { value: draft.trim() })
      setEditing(false)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="rounded-lg border border-white/5 p-3" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/50">{item.key}</span>
            <span className="text-xs text-white/35">
              {item.source} · {new Date(item.createdAt).toLocaleString()}
            </span>
          </div>
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="mt-2 w-full rounded border border-white/10 bg-black/30 p-2 text-sm text-white/90"
              rows={2}
            />
          ) : (
            <p className="mt-1 text-sm text-white/80">{item.value}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <button
                onClick={saveEdit}
                className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
              >
                保存
              </button>
              <button
                onClick={() => {
                  setDraft(item.value)
                  setEditing(false)
                }}
                className="rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-white/10"
              >
                取消
              </button>
            </>
          ) : (
            <>
              {confirmable && (
                <button
                  onClick={confirm}
                  className="rounded px-2 py-1 text-xs font-medium text-white"
                  style={{ background: 'var(--dm-accent)' }}
                >
                  确认
                </button>
              )}
              <button
                onClick={() => setEditing(true)}
                className="rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10"
              >
                编辑
              </button>
              <button
                onClick={dismiss}
                className="rounded bg-white/5 px-2 py-1 text-xs text-rose-300/70 hover:bg-white/10"
              >
                {confirmable ? '忽略' : '删除'}
              </button>
            </>
          )}
        </div>
      </div>
      {err && <div className="mt-2 text-xs text-rose-300/80">{err}</div>}
    </div>
  )
}
