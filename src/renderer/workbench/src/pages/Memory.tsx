import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { MemoryItem, MemoryKey, MemorySaveInput } from '@shared/types'
import { MEMORY_KEYS } from '@shared/constants'
import { MEMORY_KEY_LABEL, PROFILE_MEMORY_KEYS, LIST_MEMORY_KEYS } from '../labels'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'

// Memory page (Spec §18/§16, ADR 0009 town-style). Memory is explicit,
// inspectable, deletable. This page is organized as a town-style user profile:
//   • 用户画像 (Profile) — confirmed profile keys (persona / writing_style /
//     email_tone / working_hours / job_search_profile / meeting_duration) as
//     editable field cards, one row per key, inline-editable. Missing keys
//     show an "add" affordance.
//   • 联系人 / 项目 / 通知偏好 — confirmed list keys, flat.
//   • 其他记忆 — confirmed `other` key, flat.
//   • 待确认 — agent proposals (confirmed:false) for the user to confirm /
//     edit / dismiss.
//
// Confirm goes through `confirmMemory` (service.confirm → one-per-key demote),
// NOT the generic `updateMemory({confirmed:true})` which used to bypass that
// demote and leave duplicate confirmed rows per key.
export function MemoryPage(): ReactElement {
  const { data, loading, error, setData, refetch } = useAsync<MemoryItem[]>(() =>
    window.daymate.listMemory()
  )

  useEffect(() => {
    return window.daymate.onMemoryChanged((items) => setData(() => items))
  }, [setData])

  if (loading) return <Loading label="正在加载记忆…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const all = data ?? []
  const confirmed = all.filter((m) => m.confirmed)

  const findByKey = (key: MemoryKey): MemoryItem | undefined =>
    confirmed.find((m) => m.key === key)
  const listForKey = (key: MemoryKey): MemoryItem[] => confirmed.filter((m) => m.key === key)

  return (
    <div>
      <Header />

      <ProfileSection
        keys={PROFILE_MEMORY_KEYS}
        get={(k) => findByKey(k)}
        onSaved={refetch}
      />

      <Section title="联系人 / 项目 / 通知偏好" hint="inline 编辑或删除。">
        {LIST_MEMORY_KEYS.every((k) => listForKey(k).length === 0) ? (
          <EmptyState title="无内容" hint="添加联系人、项目或通知偏好。" />
        ) : (
          <div className="space-y-2">
            {LIST_MEMORY_KEYS.flatMap((k) => listForKey(k)).map((m) => (
              <MemoryRow key={m.id} item={m} onSaved={refetch} />
            ))}
          </div>
        )}
      </Section>

      <Section title="其他记忆" hint="自由记录的条目。">
        {listForKey('other').length === 0 ? (
          <EmptyState title="无内容" hint="用下方「添加记忆」记一条。" />
        ) : (
          <div className="space-y-2">
            {listForKey('other').map((m) => (
              <MemoryRow key={m.id} item={m} onSaved={refetch} />
            ))}
          </div>
        )}
      </Section>

      <NewMemoryCard onSaved={() => refetch()} />
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">记忆</h1>
      <p className="mt-1 text-sm text-white/45">
        你的用户画像与偏好 —— 助手据此为你定制草稿与晨报。可直接编辑。
      </p>
    </div>
  )
}

function ProfileSection({
  keys,
  get,
  onSaved
}: {
  keys: MemoryKey[]
  get: (key: MemoryKey) => MemoryItem | undefined
  onSaved: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const out = await window.daymate.generatePersona()
      onSaved()
      const n = out.memoryProposals?.length ?? 0
      setMsg(n > 0 ? `${out.summary}（已更新 ${n} 条画像记忆）` : out.summary)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/40">用户画像</div>
        <button
          onClick={generate}
          disabled={busy}
          className="rounded bg-white/5 px-2.5 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
          title="读取你授权连接的邮箱的已发送邮件，自动推断人物画像并生成待确认记忆"
        >
          {busy ? '推断中…' : '生成用户画像'}
        </button>
      </div>
      <p className="mt-1 text-xs text-white/35">
        读取已连接邮箱的已发送邮件，自动推断你的画像与写作风格，生成待确认提案。
      </p>
      {msg && <div className="mt-2 text-xs text-emerald-300/80">{msg}</div>}
      {err && <div className="mt-2 text-xs text-rose-300/80">{err}</div>}
      <div className="mt-3 space-y-2">
        {keys.map((key) => {
          const item = get(key)
          return (
            <ProfileRow
              key={key}
              memoryKey={key}
              item={item}
              onSaved={onSaved}
            />
          )
        })}
      </div>
    </div>
  )
}

function ProfileRow({
  memoryKey,
  item,
  onSaved
}: {
  memoryKey: MemoryKey
  item: MemoryItem | undefined
  onSaved: () => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setDraft(item?.value ?? '')
  }, [item?.value])

  const save = async (): Promise<void> => {
    if (!draft.trim()) return
    setBusy(true)
    setErr(null)
    try {
      if (item) {
        await window.daymate.updateMemory(item.id, { value: draft.trim() })
      } else {
        const input: MemorySaveInput = {
          key: memoryKey,
          value: draft.trim(),
          source: 'user',
          confirmed: true
        }
        await window.daymate.saveMemory(input)
      }
      setEditing(false)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-3 border-b border-white/5 pb-2 last:border-0 last:pb-0">
      <div className="w-24 shrink-0 pt-1 text-xs text-white/45">{MEMORY_KEY_LABEL[memoryKey]}</div>
      <div className="flex-1">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-sm text-white/90"
            rows={2}
            placeholder={`输入你的${MEMORY_KEY_LABEL[memoryKey]}…`}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="w-full text-left text-sm text-white/80 hover:text-white"
          >
            {item ? item.value : <span className="text-white/35">未设置，点击添加…</span>}
          </button>
        )}
        {err && <div className="mt-1 text-xs text-rose-300/80">{err}</div>}
      </div>
      {editing && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={save}
            disabled={busy || !draft.trim()}
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存'}
          </button>
          <button
            onClick={() => {
              setDraft(item?.value ?? '')
              setEditing(false)
              setErr(null)
            }}
            className="rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-white/10"
          >
            取消
          </button>
        </div>
      )}
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
              {MEMORY_KEY_LABEL[k]}
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
      await window.daymate.confirmMemory(item.id)
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
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/50">
              {MEMORY_KEY_LABEL[item.key] ?? item.key}
            </span>
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
