import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { BriefingCategory, NeedToKnow, NormalizedEmail } from '@shared/types'
import { useAsync } from '../hooks/useAsync'
import { Loading, EmptyState, ErrorState } from '../components/states'
import {
  BRIEFING_CATEGORY_LABEL,
  BRIEFING_CATEGORY_ORDER,
  PROVIDER_LABEL,
  TASK_PRIORITY_LABEL
} from '../labels'

// 必读 (ADR 0029) — a cross-source information summary, NOT the morning brief.
// It is the consolidated view of everything important that came in from the
// connected sources (Gmail + 163 today, more apps later). Three things differ
// from the old "每日晨报" page:
//
//  1. De-晨报'd: header is just "必读" — no "运行晨报" button, no "清空全部"
//     button. This part has nothing to do with the Home 晨报 card.
//  2. Thread-aggregated: emails in the same conversation collapse into ONE
//     item. Expanding an item lazily fetches the WHOLE thread (via
//     getEmailThread) so the user reads the full context; surfaced 必读 emails
//     are starred within the thread.
//  3. 4-class sections (学校 / 求职 / 日常 / 其他) instead of priority groups,
//     with relaxed filtering (operation-triggered mail like 投递确认 / 面试通知
//     is KEPT; pure ads / verification codes / security alerts are dropped
//     upstream). Priority is now just a small in-item badge.
//
// Source provider + deep link are shown on every item so the user can jump to
// the original mail (Gmail = real per-message deep link; 163 = webmail root).
export function NeedToKnowPage(): ReactElement {
  const { data: items, loading, error, refetch } = useAsync(() => window.daymate.listNeedToKnow())

  // NTK has no dedicated push channel; an Activity change means a routine ran
  // or the email sync loop produced a new 必读 item — refetch.
  useEffect(() => {
    return window.daymate.onActivityChanged(() => refetch())
  }, [refetch])

  const dismiss = async (id: string): Promise<void> => {
    await window.daymate.dismissNeedToKnow(id)
    refetch()
  }

  // ADR 0029 — user edits a 必读 item's headline / summary inline (the model
  // summary is a draft; the user knows the context better and can fix it).
  const edit = async (id: string, patch: { title?: string; summary?: string }): Promise<void> => {
    await window.daymate.updateNeedToKnow(id, patch)
    refetch()
  }

  const list = items ?? []
  // Only swap in the full-screen skeleton / error when there is nothing to
  // show. A refetch (dismiss / live push) keeps the existing list mounted so
  // the scroll position and open threads survive — the full-screen Loading
  // unmount would otherwise snap the viewport back to the top every time.
  if (loading && list.length === 0) return <Loading label="正在加载必读…" />
  if (error && list.length === 0) return <ErrorState message={error.message} onRetry={refetch} />
  if (list.length === 0) {
    return (
      <div>
        <Header />
        <EmptyState
          title="暂无必读"
          hint="各来源的重要邮件（招聘 / 账单 / 导师 / 会议 / 投递确认 等）会在到达后自动汇总到这里。"
        />
      </div>
    )
  }

  // Group by 4-value briefingCategory (学校/求职/日常/其他); legacy items without
  // a category fall into 其他. Within a section, newest-updated first so a
  // thread that just got a new reply bubbles to the top.
  const groups = groupByBriefingCategory(list)

  return (
    <div>
      <Header />
      <div className="mt-6 space-y-8">
        {BRIEFING_CATEGORY_ORDER.map((cat) => {
          const group = groups.get(cat)
          if (!group || group.length === 0) return null
          return (
            <section key={cat}>
              <SectionHeader label={BRIEFING_CATEGORY_LABEL[cat]} count={group.length} color={categoryColor(cat)} />
              <div className="mt-2 space-y-3">
                {group.map((n) => (
                  <NtkItem key={n.id} item={n} onDismiss={() => dismiss(n.id)} onEdit={(patch) => edit(n.id, patch)} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function groupByBriefingCategory(list: NeedToKnow[]): Map<BriefingCategory, NeedToKnow[]> {
  const map = new Map<BriefingCategory, NeedToKnow[]>()
  for (const cat of BRIEFING_CATEGORY_ORDER) map.set(cat, [])
  for (const n of list) {
    const cat: BriefingCategory = n.briefingCategory ?? 'other'
    const bucket = map.get(cat) ?? map.get('other')!
    bucket.push(n)
  }
  // Sort each bucket newest-updated first (updatedAt falls back to createdAt).
  for (const bucket of map.values()) {
    bucket.sort((a, b) => ts(b.updatedAt ?? b.createdAt) - ts(a.updatedAt ?? a.createdAt))
  }
  return map
}

function ts(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

function categoryColor(cat: BriefingCategory): string {
  switch (cat) {
    case 'school':
      return '#1e3a5f'
    case 'job':
      return '#3b2f4a'
    case 'daily':
      return '#2f3b2f'
    default:
      return '#3b4252'
  }
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

function SectionHeader({ label, count, color }: { label: string; count: number; color: string }): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="text-white/70">▍</span>
      <span className="text-sm font-semibold text-white/90">{label}</span>
      <span className="rounded px-1.5 py-0.5 text-xs text-white/70" style={{ background: color }}>
        {count}
      </span>
    </div>
  )
}

function NtkItem({
  item,
  onDismiss,
  onEdit
}: {
  item: NeedToKnow
  onDismiss: () => void
  onEdit: (patch: { title?: string; summary?: string }) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  // ADR 0029 — inline edit: the model's headline/summary is a draft the user
  // can fix. Enter edit mode via the ✎ button; title→input, summary→textarea;
  // Enter/Ctrl+Enter or 保存 commits, Esc cancels. Edit only touches title +
  // summary (thread/source fields stay put).
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(item.title)
  const [draftSummary, setDraftSummary] = useState(item.summary)
  // Surfaced 必读 messageIds (from sourceRefs) — starred within the thread.
  const surfacedIds = useMemo(
    () => new Set(item.sourceRefs.filter((s) => s.type === 'email').map((s) => s.id)),
    [item.sourceRefs]
  )
  const threadCount = item.sourceRefs.length
  // ADR 0029 fix — the headline (item.title) is now the model's Chinese
  // summary (r.reason); the raw email subject lives on as a small subtitle
  // below it so the user still sees the original line. Pulled from the latest
  // sourceRef's label (sourceRefs[].label = email.subject at create/merge).
  const originalSubject = item.sourceRefs[item.sourceRefs.length - 1]?.label

  const beginEdit = (): void => {
    setDraftTitle(item.title)
    setDraftSummary(item.summary)
    setEditing(true)
  }
  const cancelEdit = (): void => {
    setEditing(false)
    setDraftTitle(item.title)
    setDraftSummary(item.summary)
  }
  const saveEdit = (): void => {
    const patch: { title?: string; summary?: string } = {}
    const t = draftTitle.trim()
    if (t && t !== item.title) patch.title = t
    const s = draftSummary.trim()
    if (s !== item.summary) patch.summary = s
    setEditing(false)
    if (Object.keys(patch).length > 0) onEdit(patch)
  }

  return (
    <div className="rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit()
                  if (e.key === 'Escape') cancelEdit()
                }}
                className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-sm font-semibold text-white/90 outline-none ring-1 ring-white/15 focus:ring-white/40"
                placeholder="标题"
              />
            ) : (
              <h3 className="text-sm font-semibold text-white/90">{item.title}</h3>
            )}
            {threadCount > 1 && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/55">· {threadCount} 封</span>
            )}
            <PriorityBadge priority={item.priority} />
            {item.sourceProvider && <ProviderBadge ntk={item} />}
          </div>
          {originalSubject && originalSubject !== item.title && (
            <p className="mt-0.5 text-xs text-white/40">{originalSubject}</p>
          )}
        </div>
        {editing ? (
          <div className="flex shrink-0 gap-1">
            <button
              onClick={saveEdit}
              className="rounded bg-emerald-600/80 px-2 py-1 text-xs text-white hover:bg-emerald-600"
            >
              保存
            </button>
            <button
              onClick={cancelEdit}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/55 hover:bg-white/10 hover:text-white/70"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-1">
            <button
              onClick={beginEdit}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/45 hover:bg-white/10 hover:text-white/70"
              title="编辑标题与摘要"
            >
              ✎
            </button>
            <button
              onClick={onDismiss}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/45 hover:bg-white/10 hover:text-white/70"
            >
              忽略
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <textarea
          value={draftSummary}
          onChange={(e) => setDraftSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit()
            if (e.key === 'Escape') cancelEdit()
          }}
          rows={3}
          className="mt-2 w-full resize-y rounded bg-black/30 px-2 py-1 text-sm text-white/70 outline-none ring-1 ring-white/15 focus:ring-white/40"
          placeholder="摘要"
        />
      ) : (
        <p className="mt-2 text-sm text-white/70">{item.summary}</p>
      )}

      {/* Thread expand: lazily fetch the full conversation for context. */}
      {item.threadId && item.sourceProvider && item.sourceAccountId && !editing && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-white/55 hover:text-white/80"
          >
            {expanded ? '▾ 收起线程' : '▸ 展开线程'}
          </button>
          {expanded && (
            <ThreadExpansion
              threadId={item.threadId}
              provider={item.sourceProvider}
              accountId={item.sourceAccountId}
              surfacedIds={surfacedIds}
            />
          )}
        </div>
      )}

      {item.suggestedActions.length > 0 && !editing && (
        <div className="mt-2 text-xs text-white/45">
          建议：{item.suggestedActions.map((a) => a.label).join(' · ')}
        </div>
      )}
    </div>
  )
}

function PriorityBadge({ priority }: { priority: NeedToKnow['priority'] }): ReactElement {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-xs font-medium text-white/80"
      style={{ background: priorityColor(priority) }}
    >
      {TASK_PRIORITY_LABEL[priority]}
    </span>
  )
}

function ProviderBadge({ ntk }: { ntk: NeedToKnow }): ReactElement {
  const label = ntk.sourceProvider ? PROVIDER_LABEL[ntk.sourceProvider] : '邮件'
  // Gmail carries a real per-message deep link; 163 only links to the webmail
  // root (no per-message deep link exists on 163) — honest, not faked.
  if (ntk.sourceLink) {
    return (
      <a
        href={ntk.sourceLink}
        target="_blank"
        rel="noreferrer"
        className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/60 hover:bg-white/10 hover:text-white/80"
        title={ntk.sourceLink}
      >
        {label} ↗
      </a>
    )
  }
  return (
    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-white/50">{label}</span>
  )
}

/** Lazy full-thread context fetch (ADR 0029). Loads on expand only, cached in
 *  local state. On any error / empty result, falls back to listing the surfaced
 *  sourceRefs so the user still sees the 必读 emails even if the provider's
 *  thread fetch is unavailable (163 best-effort). */
function ThreadExpansion({
  threadId,
  provider,
  accountId,
  surfacedIds
}: {
  threadId: string
  provider: 'gmail' | 'mail163'
  accountId: string
  surfacedIds: Set<string>
}): ReactElement {
  const [thread, setThread] = useState<NormalizedEmail[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.daymate
      .getEmailThread({ threadId, provider, accountId })
      .then((msgs) => {
        if (!cancelled) setThread(msgs)
      })
      .catch(() => {
        if (!cancelled) setThread([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [threadId, provider, accountId])

  if (loading) return <p className="mt-1 text-xs text-white/40">正在拉取线程…</p>
  if (!thread || thread.length === 0) {
    // Fallback: show the surfaced 必读 emails only.
    return <p className="mt-1 text-xs text-white/40">无法拉取完整线程（仅显示已必读邮件）。</p>
  }

  return (
    <div className="mt-2 space-y-2 border-l-2 border-white/10 pl-3">
      {thread.map((m, i) => {
        // sourceRef id format is `email:<messageId>`; the surfaced set keys
        // on that. Star the 必读 emails within the full thread context.
        const refId = `email:${m.messageId}`
        const starred = surfacedIds.has(refId)
        return (
          <div key={`${m.messageId}-${i}`} className="text-xs">
            <div className="flex items-center gap-2">
              {starred ? <span className="text-amber-300">★</span> : <span className="text-white/20">·</span>}
              <span className="text-white/60">{m.from.name ?? m.from.address ?? '未知'}</span>
              <span className="text-white/30">{new Date(m.receivedAt).toLocaleString('zh-CN')}</span>
            </div>
            <div className="mt-0.5 font-medium text-white/75">{m.subject}</div>
            {m.textBody && <div className="mt-0.5 line-clamp-2 text-white/45">{m.textBody}</div>}
          </div>
        )
      })}
    </div>
  )
}

function Header(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">必读</h1>
      <p className="mt-1 text-sm text-white/45">各来源信息汇总 · 按线程聚合 · 学校 / 求职 / 日常 / 其他</p>
    </div>
  )
}
