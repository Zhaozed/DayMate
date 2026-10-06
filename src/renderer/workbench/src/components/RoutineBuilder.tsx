import { useState } from 'react'
import type { ReactElement } from 'react'
import type { RoutineDefinition, RoutineStep, RoutineTrigger } from '@shared/types'

// Custom Routine builder (Spec §14). Users assemble a Routine from a
// CONSTRAINED catalog of validated step templates — they cannot insert
// arbitrary code. The backend re-parses with the Routine Schema and refuses
// unknown tools / agent actions, so even a tampered payload cannot escape the
// allow-list (§14 "Users cannot insert arbitrary code"). NL-to-Routine is
// explicitly future work (§14).

// ── Step catalog ───────────────────────────────────────────────────────────
// Each entry produces a valid RoutineStep with sensible defaults. The user only
// fills in identifier strings (output keys, message text) — never code.
interface CatalogEntry {
  key: string
  label: string
  hint: string
  build: (outputKey: string) => RoutineStep
  /** Whether the outputKey field is meaningful for this step. */
  hasOutputKey?: boolean
  /** For steps that reference a prior output (fromKey / template), an inline
   *  hint field lets the user type the reference. */
  refField?: { label: string; placeholder: string }
}

const CATALOG: CatalogEntry[] = [
  {
    key: 'list_emails',
    label: '列出未读邮件',
    hint: 'email.list · 未读，最近 24 小时',
    hasOutputKey: true,
    build: (k) => ({
      id: k || 'emails',
      type: 'tool',
      tool: 'email.list',
      args: { unreadOnly: true, sinceHours: 24, limit: 20 },
      outputKey: k || 'emails',
      continueOnError: true
    })
  },
  {
    key: 'list_calendar',
    label: '列出今日日历',
    hint: 'calendar.list · 今天',
    hasOutputKey: true,
    build: (k) => ({
      id: k || 'events',
      type: 'tool',
      tool: 'calendar.list',
      args: { range: 'today' },
      outputKey: k || 'events',
      continueOnError: true
    })
  },
  {
    key: 'list_tasks',
    label: '列出任务',
    hint: 'task.list',
    hasOutputKey: true,
    build: (k) => ({
      id: k || 'tasks',
      type: 'tool',
      tool: 'task.list',
      args: {},
      outputKey: k || 'tasks',
      continueOnError: true
    })
  },
  {
    key: 'funnel_review',
    label: '求职复盘分析',
    hint: 'agent · generate_funnel_review',
    hasOutputKey: true,
    build: (k) => ({
      id: k || 'review',
      type: 'agent',
      action: 'generate_funnel_review',
      inputs: {},
      outputKey: k || 'review'
    })
  },
  {
    key: 'publish_ntk',
    label: '发布动态',
    hint: 'need_to_know · 来自某个 agent 输出',
    refField: { label: '来源输出键', placeholder: 'review' },
    build: () => ({
      id: 'publish',
      type: 'need_to_know',
      fromKey: 'review'
    })
  },
  {
    key: 'notify',
    label: '通知机器人',
    hint: 'notify · desktop_robot',
    refField: { label: '消息', placeholder: '{{brief.title}}' },
    build: () => ({
      id: 'notify',
      type: 'notify',
      channel: 'desktop_robot' as const,
      message: '{{brief.title}}'
    })
  }
]

type DraftStep = { uid: string; entry: CatalogEntry; outputKey: string; ref: string }

let uidCounter = 0
function newUid(): string {
  uidCounter += 1
  return `s${uidCounter}`
}

export function RoutineBuilder({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (r: RoutineDefinition) => void
}): ReactElement {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [triggerType, setTriggerType] = useState<RoutineTrigger['type']>('manual')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [intervalMinutes, setIntervalMinutes] = useState(10)
  const [minutesBefore, setMinutesBefore] = useState(15)
  const [steps, setSteps] = useState<DraftStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const addStep = (entry: CatalogEntry): void => {
    setSteps((prev) => [
      ...prev,
      {
        uid: newUid(),
        entry,
        outputKey: entry.hasOutputKey ? entry.key : '',
        ref: ''
      }
    ])
  }

  const removeStep = (uid: string): void => {
    setSteps((prev) => prev.filter((s) => s.uid !== uid))
  }
  const moveStep = (uid: string, dir: -1 | 1): void => {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.uid === uid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const buildTrigger = (): RoutineTrigger => {
    switch (triggerType) {
      case 'manual':
        return { type: 'manual' }
      case 'schedule':
        return { type: 'schedule', cron, timezone }
      case 'email_poll':
        return { type: 'email_poll', intervalMinutes }
      case 'calendar_before':
        return { type: 'calendar_before', minutesBefore }
      // application_status is a preset-only trigger (not builder-selectable);
      // unreachable here, but the switch must be exhaustive over the type union.
      default:
        return { type: 'manual' }
    }
  }

  const buildSteps = (): RoutineStep[] =>
    steps.map((s) => {
      const base = s.entry.build(s.outputKey)
      if (s.entry.key === 'publish_ntk' && s.ref) (base as { fromKey?: string }).fromKey = s.ref
      if (s.entry.key === 'notify' && s.ref) (base as { message?: string }).message = s.ref
      return base
    })

  const buildDef = (): Omit<RoutineDefinition, 'createdAt' | 'updatedAt'> => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom_' + newUid()
    return {
      id,
      name: name.trim() || '未命名例程',
      description: description.trim() || '自定义例程',
      version: 1,
      enabled: true,
      trigger: buildTrigger(),
      inputs: {},
      steps: buildSteps(),
      approvalPolicy: 'writes_only',
      output: 'need_to_know'
    }
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('请给例程起个名字。')
      return
    }
    if (steps.length === 0) {
      setError('请至少添加一个步骤。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await window.daymate.createRoutine(buildDef())
      onCreated(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/10 p-5" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white/90">新建自定义例程</div>
        <button onClick={onClose} className="rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
          关闭
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs text-white/50">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的分诊"
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="text-xs text-white/50">
          描述
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="列出未读邮件然后通知"
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-white/50">
          触发方式
          <select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as RoutineTrigger['type'])}
            className="ml-2 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          >
            <option value="manual">手动</option>
            <option value="schedule">定时（cron）</option>
            <option value="email_poll">邮件轮询</option>
            <option value="calendar_before">会议提前</option>
          </select>
        </label>
        {triggerType === 'schedule' && (
          <>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="w-40 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-40 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </>
        )}
        {triggerType === 'email_poll' && (
          <input
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            className="w-24 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        )}
        {triggerType === 'calendar_before' && (
          <input
            type="number"
            min={1}
            value={minutesBefore}
            onChange={(e) => setMinutesBefore(Number(e.target.value))}
            className="w-24 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        )}
      </div>

      {/* Step catalog */}
      <div className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/40">添加步骤</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {CATALOG.map((c) => (
            <button
              key={c.key}
              onClick={() => addStep(c)}
              className="rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
              title={c.hint}
            >
              + {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Ordered steps */}
      {steps.length > 0 && (
        <ol className="mt-3 space-y-2">
          {steps.map((s, i) => (
            <li
              key={s.uid}
              className="flex items-center gap-2 rounded border border-white/5 bg-black/20 px-3 py-2"
            >
              <span className="text-xs font-mono text-white/30">{i + 1}.</span>
              <div className="flex-1">
                <div className="text-sm text-white/85">{s.entry.label}</div>
                <div className="text-xs text-white/35">{s.entry.hint}</div>
              </div>
              {s.entry.hasOutputKey && (
                <input
                  value={s.outputKey}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((x) => (x.uid === s.uid ? { ...x, outputKey: e.target.value } : x)))
                  }
                  placeholder="输出键"
                  className="w-28 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white/90"
                />
              )}
              {s.entry.refField && (
                <input
                  value={s.ref}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((x) => (x.uid === s.uid ? { ...x, ref: e.target.value } : x)))
                  }
                  placeholder={s.entry.refField.placeholder}
                  className="w-36 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white/90"
                />
              )}
              <button onClick={() => moveStep(s.uid, -1)} className="rounded bg-white/5 px-1.5 py-1 text-xs text-white/50 hover:bg-white/10">
                ↑
              </button>
              <button onClick={() => moveStep(s.uid, 1)} className="rounded bg-white/5 px-1.5 py-1 text-xs text-white/50 hover:bg-white/10">
                ↓
              </button>
              <button onClick={() => removeStep(s.uid)} className="rounded bg-white/5 px-1.5 py-1 text-xs text-rose-300/70 hover:bg-white/10">
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}

      {error && <div className="mt-3 text-xs text-rose-300/80">{error}</div>}

      <div className="mt-4 flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy ? '创建中…' : '创建例程'}
        </button>
        <button onClick={onClose} className="rounded bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:bg-white/10">
          取消
        </button>
      </div>
      <p className="mt-3 text-xs text-white/30">
        步骤均取自固定的允许清单；后端会对每个工具 / agent 动作重新校验。无法插入任意代码（Spec §14）。
      </p>
    </div>
  )
}
