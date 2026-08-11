import { useState } from 'react'
import type { ReactElement } from 'react'
import type { InterviewNote, InterviewNoteInput, InterviewNoteTag } from '@shared/types'
import { INTERVIEW_NOTE_TAGS } from '@shared/constants'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import { INTERVIEW_NOTE_TAG_LABEL, statusLabel } from '../labels'

// 面经库 (Spec §6). Post-interview experience notes. Standalone (NOT tied to
// one application) so a 面经 for company X is reusable. `source` is 'manual'
// (user-authored) or 'agent' (AI-summarised). Both are the user's own
// knowledge — trusted under §17 — so content renders plainly.
const TAGS: InterviewNoteTag[] = [...INTERVIEW_NOTE_TAGS]

export function InterviewNotesPage(): ReactElement {
  const [query, setQuery] = useState('')
  const { data, loading, error, refetch } = useAsync<InterviewNote[]>(
    () => window.daymate.listInterviewNotes(query.trim() || undefined),
    [query]
  )

  if (loading) return <Loading label="正在加载面经…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />

  const notes = data ?? []

  return (
    <div>
      <Header />

      <div className="mt-4 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索公司 / 职位 / 内容…"
          className="flex-1 rounded bg-white/5 px-3 py-1.5 text-sm text-white/90 outline-none"
        />
      </div>

      <NewNoteCard onSaved={refetch} />

      {notes.length === 0 ? (
        <EmptyState
          title="暂无面经"
          hint="在上方添加一条面试经验，或输入关键词搜索。"
        />
      ) : (
        <div className="mt-6 space-y-2">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">面经库</h1>
      <p className="mt-1 text-sm text-white/45">
        跨公司复用的面试经验。按标签归类，支持全文搜索。
      </p>
    </div>
  )
}

function NewNoteCard({ onSaved }: { onSaved: () => void }): ReactElement {
  const [company, setCompany] = useState('')
  const [position, setPosition] = useState('')
  const [tags, setTags] = useState<InterviewNoteTag[]>([])
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggleTag = (t: InterviewNoteTag): void => {
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  const save = async (): Promise<void> => {
    if (!content.trim() || tags.length === 0) return
    setBusy(true)
    setErr(null)
    try {
      const input: InterviewNoteInput = {
        company: company.trim() || undefined,
        position: position.trim() || undefined,
        tags,
        content: content.trim()
      }
      await window.daymate.createInterviewNote(input)
      setCompany('')
      setPosition('')
      setTags([])
      setContent('')
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 space-y-2 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="text-sm font-semibold text-white/80">新增面经</div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="公司（可选）"
          className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
        />
        <input
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          placeholder="职位（可选）"
          className="rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TAGS.map((t) => {
          const on = tags.includes(t)
          return (
            <button
              key={t}
              onClick={() => toggleTag(t)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                on ? 'bg-white/20 text-white' : 'bg-white/5 text-white/55 hover:bg-white/10'
              }`}
            >
              {statusLabel(INTERVIEW_NOTE_TAG_LABEL, t)}
            </button>
          )
        })}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="面经内容（题目、思路、复盘…）"
        rows={4}
        className="w-full rounded bg-white/5 px-2 py-1.5 text-sm text-white/90 outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !content.trim() || tags.length === 0}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存'}
        </button>
        {err && <span className="text-xs text-rose-300/80">{err}</span>}
      </div>
    </div>
  )
}

function NoteCard({ note }: { note: InterviewNote }): ReactElement {
  return (
    <div className="rounded-lg border border-white/5 p-3" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center gap-2">
        {note.company && <span className="text-sm text-white/90">{note.company}</span>}
        {note.position && (
          <>
            <span className="text-xs text-white/40">·</span>
            <span className="text-sm text-white/70">{note.position}</span>
          </>
        )}
        <span className="ml-auto text-xs text-white/35">
          {note.source === 'agent' ? 'AI 摘要' : '手动'} ·{' '}
          {new Date(note.createdAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      {note.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {note.tags.map((t) => (
            <span
              key={t}
              className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/55"
            >
              {statusLabel(INTERVIEW_NOTE_TAG_LABEL, t)}
            </span>
          ))}
        </div>
      )}
      <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-white/80">
        {note.content}
      </pre>
    </div>
  )
}
