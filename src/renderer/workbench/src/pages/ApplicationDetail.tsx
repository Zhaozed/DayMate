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

      <StatusController view={view} onChanged={onChanged} />

      <RichFields view={view} onChanged={onChanged} />

      <ResumeSection applicationId={applicationId} />

      <PrepSection view={view} onChanged={onChanged} />

      <EventTimeline view={view} onChanged={onChanged} />
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
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-white">
          {view.application.company}
          <span className="text-base font-normal text-white/55">
            {view.application.position}
          </span>
          {view.application.jobCode && (
            <span className="rounded border border-sky-400/30 bg-sky-500/15 px-2 py-0.5 font-mono text-xs text-sky-300">
              #{view.application.jobCode}
            </span>
          )}
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

function StatusController({
  view,
  onChanged
}: {
  view: ApplicationView
  onChanged: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [targetType, setTargetType] = useState<ApplicationEventType>('interview')
  const [round, setRound] = useState('1')
  const [evidence, setEvidence] = useState('')

  const current = view.currentStatus
  const isRejected = current === 'rejected'
  const isOffer = current === 'offer'
  const isInterview = current === 'interview'

  const applyStatus = async (
    type: ApplicationEventType,
    opts?: { round?: number; evidence?: string }
  ): Promise<void> => {
    setBusy(true)
    try {
      await window.daymate.updateApplicationStatus(view.application.id, type, opts)
      setShowCustom(false)
      onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const markRejected = async (): Promise<void> => {
    const reason = window.prompt('确认标记为收到感谢信/已淘汰？可输入备注：', '收到感谢信')
    if (reason === null) return
    await applyStatus('rejected', { evidence: reason.trim() || '收到感谢信' })
  }

  const markOffer = async (): Promise<void> => {
    const note = window.prompt('确认标记为已录用 (Offer)？可输入薪资/备注意见：', '录用通知')
    if (note === null) return
    await applyStatus('offer', { evidence: note.trim() || '已录用' })
  }

  const markInterview = async (): Promise<void> => {
    const roundStr = window.prompt('推进到第几轮面试？请输入数字：', String((view.currentRound || 0) + 1))
    if (roundStr === null) return
    const r = parseInt(roundStr, 10) || 1
    await applyStatus('interview', { round: r, evidence: `${r}面` })
  }

  const badgeStyle = isRejected
    ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 shadow-sm shadow-rose-500/10'
    : isOffer
    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-sm shadow-emerald-500/10'
    : isInterview
    ? 'bg-sky-500/20 border-sky-400/40 text-sky-200 shadow-sm shadow-sky-500/10'
    : 'bg-white/10 border-white/20 text-white/90'

  const currentLabel = isRejected
    ? (view.events.some((e) => /感谢信/i.test(e.evidence || '')) ? '感谢信 · 流程结束' : '已淘汰 · 流程结束')
    : isOffer
    ? '已录用 Offer'
    : isInterview
    ? (view.currentRound ? `${view.currentRound}面进行中` : '面试中')
    : current === 'written_test'
    ? '专业笔试'
    : current === 'assessment'
    ? '在线测评'
    : current === 'applied'
    ? '简历已投递'
    : statusLabel(APPLICATION_EVENT_LABEL, current)

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-[#12151c]/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Current Status Badge & Explanation */}
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-medium text-white/45">当前阶段：</span>
          <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold ${badgeStyle}`}>
            <span className={`h-2 w-2 rounded-full ${isRejected ? 'bg-rose-400' : isOffer ? 'bg-emerald-400' : isInterview ? 'bg-sky-400' : 'bg-white/40'}`} />
            {currentLabel}
          </span>
          {view.application.stage && view.application.stage !== currentLabel && (
            <span className="text-xs text-white/40 font-mono">（业务标签: {view.application.stage}）</span>
          )}
        </div>

        {/* Right: Quick Stage Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {!isRejected ? (
            <button
              onClick={markRejected}
              disabled={busy}
              className="rounded-lg border border-rose-500/30 bg-rose-500/15 hover:bg-rose-500/25 px-3 py-1.5 text-xs font-medium text-rose-300 hover:text-rose-200 transition-all shadow-sm disabled:opacity-50 flex items-center gap-1"
            >
              <span>🛑</span>
              <span>标记为感谢信 / 淘汰</span>
            </button>
          ) : (
            <button
              onClick={() => applyStatus('applied', { evidence: '恢复流程' })}
              disabled={busy}
              className="rounded-lg border border-sky-400/30 bg-sky-500/15 hover:bg-sky-500/25 px-3 py-1.5 text-xs font-medium text-sky-300 hover:text-sky-200 transition-all shadow-sm disabled:opacity-50 flex items-center gap-1"
            >
              <span>🔄</span>
              <span>恢复流程</span>
            </button>
          )}

          {!isInterview && !isOffer && !isRejected && (
            <button
              onClick={markInterview}
              disabled={busy}
              className="rounded-lg border border-sky-400/30 bg-sky-500/15 hover:bg-sky-500/25 px-3 py-1.5 text-xs font-medium text-sky-300 hover:text-sky-200 transition-all shadow-sm disabled:opacity-50 flex items-center gap-1"
            >
              <span>📅</span>
              <span>推进到面试</span>
            </button>
          )}

          {!isOffer && (
            <button
              onClick={markOffer}
              disabled={busy}
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/15 hover:bg-emerald-500/25 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200 transition-all shadow-sm disabled:opacity-50 flex items-center gap-1"
            >
              <span>🎉</span>
              <span>录用 Offer</span>
            </button>
          )}

          <button
            onClick={() => setShowCustom((v) => !v)}
            className="rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:text-white transition-all shadow-sm"
          >
            {showCustom ? '收起调整' : '手动调整状态 ▾'}
          </button>
        </div>
      </div>

      {showCustom && (
        <div className="mt-3.5 grid grid-cols-1 sm:grid-cols-4 gap-2.5 border-t border-white/[0.08] pt-3.5">
          <div>
            <label className="block text-[11px] text-white/40 mb-1">目标阶段</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as ApplicationEventType)}
              className="w-full rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white outline-none focus:border-sky-400/50"
            >
              <option value="applied">简历投递 (applied)</option>
              <option value="assessment">在线测评 (assessment)</option>
              <option value="written_test">专业笔试 (written_test)</option>
              <option value="interview">面试 (interview)</option>
              <option value="offer">录用 (offer)</option>
              <option value="rejected">感谢信 / 淘汰 (rejected)</option>
              <option value="withdrawn">已撤回 / 放弃 (withdrawn)</option>
            </select>
          </div>

          {targetType === 'interview' && (
            <div>
              <label className="block text-[11px] text-white/40 mb-1">面试轮次</label>
              <input
                type="number"
                min={1}
                max={10}
                value={round}
                onChange={(e) => setRound(e.target.value)}
                placeholder="例如: 1"
                className="w-full rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white outline-none focus:border-sky-400/50"
              />
            </div>
          )}

          <div className={targetType === 'interview' ? 'sm:col-span-1' : 'sm:col-span-2'}>
            <label className="block text-[11px] text-white/40 mb-1">进展备注 / 证据依据</label>
            <input
              type="text"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder={targetType === 'rejected' ? '例如: 收到感谢信' : '例如: HR沟通 / 邮件通知'}
              className="w-full rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-xs text-white outline-none focus:border-sky-400/50"
            />
          </div>

          <div className="flex items-end">
            <button
              onClick={() =>
                applyStatus(targetType, {
                  round: targetType === 'interview' ? parseInt(round, 10) || 1 : undefined,
                  evidence: evidence.trim() || undefined
                })
              }
              disabled={busy}
              className="w-full rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 py-1.5 text-xs font-semibold text-sky-200 transition-colors disabled:opacity-50"
            >
              {busy ? '更新中…' : '应用新状态'}
            </button>
          </div>
        </div>
      )}
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
    company: a.company ?? '',
    position: a.position ?? '',
    jobCode: a.jobCode ?? '',
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
  const [jdSuccess, setJdSuccess] = useState<string | null>(null)

  // On-demand JD enrichment: fetch a best-effort JD snippet from the public web
  // (DuckDuckGo HTML) via the `web.fetch_jd` tool using company, position, and jobCode.
  const fetchJd = async (): Promise<void> => {
    setFetchingJd(true)
    setJdErr(null)
    setJdSuccess(null)
    try {
      const res = await window.daymate.fetchJobJd(a.id, {
        company: form.company,
        position: form.position,
        jobCode: form.jobCode
      })
      if (res.jdText) {
        setForm((f) => ({ ...f, jdText: res.jdText! }))
        setSaved(false)
        setJdSuccess('已通过联网搜索获取 JD 片段，请核对保存')
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
      company: a.company ?? '',
      position: a.position ?? '',
      jobCode: a.jobCode ?? '',
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
  }, [a.id, a.company, a.position, a.jobCode, a.city, a.salaryRange, a.stage, a.stageDeadline, a.interviewLink, a.channelRef, a.notes, a.priority, a.jdText])

  // Automatically trigger JD search in the background if the application has no JD text
  useEffect(() => {
    if (!a.jdText && (a.company || a.position) && !fetchingJd) {
      void fetchJd()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, a.jdText])

  const set = (k: keyof typeof form, v: string): void => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveErr(null)
    try {
      const patch: ApplicationUpdateFields = {}
      if (form.company !== (a.company ?? '')) patch.company = form.company || undefined
      if (form.position !== (a.position ?? '')) patch.position = form.position || undefined
      if (form.jobCode !== (a.jobCode ?? '')) patch.jobCode = form.jobCode || undefined
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
          <span className={labelCls}>公司名称</span>
          <input className={inputCls} value={form.company} onChange={(e) => set('company', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>应聘岗位</span>
          <input className={inputCls} value={form.position} onChange={(e) => set('position', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className={labelCls}>岗位编号 (Job Code)</span>
          <input
            className={inputCls}
            placeholder="例如: P102938 / Req-001"
            value={form.jobCode}
            onChange={(e) => set('jobCode', e.target.value)}
          />
        </label>
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
            className="rounded bg-white/5 px-2 py-0.5 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
          >
            {fetchingJd ? '🌐 检索中…' : '🌐 联网搜索 JD'}
          </button>
        </div>
        {jdErr && <div className="mt-1 text-xs text-amber-300/80">{jdErr}</div>}
        {jdSuccess && <div className="mt-1 text-xs text-emerald-300/90">{jdSuccess}</div>}
        <textarea
          className={`${inputCls} mt-1 h-40 w-full resize-y`}
          value={form.jdText}
          onChange={(e) => set('jdText', e.target.value)}
          placeholder="可手动粘贴，或点「🌐 联网搜索 JD」从公开网络检索岗位职责与任职要求"
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
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-white/40">
            我的简历
          </div>
          <div className="text-[11px] text-white/30">支持 PDF / HTML / TXT / Markdown</div>
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
          尚无简历。点击「上传简历」上传你的简历（支持 PDF、HTML、TXT、Markdown），将作为生成逐字稿的底稿。
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
            {current && (current.html.startsWith('data:application/pdf') || current.html.startsWith('JVBERi0')) && (
              <button
                type="button"
                onClick={() => window.daymate.openPdfInSystem(current.html)}
                className="ml-auto flex items-center gap-1.5 rounded bg-sky-500/20 px-2.5 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/30 transition-colors"
                title="在 macOS 系统的预览 (Preview.app) 中打开原件"
              >
                <span>↗</span>
                <span>在系统预览 (Preview) 中打开</span>
              </button>
            )}
          </div>
          {current && (
            (current.html.startsWith('data:application/pdf') || current.html.startsWith('JVBERi0')) ? (
              <div className="mt-2 space-y-2">
                <object
                  data={current.html.startsWith('data:') ? current.html : `data:application/pdf;base64,${current.html}`}
                  type="application/pdf"
                  className="h-[650px] w-full rounded border border-white/10 bg-zinc-900 shadow-inner"
                >
                  <iframe
                    src={current.html.startsWith('data:') ? current.html : `data:application/pdf;base64,${current.html}`}
                    title="简历 PDF 原样预览"
                    className="h-[650px] w-full rounded border-none"
                  >
                    <div className="p-4 text-center text-sm text-zinc-400">
                      无法直接预览 PDF，请点击上方「在系统预览中打开」按钮查看原件。
                    </div>
                  </iframe>
                </object>
              </div>
            ) : (
              <iframe
                srcDoc={current.html}
                sandbox=""
                title="简历预览"
                className="mt-2 h-[480px] w-full rounded border border-white/5 bg-white"
              />
            )
          )}
        </>
      )}
    </div>
  )
}

function PrepSection({
  view,
  onChanged
}: {
  view: ApplicationView
  onChanged: () => void
}): ReactElement {
  const applicationId = view.application.id
  const isSuspendedMissingJd =
    view.application.prepStatus === 'suspended_missing_jd' ||
    (!view.application.jdText && view.events.some((e) => e.type === 'interview'))

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
    if (!view.application.jdText) {
      setGenErr('请先在上方「投递信息」中填入或搜索补充 JD 原文，严禁空缺 JD 盲目生成。')
      return
    }
    setBusy(true)
    setGenErr(null)
    try {
      await window.daymate.generatePrepMaterial(applicationId)
      setSelected('')
      refetch()
      onChanged()
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
          面试逐字稿与备战指南
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '生成中…' : versions.length > 0 ? '重新生成逐字稿' : '生成逐字稿'}
        </button>
      </div>

      {isSuspendedMissingJd && (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 leading-relaxed">
          <div className="font-semibold flex items-center gap-1 text-amber-300">
            <span>⚠️ 岗位 JD 空缺（逐字稿已挂起）</span>
          </div>
          <p className="mt-1 text-white/80">
            该面试已为你自动加入日程待办。为确保逐字稿与面试指南的高命中率（严禁无依据捏造经验），请在上方「投递信息」中粘贴或点击「搜索 JD」补充岗位描述。保存后即可生成深度逐字稿。
          </p>
        </div>
      )}

      {genErr && <div className="mt-2 text-xs text-rose-300/80">{genErr}</div>}
      {loading ? (
        <p className="mt-2 text-sm text-white/45">加载版本…</p>
      ) : error ? (
        <p className="mt-2 text-sm text-rose-300/80">{error.message}</p>
      ) : versions.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">尚无逐字稿。先「上传简历」并完善「JD 原文」后点击「生成逐字稿」。</p>
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

function EventTimeline({
  view,
  onChanged
}: {
  view: ApplicationView
  onChanged: () => void
}): ReactElement {
  const [undoing, setUndoing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addType, setAddType] = useState<ApplicationEventType>('interview')
  const [addRound, setAddRound] = useState('1')
  const [addDate, setAddDate] = useState('')
  const [addEvidence, setAddEvidence] = useState('')
  const [adding, setAdding] = useState(false)

  const undoEvent = async (eventId: string): Promise<void> => {
    if (!window.confirm('确定撤销此邮件事件归并？该邮件将返回待确认列表。')) return
    setUndoing(eventId)
    try {
      await window.daymate.undoEmailEvent(view.application.id, eventId)
      onChanged()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setUndoing(null)
    }
  }

  const deleteEvent = async (eventId: string): Promise<void> => {
    if (!window.confirm('确定删除此事件记录？系统将根据剩余事件自动重新计算当前状态。')) return
    setDeleting(eventId)
    try {
      await window.daymate.deleteApplicationEvent(view.application.id, eventId)
      onChanged()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(null)
    }
  }

  const handleAddEvent = async (): Promise<void> => {
    setAdding(true)
    try {
      await window.daymate.addApplicationEvent({
        applicationId: view.application.id,
        type: addType,
        round: addType === 'interview' ? parseInt(addRound, 10) || 1 : undefined,
        eventAt: addDate ? new Date(addDate).toISOString() : undefined,
        evidence: addEvidence.trim() || undefined,
        locked: true
      })
      setShowAdd(false)
      setAddEvidence('')
      setAddDate('')
      onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  const sourceLabel = (src: 'boss' | 'email' | 'manual'): string => {
    if (src === 'boss') return 'BOSS'
    if (src === 'email') return '邮件'
    return '手动'
  }

  return (
    <div className="mt-6 rounded-xl border border-white/10 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/50">
          事件时间线与流转历史
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 px-2.5 py-1 text-xs text-white/80 hover:text-white transition-colors"
        >
          {showAdd ? '取消添加' : '+ 记录新事件'}
        </button>
      </div>

      {showAdd && (
        <div className="mt-3.5 rounded-lg border border-white/10 bg-black/30 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div>
              <label className="block text-[10px] text-white/40 mb-1">事件类型</label>
              <select
                value={addType}
                onChange={(e) => setAddType(e.target.value as ApplicationEventType)}
                className="w-full rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
              >
                <option value="applied">简历投递</option>
                <option value="assessment">在线测评</option>
                <option value="written_test">专业笔试</option>
                <option value="interview">面试</option>
                <option value="offer">录用 Offer</option>
                <option value="rejected">感谢信 / 淘汰</option>
                <option value="withdrawn">已放弃 / 撤回</option>
              </select>
            </div>
            {addType === 'interview' && (
              <div>
                <label className="block text-[10px] text-white/40 mb-1">轮次</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={addRound}
                  onChange={(e) => setAddRound(e.target.value)}
                  className="w-full rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
                />
              </div>
            )}
            <div>
              <label className="block text-[10px] text-white/40 mb-1">发生日期</label>
              <input
                type="date"
                value={addDate}
                onChange={(e) => setAddDate(e.target.value)}
                className="w-full rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
              />
            </div>
            <div className={addType === 'interview' ? 'sm:col-span-1' : 'sm:col-span-2'}>
              <label className="block text-[10px] text-white/40 mb-1">备注 / 依据</label>
              <input
                type="text"
                placeholder={addType === 'rejected' ? '收到感谢信' : '备注信息'}
                value={addEvidence}
                onChange={(e) => setAddEvidence(e.target.value)}
                className="w-full rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-white outline-none"
              />
            </div>
          </div>
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={handleAddEvent}
              disabled={adding}
              className="rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 px-3 py-1 text-xs font-medium text-sky-200 disabled:opacity-50"
            >
              {adding ? '保存中…' : '保存事件'}
            </button>
          </div>
        </div>
      )}

      {view.events.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">暂无事件。</p>
      ) : (
        <div className="mt-3 space-y-2">
          {view.events.map((e) => {
            const isRej = e.type === 'rejected'
            return (
              <div
                key={e.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 transition-colors ${
                  isRej
                    ? 'border-rose-500/30 bg-rose-500/[0.08]'
                    : e.type === 'offer'
                    ? 'border-emerald-500/30 bg-emerald-500/[0.08]'
                    : 'border-white/[0.06] bg-white/[0.03]'
                }`}
                title={e.evidence}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold ${
                      isRej
                        ? 'bg-rose-500/20 text-rose-300'
                        : e.type === 'offer'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : e.type === 'interview'
                        ? 'bg-sky-500/20 text-sky-200'
                        : 'bg-white/10 text-white/80'
                    }`}
                  >
                    {isRej
                      ? (/感谢信/i.test(e.evidence || '') ? '感谢信' : '已淘汰')
                      : statusLabel(APPLICATION_EVENT_LABEL, e.type as ApplicationEventType)}
                  </span>
                  {e.type === 'interview' && e.round ? (
                    <span className="text-xs text-sky-300/80 font-mono">{e.round}面</span>
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
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">
                    {sourceLabel(e.source)}
                  </span>
                  <span className="text-xs text-white/35 font-mono">
                    {new Date(e.eventAt).toLocaleDateString('zh-CN')}
                  </span>
                  {e.evidence && (
                    <span className="text-xs text-white/60">· {e.evidence}</span>
                  )}
                  {e.locked && (
                    <span className="text-[10px] text-sky-300/60" title="用户锁定的决策节点">
                      [用户确认]
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 ml-auto">
                  {e.source === 'email' && (
                    <button
                      type="button"
                      onClick={() => undoEvent(e.id)}
                      disabled={undoing === e.id}
                      className="rounded bg-white/5 hover:bg-amber-500/20 hover:text-amber-200 px-2 py-0.5 text-xs text-white/45 transition-colors disabled:opacity-50"
                      title="撤销本次归并，将邮件放回待确认列表"
                    >
                      {undoing === e.id ? '撤销中…' : '撤销归并'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteEvent(e.id)}
                    disabled={deleting === e.id}
                    className="rounded bg-white/5 hover:bg-rose-500/20 hover:text-rose-200 px-2 py-0.5 text-xs text-white/45 transition-colors disabled:opacity-50"
                    title="删除此事件记录"
                  >
                    {deleting === e.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
