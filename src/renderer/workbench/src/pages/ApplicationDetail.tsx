import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ApplicationView,
  ApplicationUpdateFields,
  ApplicationPriority,
  ResumeVersion,
  PrepMaterial,
  ApplicationEventType
} from '@shared/types'
import { APPLICATION_PRIORITIES } from '@shared/constants'
import { useAsync } from '../hooks/useAsync'
import { Loading, ErrorState } from '../components/states'
import {
  APPLICATION_SOURCE_LABEL,
  APPLICATION_EVENT_LABEL,
  APPLICATION_PRIORITY_LABEL,
  INTERVIEW_ROLE_LABEL,
  EVENT_SUBSTATE_LABEL,
  statusLabel
} from '../labels'

// Application detail (Spec §4.2/§4.3). Rich fields are inline-editable (Milestone
// E polish): each field is an input; "保存" writes the changed fields via
// updateApplicationFields (R1 local DB write, no approval — §15 only gates
// external writes). The editable actions are "上传简历" (the user's own
// document, trusted §17 — it feeds the 逐字稿 generator) /
// "重新生成逐字稿" (AI) and "移到回收站" (soft-delete). Resume/prep HTML
// previews use <iframe srcDoc sandbox=""> so any injected script in the
// content is neutralized (§17).

export function ApplicationDetail({
  applicationId,
  onBack,
  onChanged
}: {
  applicationId: string
  onBack: () => void
  onChanged: () => void
}): ReactElement {
  // Fetch the single application by listing + find (no single-item IPC).
  const { data, loading, error, refetch } = useAsync<ApplicationView | undefined>(
    async () => {
      const all = await window.daymate.listApplications()
      return all.find((v) => v.application.id === applicationId)
    },
    [applicationId]
  )

  // Keep the view fresh: live funnel updates from main replace the cached view.
  useEffect(() => {
    return window.daymate.onApplicationChanged((views) => {
      const v = views.find((x) => x.application.id === applicationId)
      if (v) refetch()
    })
  }, [applicationId, refetch])

  if (loading) return <Loading label="正在加载投递详情…" />
  if (error) return <ErrorState message={error.message} onRetry={refetch} />
  if (!data) {
    return (
      <ErrorState
        message="未找到该投递记录（可能已移入回收站或归档）。"
        onRetry={onBack}
      />
    )
  }

  const view = data

  return (
    <div>
      <DetailHeader view={view} onBack={onBack} onChanged={onChanged} />

      <RichFields view={view} onChanged={onChanged} />

      <ResumeSection applicationId={applicationId} />

      <PrepSection applicationId={applicationId} />

      <EventTimeline view={view} />
    </div>
  )
}

function DetailHeader({
  view,
  onBack,
  onChanged
}: {
  view: ApplicationView
  onBack: () => void
  onChanged: () => void
}): ReactElement {
  const [deleting, setDeleting] = useState(false)

  const softDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await window.daymate.softDeleteApplication(view.application.id)
      onChanged()
      onBack()
    } catch (e) {
      console.error(e)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <button
          onClick={onBack}
          className="text-xs text-white/45 hover:text-white/70"
        >
          ← 返回列表
        </button>
        <h1 className="mt-1 text-xl font-semibold text-white">
          {view.application.company}
          <span className="ml-2 text-base font-normal text-white/55">
            {view.application.position}
          </span>
        </h1>
        <p className="mt-1 text-sm text-white/45">
          {statusLabel(APPLICATION_SOURCE_LABEL, view.application.source)} · 投递于{' '}
          {new Date(view.application.appliedAt).toLocaleDateString('zh-CN')}
        </p>
      </div>
      <button
        onClick={softDelete}
        disabled={deleting}
        className="rounded bg-white/5 px-3 py-1.5 text-sm text-rose-300/70 hover:bg-white/10 disabled:opacity-50"
      >
        {deleting ? '移除中…' : '移到回收站'}
      </button>
    </div>
  )
}

function RichFields({
  view,
  onChanged
}: {
  view: ApplicationView
  onChanged: () => void
}): ReactElement {
  const a = view.application
  // Local form state, seeded from the application. Saving writes only the
  // fields whose values changed (a minimal patch).
  const [form, setForm] = useState({
    city: a.city ?? '',
    salaryRange: a.salaryRange ?? '',
    stage: a.stage ?? '',
    stageDeadline: a.stageDeadline ? a.stageDeadline.slice(0, 10) : '',
    interviewLink: a.interviewLink ?? '',
    channelRef: a.channelRef ?? '',
    notes: a.notes ?? '',
    priority: (a.priority ?? 'normal') as ApplicationPriority,
    jdText: a.jdText ?? ''
  })
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [fetchingJd, setFetchingJd] = useState(false)
  const [jdErr, setJdErr] = useState<string | null>(null)

  // On-demand JD enrichment (post-MVP): fetch a best-effort JD snippet from the
  // public web via the `web.fetch_jd` tool and fill the textarea. The user
  // reviews before saving — web quality is inconsistent. §17: the fetched text
  // is untrusted; stored as data, rendered sandboxed elsewhere.
  const fetchJd = async (): Promise<void> => {
    setFetchingJd(true)
    setJdErr(null)
    try {
      const res = await window.daymate.fetchJobJd(a.id)
      if (res.jdText) {
        setForm((f) => ({ ...f, jdText: res.jdText! }))
        setSaved(false)
      }
      if (res.error) setJdErr(res.error)
    } catch (e) {
      setJdErr(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchingJd(false)
    }
  }

  // The seed changes when the underlying view is refreshed (e.g. an email-
  // inference event landed a new field). Re-seed the form only when not mid-edit.
  useEffect(() => {
    setForm({
      city: a.city ?? '',
      salaryRange: a.salaryRange ?? '',
      stage: a.stage ?? '',
      stageDeadline: a.stageDeadline ? a.stageDeadline.slice(0, 10) : '',
      interviewLink: a.interviewLink ?? '',
      channelRef: a.channelRef ?? '',
      notes: a.notes ?? '',
      priority: (a.priority ?? 'normal') as ApplicationPriority,
      jdText: a.jdText ?? ''
    })
  }, [a.id, a.city, a.salaryRange, a.stage, a.stageDeadline, a.interviewLink, a.channelRef, a.notes, a.priority, a.jdText])

  const set = (k: keyof typeof form, v: string): void => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveErr(null)
    try {
      const patch: ApplicationUpdateFields = {}
      if (form.city !== (a.city ?? '')) patch.city = form.city || undefined
      if (form.salaryRange !== (a.salaryRange ?? '')) patch.salaryRange = form.salaryRange || undefined
      if (form.stage !== (a.stage ?? '')) patch.stage = form.stage || undefined
      if (form.stageDeadline !== (a.stageDeadline ? a.stageDeadline.slice(0, 10) : '')) {
        patch.stageDeadline = form.stageDeadline ? `${form.stageDeadline}T00:00:00.000Z` : undefined
      }
      if (form.interviewLink !== (a.interviewLink ?? '')) patch.interviewLink = form.interviewLink || undefined
      if (form.channelRef !== (a.channelRef ?? '')) patch.channelRef = form.channelRef || undefined
      if (form.notes !== (a.notes ?? '')) patch.notes = form.notes || undefined
      if (form.priority !== (a.priority ?? 'normal')) patch.priority = form.priority
      if (form.jdText !== (a.jdText ?? '')) patch.jdText = form.jdText || undefined
      if (Object.keys(patch).length === 0) {
        setSaved(true)
        return
      }
      await window.daymate.updateApplicationFields(view.application.id, patch)
      setSaved(true)
      onChanged()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded bg-white/5 px-2 py-1 text-sm text-white/90 outline-none focus:bg-white/10'
  const labelCls = 'text-xs text-white/35'

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/40">
          投递信息
        </div>
        <div className="flex items-center gap-2">
          {saveErr && <span className="text-xs text-rose-300/80">{saveErr}</span>}
          {saved && !saveErr && <span className="text-xs text-emerald-300/70">已保存</span>}
          <button
            onClick={save}
            disabled={saving}
            className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
        <label className="flex flex-col">
          <span className={labelCls}>城市</span>
          <input className={inputCls} value={form.city} onChange={(e) => set('city', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>薪资范围</span>
          <input className={inputCls} value={form.salaryRange} onChange={(e) => set('salaryRange', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>阶段</span>
          <input className={inputCls} value={form.stage} onChange={(e) => set('stage', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>阶段截止</span>
          <input type="date" className={inputCls} value={form.stageDeadline} onChange={(e) => set('stageDeadline', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>面试链接</span>
          <input className={inputCls} value={form.interviewLink} onChange={(e) => set('interviewLink', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>优先级</span>
          <select
            className={inputCls}
            value={form.priority}
            onChange={(e) => set('priority', e.target.value)}
          >
            {APPLICATION_PRIORITIES.map((p) => (
              <option key={p} value={p} className="bg-zinc-800">
                {statusLabel(APPLICATION_PRIORITY_LABEL, p)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>内推/渠道</span>
          <input className={inputCls} value={form.channelRef} onChange={(e) => set('channelRef', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>备注</span>
          <input className={inputCls} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <div className={labelCls}>JD 原文</div>
          <button
            type="button"
            onClick={fetchJd}
            disabled={fetchingJd}
            className="rounded bg-white/5 px-2 py-0.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
          >
            {fetchingJd ? '搜索中…' : '搜索 JD'}
          </button>
        </div>
        {jdErr && <div className="mt-1 text-xs text-amber-300/80">{jdErr}</div>}
        <textarea
          className={`${inputCls} mt-1 h-40 w-full resize-y`}
          value={form.jdText}
          onChange={(e) => set('jdText', e.target.value)}
          placeholder="可手动粘贴，或点「搜索 JD」从公网抓取片段"
        />
      </div>
    </div>
  )
}

function ResumeSection({ applicationId }: { applicationId: string }): ReactElement {
  const { data, loading, error, refetch } = useAsync<ResumeVersion[]>(
    () => window.daymate.listResumeVersions(applicationId),
    [applicationId]
  )
  const [busy, setBusy] = useState(false)
  const [upErr, setUpErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')

  const versions = data ?? []
  // Default to the latest version (highest version number).
  const currentId = selected || (versions.length > 0
    ? [...versions].sort((a, b) => b.version - a.version)[0].id
    : '')
  const current = versions.find((v) => v.id === currentId)

  // Upload the user's OWN resume (trusted §17 — their document). Stored
  // verbatim as a new version; the interview-transcript generator reads the
  // latest resume, so uploading is what feeds 逐字稿 generation. Text formats
  // only (.html/.txt/.md) — PDF binary can't feed the agent or render in the
  // sandbox iframe.
  const upload = async (): Promise<void> => {
    setBusy(true)
    setUpErr(null)
    try {
      const v = await window.daymate.uploadResume(applicationId)
      if (v) {
        setSelected('')
        refetch()
      }
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/40">
          我的简历
        </div>
        <button
          onClick={upload}
          disabled={busy}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '上传中…' : versions.length > 0 ? '重新上传简历' : '上传简历'}
        </button>
      </div>
      {upErr && <div className="mt-2 text-xs text-rose-300/80">{upErr}</div>}
      {loading ? (
        <p className="mt-2 text-sm text-white/45">加载版本…</p>
      ) : error ? (
        <p className="mt-2 text-sm text-rose-300/80">{error.message}</p>
      ) : versions.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">
          尚无简历。点击「上传简历」上传你的简历（.html/.txt/.md），将作为生成逐字稿的底稿。
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={currentId}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
            >
              {[...versions].sort((a, b) => b.version - a.version).map((v) => (
                <option key={v.id} value={v.id} className="bg-zinc-800">
                  v{v.version} · {new Date(v.createdAt).toLocaleString('zh-CN')}
                </option>
              ))}
            </select>
            {current?.modelId && (
              <span className="text-xs text-white/35">{current.modelId}</span>
            )}
          </div>
          {current && (
            <iframe
              srcDoc={current.html}
              sandbox=""
              title="简历预览"
              className="mt-2 h-[480px] w-full rounded border border-white/5 bg-white"
            />
          )}
        </>
      )}
    </div>
  )
}

function PrepSection({ applicationId }: { applicationId: string }): ReactElement {
  const { data, loading, error, refetch } = useAsync<PrepMaterial[]>(
    () => window.daymate.listPrepMaterials(applicationId),
    [applicationId]
  )
  const [busy, setBusy] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')

  const versions = data ?? []
  const currentId = selected || (versions.length > 0
    ? [...versions].sort((a, b) => b.version - a.version)[0].id
    : '')
  const current = versions.find((v) => v.id === currentId)

  const generate = async (): Promise<void> => {
    setBusy(true)
    setGenErr(null)
    try {
      await window.daymate.generatePrepMaterial(applicationId)
      setSelected('')
      refetch()
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/40">
          面试逐字稿
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '生成中…' : versions.length > 0 ? '重新生成逐字稿' : '生成逐字稿'}
        </button>
      </div>
      {genErr && <div className="mt-2 text-xs text-rose-300/80">{genErr}</div>}
      {loading ? (
        <p className="mt-2 text-sm text-white/45">加载版本…</p>
      ) : error ? (
        <p className="mt-2 text-sm text-rose-300/80">{error.message}</p>
      ) : versions.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">尚无逐字稿。先「上传简历」后点击「生成逐字稿」。</p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={currentId}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded bg-white/5 px-2 py-1 text-xs text-white/90 outline-none"
            >
              {[...versions].sort((a, b) => b.version - a.version).map((v) => (
                <option key={v.id} value={v.id} className="bg-zinc-800">
                  v{v.version} · {new Date(v.createdAt).toLocaleString('zh-CN')}
                </option>
              ))}
            </select>
            {current?.modelId && (
              <span className="text-xs text-white/35">{current.modelId}</span>
            )}
          </div>
          {current && (
            <iframe
              srcDoc={current.html}
              sandbox=""
              title="逐字稿预览"
              className="mt-2 h-[480px] w-full rounded border border-white/5 bg-white"
            />
          )}
        </>
      )}
    </div>
  )
}

function EventTimeline({ view }: { view: ApplicationView }): ReactElement {
  const sourceLabel = (src: 'boss' | 'email' | 'manual'): string => {
    if (src === 'boss') return 'BOSS'
    if (src === 'email') return '邮件'
    return '手动'
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide text-white/40">
        事件时间线
      </div>
      {view.events.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">暂无事件。</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {view.events.map((e) => (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-2 rounded bg-white/5 px-2 py-1.5"
              title={e.evidence}
            >
              <span className="text-sm text-white/85">
                {statusLabel(APPLICATION_EVENT_LABEL, e.type as ApplicationEventType)}
              </span>
              {e.type === 'interview' && e.round ? (
                <span className="text-xs text-white/55">{e.round}面</span>
              ) : null}
              {e.type === 'interview' && e.role ? (
                <span className="rounded bg-sky-400/15 px-1.5 text-xs text-sky-200/80">
                  {INTERVIEW_ROLE_LABEL[e.role]}
                </span>
              ) : null}
              {e.subState ? (
                <span className="text-xs text-white/50">
                  · {EVENT_SUBSTATE_LABEL[e.subState]}
                </span>
              ) : null}
              {e.locked && <span className="text-xs text-amber-300/70">🔒</span>}
              <span className="text-xs text-white/40">{sourceLabel(e.source)}</span>
              <span className="text-xs text-white/35">
                {new Date(e.eventAt).toLocaleDateString('zh-CN')}
              </span>
              {e.evidence && (
                <span className="text-xs text-white/45">· {e.evidence}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
