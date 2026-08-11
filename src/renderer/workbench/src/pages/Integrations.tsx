import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  LlmConfig,
  LlmProvider,
  LlmTestResult,
  GmailStatus,
  GmailTestResult,
  Mail163Status,
  Mail163TestResult,
  FeishuStatus,
  FeishuTestResult,
  IntegrationStatus,
  JobSearchSettings,
  JobIntent,
  NotificationPrefs,
  NotificationCategory,
  RoutineDefinition,
  BirthData
} from '@shared/types'
import { NOTIFICATION_CATEGORIES } from '@shared/types'
import { LLM_PROVIDERS, DEFAULT_LLM_MODEL_IDS } from '@shared/constants'
import { INTEGRATION_STATUS_LABEL, NOTIFICATION_CATEGORY_LABEL, statusLabel } from '../labels'

// Integrations & settings (Spec §18 + Milestone D). The Gmail card drives the
// real OAuth flow (client_id/secret → SecretStore; Connect opens the browser
// loopback flow; Test lists one real message). The 163 card drives real
// IMAP/SMTP via the mailbox 授权码. The Feishu card drives real calendar read
// via user OAuth. The Milestone D cards add: job-search config, notification
// preferences, and 投递 data export.
const MOCK_ACCOUNTS: { provider: string; displayName: string; email: string; status: string }[] = []

export function IntegrationsPage(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">集成与设置</h1>
      <p className="mt-1 text-sm text-white/45">已连接的账户、提供方与应用设置。</p>

      <div className="mt-6 space-y-2">
        {MOCK_ACCOUNTS.map((a) => (
          <div
            key={a.provider}
            className="flex items-center gap-3 rounded-lg border border-white/5 p-3"
            style={{ background: 'var(--dm-panel)' }}
          >
            <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-xs text-emerald-200">{a.status}</span>
            <div className="flex-1">
              <div className="text-sm text-white/90">{a.displayName}</div>
              <div className="text-xs text-white/40">{a.email}</div>
            </div>
            <span className="text-xs text-white/40">{a.provider}</span>
          </div>
        ))}
      </div>

      <GmailCard />
      <Mail163Card />
      <FeishuCard />
      <LlmCard />
      <JobSearchCard />
      <BirthDataCard />
      <NotificationPrefsCard />
      <DataExportCard />

      <div className="mt-6 rounded-lg border border-amber-500/20 p-4" style={{ background: 'rgba(120,80,0,0.08)' }}>
        <h2 className="text-sm font-semibold text-amber-200/90">说明</h2>
        <p className="mt-1 text-xs text-white/55">
          Daymate 绝不硬编码令牌，绝不向渲染进程暴露令牌；并且（对于 LLM 密钥）保存后不再回读。日历创建/更新（R2 写入）已推迟——这些集成为只读。通知偏好与求职意向为非密设置，持久于本地 settings.json。
        </p>
      </div>
    </div>
  )
}

function statusBadge(status: IntegrationStatus | undefined): string {
  return status ? statusLabel(INTEGRATION_STATUS_LABEL, status) : '…'
}

function GmailCard(): ReactElement {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [test, setTest] = useState<GmailTestResult | null>(null)
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | 'test' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await window.daymate.getGmailStatus())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const saveClient = async (): Promise<void> => {
    if (!clientId || !clientSecret) return
    setBusy('save')
    setActionError(null)
    try {
      setStatus(await window.daymate.setGmailClient({ clientId, clientSecret }))
      setClientId('')
      setClientSecret('')
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy('connect')
    setActionError(null)
    try {
      setStatus(await window.daymate.connectGmail())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setActionError(null)
    try {
      setStatus(await window.daymate.disconnectGmail())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setActionError(null)
    try {
      setTest(await window.daymate.testGmail())
    } finally {
      setBusy(null)
    }
  }

  const connected = status?.status === 'connected'

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/90">Gmail</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${connected ? 'bg-emerald-900/60 text-emerald-200' : 'bg-white/5 text-white/45'}`}
        >
          {statusBadge(status?.status)}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/45">
        通过 OAuth 2.0 连接真实 Gmail（读取 + 撰写）。在 Google Cloud Console 创建一个 OAuth Desktop 客户端，把
        client_id/secret 粘贴到此处，再点击连接。凭证加密存储（钥匙串），且永不回显。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载 Gmail 状态：{loadError}
        </div>
      )}
      {actionError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          {actionError}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-white/50">OAuth 客户端 ID</span>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={status?.hasClient ? '•••（已设置 — 留空则保持不变）' : 'xxxxxxxx.apps.googleusercontent.com'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="block">
          <span className="text-xs text-white/50">OAuth 客户端密钥</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={status?.hasClient ? '••••••（永不回显）' : 'GOCSPX-…'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={saveClient}
          disabled={busy !== null || !clientId || !clientSecret}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'save' ? '保存中…' : '保存凭证'}
        </button>
        <button
          onClick={connect}
          disabled={busy !== null || !status?.hasClient || connected}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'connect' ? '连接中…' : '连接'}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'disconnect' ? '断开中…' : '断开'}
        </button>
        <button
          onClick={runTest}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
      </div>

      {status?.email && connected && (
        <div className="mt-3 text-xs text-white/55">已连接为 <span className="text-white/80">{status.email}</span></div>
      )}
      {test ? (
        <div
          className={`mt-3 rounded p-2 text-xs ${test.ok ? 'text-emerald-200' : 'text-rose-200'}`}
          style={{ background: test.ok ? 'rgba(0,120,80,0.12)' : 'rgba(120,0,40,0.12)' }}
        >
          {test.ok ? '✓' : '✗'} {test.message}
        </div>
      ) : null}
    </div>
  )
}

function Mail163Card(): ReactElement {
  const [status, setStatus] = useState<Mail163Status | null>(null)
  const [email, setEmail] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [test, setTest] = useState<Mail163TestResult | null>(null)
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | 'test' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await window.daymate.getMail163Status())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const saveClient = async (): Promise<void> => {
    if (!email || !authCode) return
    setBusy('save')
    setActionError(null)
    try {
      setStatus(await window.daymate.setMail163Client({ email, authCode }))
      setEmail('')
      setAuthCode('')
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy('connect')
    setActionError(null)
    try {
      setStatus(await window.daymate.connectMail163())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setActionError(null)
    try {
      setStatus(await window.daymate.disconnectMail163())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setActionError(null)
    try {
      setTest(await window.daymate.testMail163())
    } finally {
      setBusy(null)
    }
  }

  const connected = status?.status === 'connected'

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/90">163 邮箱</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${connected ? 'bg-emerald-900/60 text-emerald-200' : 'bg-white/5 text-white/45'}`}
        >
          {statusBadge(status?.status)}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/45">
        通过 IMAP（读取）+ SMTP（发送）连接真实 163 邮箱。先在 163 设置中开启 IMAP/SMTP 并生成授权码
        （不是登录密码），再把邮箱与授权码粘贴到此处。授权码加密存储（钥匙串），且永不回显。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载 163 状态：{loadError}
        </div>
      )}
      {actionError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          {actionError}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-white/50">163 邮箱</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={status?.email ?? 'you@163.com'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="block">
          <span className="text-xs text-white/50">授权码</span>
          <input
            type="password"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            placeholder={status?.hasClient ? '••••••（永不回显）' : '16 位授权码（来自 163 设置）'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={saveClient}
          disabled={busy !== null || !email || !authCode}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'save' ? '保存中…' : '保存授权码'}
        </button>
        <button
          onClick={connect}
          disabled={busy !== null || !status?.hasClient || connected}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'connect' ? '连接中…' : '连接'}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'disconnect' ? '断开中…' : '断开'}
        </button>
        <button
          onClick={runTest}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
      </div>

      {status?.email && connected && (
        <div className="mt-3 text-xs text-white/55">已连接为 <span className="text-white/80">{status.email}</span></div>
      )}
      {test ? (
        <div
          className={`mt-3 rounded p-2 text-xs ${test.ok ? 'text-emerald-200' : 'text-rose-200'}`}
          style={{ background: test.ok ? 'rgba(0,120,80,0.12)' : 'rgba(120,0,40,0.12)' }}
        >
          {test.ok ? '✓' : '✗'} {test.message}
        </div>
      ) : null}
    </div>
  )
}

function FeishuCard(): ReactElement {
  const [status, setStatus] = useState<FeishuStatus | null>(null)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [test, setTest] = useState<FeishuTestResult | null>(null)
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | 'test' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await window.daymate.getFeishuStatus())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const saveClient = async (): Promise<void> => {
    if (!appId || !appSecret) return
    setBusy('save')
    setActionError(null)
    try {
      setStatus(await window.daymate.setFeishuClient({ appId, appSecret }))
      setAppId('')
      setAppSecret('')
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy('connect')
    setActionError(null)
    try {
      setStatus(await window.daymate.connectFeishu())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setActionError(null)
    try {
      setStatus(await window.daymate.disconnectFeishu())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setActionError(null)
    try {
      setTest(await window.daymate.testFeishu())
    } finally {
      setBusy(null)
    }
  }

  const connected = status?.status === 'connected'

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/90">飞书日历</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${connected ? 'bg-emerald-900/60 text-emerald-200' : 'bg-white/5 text-white/45'}`}
        >
          {statusBadge(status?.status)}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/45">
        通过用户 OAuth 连接真实飞书日历（只读）。在飞书开放平台创建一个自建应用，开启日历权限，并注册
        <code>http://127.0.0.1:12700/callback</code> 作为回调地址。把 app_id/app_secret 粘贴到此处，再点击连接
        （会打开浏览器授权）。凭证加密存储（钥匙串），且永不回显。日历创建/更新已推迟（只读）。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载飞书状态：{loadError}
        </div>
      )}
      {actionError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          {actionError}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-white/50">应用 ID</span>
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder={status?.hasClient ? 'cli_••••（已设置 — 留空则保持不变）' : 'cli_xxxxxxxxxxxx'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="block">
          <span className="text-xs text-white/50">应用密钥</span>
          <input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={status?.hasClient ? '••••••（永不回显）' : '飞书控制台的应用密钥'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={saveClient}
          disabled={busy !== null || !appId || !appSecret}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'save' ? '保存中…' : '保存应用'}
        </button>
        <button
          onClick={connect}
          disabled={busy !== null || !status?.hasClient || connected}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'connect' ? '连接中…' : '连接'}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'disconnect' ? '断开中…' : '断开'}
        </button>
        <button
          onClick={runTest}
          disabled={busy !== null || !connected}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
      </div>

      {test ? (
        <div
          className={`mt-3 rounded p-2 text-xs ${test.ok ? 'text-emerald-200' : 'text-rose-200'}`}
          style={{ background: test.ok ? 'rgba(0,120,80,0.12)' : 'rgba(120,0,40,0.12)' }}
        >
          {test.ok ? '✓' : '✗'} {test.message}
          {test.sampleEventTitle ? ` — 首条：「${test.sampleEventTitle}」` : ''}
        </div>
      ) : null}
    </div>
  )
}

function LlmCard(): ReactElement {
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [provider, setProvider] = useState<LlmProvider>('anthropic')
  const [modelId, setModelId] = useState<string>(DEFAULT_LLM_MODEL_IDS.anthropic)
  const [key, setKey] = useState('')
  const [test, setTest] = useState<LlmTestResult | null>(null)
  const [busy, setBusy] = useState<'save' | 'delete' | 'test' | 'config' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const c = await window.daymate.getLlmConfig()
      setConfig(c)
      setProvider(c.provider)
      setModelId(c.modelId)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const onProviderChange = (next: LlmProvider): void => {
    setProvider(next)
    // Reset model id to that provider's default when switching.
    setModelId(DEFAULT_LLM_MODEL_IDS[next])
  }

  const saveConfig = async (): Promise<void> => {
    setBusy('config')
    try {
      const c = await window.daymate.setLlmConfig({ provider, modelId })
      setConfig(c)
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!key) return
    setBusy('save')
    try {
      // Persist provider/model first so the key lands under the right one, then
      // save the key; the final config (with keyConfigured) comes from setLlmKey.
      await window.daymate.setLlmConfig({ provider, modelId })
      setConfig(await window.daymate.setLlmKey(key))
      setKey('') // never retain the key in component state
    } finally {
      setBusy(null)
    }
  }

  const deleteKey = async (): Promise<void> => {
    setBusy('delete')
    try {
      setConfig(await window.daymate.deleteLlmKey())
      setTest(null)
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setBusy('test')
    try {
      setTest(await window.daymate.testLlm())
    } finally {
      setBusy(null)
    }
  }

  const keyConfigured = config?.keyConfigured ?? false

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/90">智能助手 LLM</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${keyConfigured ? 'bg-emerald-900/60 text-emerald-200' : 'bg-white/5 text-white/45'}`}
        >
          {keyConfigured ? '已设置密钥' : '未设置密钥'}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/45">
        设置密钥后，智能步骤在真实模型上运行；未设置时运行确定性桩（无凭证默认）。密钥加密存储，且为只写——
        保存后此处不再回显。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载 LLM 配置：{loadError}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-white/50">提供方</span>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-white/50">模型 ID</span>
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-3">
        <span className="text-xs text-white/50">API 密钥{keyConfigured ? '（已设置 — 留空则保持不变）' : ''}</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={keyConfigured ? '••••••（永不回显）' : '粘贴密钥，然后点击保存密钥'}
          className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={saveConfig}
          disabled={busy !== null}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'config' ? '保存中…' : '保存配置'}
        </button>
        <button
          onClick={saveKey}
          disabled={busy !== null || !key}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy === 'save' ? '保存中…' : '保存密钥'}
        </button>
        <button
          onClick={deleteKey}
          disabled={busy !== null || !keyConfigured}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'delete' ? '删除中…' : '删除密钥'}
        </button>
        <button
          onClick={runTest}
          disabled={busy !== null || !keyConfigured}
          className="rounded bg-white/5 px-3 py-1 text-xs text-white/60 disabled:opacity-50"
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
      </div>

      {test ? (
        <div
          className={`mt-3 rounded p-2 text-xs ${test.ok ? 'text-emerald-200' : 'text-rose-200'}`}
          style={{ background: test.ok ? 'rgba(0,120,80,0.12)' : 'rgba(120,0,40,0.12)' }}
        >
          {test.ok ? '✓' : '✗'} {test.message}
        </div>
      ) : null}
    </div>
  )
}

// ── Milestone D §D1 — job-search config (non-secret paths + jobIntent) ──
// Reuses the same getJobSearchConfig/setJobSearchConfig IPC the 投递 page's
// inline jobIntent editor uses — both surfaces read/write the same settings,
// so editing here is reflected there and vice versa.
function JobSearchCard(): ReactElement {
  const [cfg, setCfg] = useState<JobSearchSettings | null>(null)
  const [baseResumePath, setBaseResumePath] = useState('')
  const [transcriptTemplatePath, setTranscriptTemplatePath] = useState('')
  const [intent, setIntent] = useState<JobIntent>({ keyword: '' })
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const c = await window.daymate.getJobSearchConfig()
      setCfg(c)
      setBaseResumePath(c.baseResumePath ?? '')
      setTranscriptTemplatePath(c.transcriptTemplatePath ?? '')
      setIntent(c.jobIntent ?? { keyword: '' })
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    setSaved(null)
    try {
      const next: JobSearchSettings = {
        ...(baseResumePath ? { baseResumePath } : {}),
        ...(transcriptTemplatePath ? { transcriptTemplatePath } : {}),
        jobIntent: intent.keyword.trim() ? intent : undefined
      }
      const c = await window.daymate.setJobSearchConfig(next)
      setCfg(c)
      setSaved('已保存')
    } catch (e) {
      setSaved(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <h2 className="text-sm font-semibold text-white/90">求职设置</h2>
      <p className="mt-1 text-xs text-white/45">
        基础简历路径（生成定制简历时作为底稿，可信 §17）与求职意向（岗位推荐评分依据）。非密设置，本地持久。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载：{loadError}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3">
        <label className="block">
          <span className="text-xs text-white/50">基础简历路径（绝对路径，可选）</span>
          <input
            value={baseResumePath}
            onChange={(e) => setBaseResumePath(e.target.value)}
            placeholder={cfg?.baseResumePath ?? '/Users/you/简历/base.html'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="block">
          <span className="text-xs text-white/50">逐字稿模板路径（可选）</span>
          <input
            value={transcriptTemplatePath}
            onChange={(e) => setTranscriptTemplatePath(e.target.value)}
            placeholder={cfg?.transcriptTemplatePath ?? '/Users/you/面经/template.html'}
            className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
      </div>

      <div className="mt-4 rounded border border-white/5 p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
        <div className="text-xs font-medium text-white/70">求职意向（岗位推荐评分依据）</div>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="text-xs text-white/50">关键词</span>
            <input
              value={intent.keyword}
              onChange={(e) => setIntent({ ...intent, keyword: e.target.value })}
              placeholder="Go 后端"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-white/50">期望城市（逗号分隔）</span>
            <input
              value={(intent.cities ?? []).join(',')}
              onChange={(e) =>
                setIntent({
                  ...intent,
                  cities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                })
              }
              placeholder="北京, 上海"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="block">
            <span className="text-xs text-white/50">最低月薪（K）</span>
            <input
              type="number"
              value={intent.salaryMin ?? ''}
              onChange={(e) =>
                setIntent({ ...intent, salaryMin: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="25"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="block">
            <span className="text-xs text-white/50">最高月薪（K）</span>
            <input
              type="number"
              value={intent.salaryMax ?? ''}
              onChange={(e) =>
                setIntent({ ...intent, salaryMax: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="40"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="block">
            <span className="text-xs text-white/50">经验（可选）</span>
            <input
              value={intent.experience ?? ''}
              onChange={(e) => setIntent({ ...intent, experience: e.target.value || undefined })}
              placeholder="3-5年"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="block">
            <span className="text-xs text-white/50">学历（可选）</span>
            <input
              value={intent.degree ?? ''}
              onChange={(e) => setIntent({ ...intent, degree: e.target.value || undefined })}
              placeholder="本科"
              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
        {saved && <span className="text-xs text-white/55">{saved}</span>}
      </div>
    </div>
  )
}

// ── Milestone D §D2 — notification preferences ──
// ── Milestone E — birth data for the daily 运势 (non-secret settings.json) ──
function BirthDataCard(): ReactElement {
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined) // undefined = loading
  const [form, setForm] = useState<BirthData>({ year: 2000, month: 1, day: 1 })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const b = await window.daymate.getBirthData()
      setBirth(b ?? null)
      if (b) setForm(b)
      setMsg(null)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await window.daymate.setBirthData(form)
      setBirth(form)
      setMsg('已保存。每日 08:17 将推送一条运势气泡。')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await window.daymate.clearBirthData()
      setBirth(null)
      setMsg('已清除。运势将退回到按日期生成的通用版本。')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90'

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <h2 className="text-sm font-semibold text-white/90">生辰信息（每日运势）</h2>
      <p className="mt-1 text-xs text-white/45">
        用于个性化每日运势气泡。数据为非密设置，仅存于本地 settings.json，不上传任何外部服务。
      </p>

      {msg && (
        <div className="mt-3 rounded border border-white/10 p-2 text-xs text-white/70" style={{ background: 'rgba(0,0,0,0.2)' }}>
          {msg}
        </div>
      )}

      <div className="mt-3 grid grid-cols-4 gap-2">
        <label className="flex flex-col">
          <span className="text-xs text-white/45">出生年</span>
          <input
            type="number"
            min={1900}
            max={2100}
            className={inputCls}
            value={form.year}
            onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))}
            disabled={busy}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-white/45">月</span>
          <input
            type="number"
            min={1}
            max={12}
            className={inputCls}
            value={form.month}
            onChange={(e) => setForm((f) => ({ ...f, month: Number(e.target.value) }))}
            disabled={busy}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-white/45">日</span>
          <input
            type="number"
            min={1}
            max={31}
            className={inputCls}
            value={form.day}
            onChange={(e) => setForm((f) => ({ ...f, day: Number(e.target.value) }))}
            disabled={busy}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-white/45">时辰（可选）</span>
          <input
            type="number"
            min={0}
            max={23}
            placeholder="—"
            className={inputCls}
            value={form.hour ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? undefined : Number(e.target.value)
              setForm((f) => {
                const next = { ...f }
                if (v === undefined) delete next.hour
                else next.hour = v
                return next
              })
            }}
            disabled={busy}
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <label className="text-xs text-white/45">性别（可选）</label>
        <select
          className={inputCls}
          value={form.gender ?? ''}
          onChange={(e) => {
            const v = e.target.value as '' | 'male' | 'female'
            setForm((f) => {
              const next = { ...f }
              if (v === '') delete next.gender
              else next.gender = v
              return next
            })
          }}
          disabled={busy}
        >
          <option value="" className="bg-zinc-800">不指定</option>
          <option value="male" className="bg-zinc-800">男</option>
          <option value="female" className="bg-zinc-800">女</option>
        </select>
        {birth && (
          <span className="text-xs text-emerald-300/60">已配置（属{zodiacOf(birth.year)}）</span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded bg-white/10 px-3 py-1.5 text-sm text-white/90 hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存'}
        </button>
        {birth && (
          <button
            onClick={clear}
            disabled={busy}
            className="rounded bg-white/5 px-3 py-1.5 text-sm text-rose-300/70 hover:bg-white/10 disabled:opacity-50"
          >
            清除
          </button>
        )}
      </div>
    </div>
  )
}

/** 生肖 derived from birth year (mirrors the agent-runtime stub). */
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']
function zodiacOf(year: number): string {
  return ZODIAC[((year - 1900) % 12 + 12) % 12]
}

function NotificationPrefsCard(): ReactElement {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setPrefs(await window.daymate.getNotificationPrefs())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const persist = async (next: NotificationPrefs): Promise<void> => {
    setBusy(true)
    setSaved(null)
    try {
      const savedPrefs = await window.daymate.setNotificationPrefs(next)
      setPrefs(savedPrefs)
      setSaved('已保存')
    } catch (e) {
      setSaved(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // local form state mirrored from prefs (independent inputs)
  const nativeEnabled = prefs?.nativeEnabled ?? true
  const qh = prefs?.quietHours
  const cats = prefs?.categories ?? {}

  const toggleNative = (): void => {
    void persist({ ...(prefs ?? {}), nativeEnabled: !nativeEnabled })
  }
  const toggleCategory = (c: NotificationCategory): void => {
    const nowOn = cats[c] ?? true
    void persist({
      ...(prefs ?? {}),
      categories: { ...cats, [c]: !nowOn }
    })
  }
  const setQuiet = (enabled: boolean): void => {
    void persist({
      ...(prefs ?? {}),
      quietHours: { enabled, start: qh?.start ?? '22:00', end: qh?.end ?? '07:00' }
    })
  }
  const setQuietTime = (field: 'start' | 'end', value: string): void => {
    if (!qh) return
    void persist({ ...(prefs ?? {}), quietHours: { ...qh, [field]: value } })
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <h2 className="text-sm font-semibold text-white/90">通知设置</h2>
      <p className="mt-1 text-xs text-white/45">
        控制机器人气泡与 macOS 通知中心弹窗。免打扰时段仅抑制系统弹窗（应用内气泡保留）。
      </p>

      {loadError && (
        <div className="mt-3 rounded border border-rose-500/20 p-2 text-xs text-rose-200" style={{ background: 'rgba(120,0,40,0.08)' }}>
          无法加载：{loadError}
        </div>
      )}

      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm text-white/85">
          <input type="checkbox" checked={nativeEnabled} onChange={toggleNative} disabled={busy} />
          系统通知中心弹窗（关闭后仅保留应用内机器人气泡）
        </label>
      </div>

      <div className="mt-3 rounded border border-white/5 p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
        <label className="flex items-center gap-2 text-sm text-white/85">
          <input
            type="checkbox"
            checked={qh?.enabled === true}
            onChange={(e) => setQuiet(e.target.checked)}
            disabled={busy}
          />
          免打扰时段（仅抑制系统弹窗）
        </label>
        {qh?.enabled && (
          <div className="mt-2 flex items-center gap-3 text-xs text-white/70">
            <span>从</span>
            <input
              type="time"
              value={qh.start}
              onChange={(e) => setQuietTime('start', e.target.value)}
              disabled={busy}
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
            <span>到</span>
            <input
              type="time"
              value={qh.end}
              onChange={(e) => setQuietTime('end', e.target.value)}
              disabled={busy}
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-white/90"
            />
            <span className="text-white/40">（结束早于开始 = 跨夜）</span>
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="text-xs text-white/50">按类别开关（关闭后完全静音该类别）</div>
        <div className="mt-2 space-y-2">
          {NOTIFICATION_CATEGORIES.map((c) => {
            const on = cats[c] ?? true
            return (
              <label key={c} className="flex items-center gap-2 text-sm text-white/85">
                <input type="checkbox" checked={on} onChange={() => toggleCategory(c)} disabled={busy} />
                {NOTIFICATION_CATEGORY_LABEL[c] ?? c}
              </label>
            )
          })}
        </div>
      </div>

      <RoutineNotifyToggles prefs={prefs ?? {}} busy={busy} persist={persist} />

      <div className="mt-3 flex items-center gap-3">
        {busy && <span className="text-xs text-white/45">保存中…</span>}
        {saved && <span className="text-xs text-white/55">{saved}</span>}
      </div>
    </div>
  )
}

// ── Milestone E polish — per-routine notification toggles ──
// The backend already supported `routineOverrides: Record<routineId, boolean>`
// (NotificationService.categoryEnabled checks routineOverrides first). This
// section surfaces it: list every routine + a toggle that writes the override.
// `true`/absent = notify (default); `false` = fully mute that routine.
function RoutineNotifyToggles({
  prefs,
  busy,
  persist
}: {
  prefs: NotificationPrefs
  busy: boolean
  persist: (next: NotificationPrefs) => void
}): ReactElement {
  const [routines, setRoutines] = useState<RoutineDefinition[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setRoutines(await window.daymate.listRoutines())
        setLoadError(null)
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const overrides = prefs.routineOverrides ?? {}

  const toggle = (id: string): void => {
    const nowOn = overrides[id] ?? true
    persist({
      ...prefs,
      routineOverrides: { ...overrides, [id]: !nowOn }
    })
  }

  if (loadError) {
    return (
      <div className="mt-3 text-xs text-rose-300/80">无法加载例程列表：{loadError}</div>
    )
  }
  if (routines.length === 0) {
    return (
      <div className="mt-3 text-xs text-white/40">暂无例程。</div>
    )
  }

  return (
    <div className="mt-3 rounded border border-white/5 p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
      <div className="text-xs text-white/50">按例程开关（覆盖类别设置；关闭后完全静音该例程）</div>
      <div className="mt-2 space-y-1.5">
        {routines.map((r) => {
          const on = overrides[r.id] ?? true
          return (
            <label key={r.id} className="flex items-center gap-2 text-sm text-white/85">
              <input type="checkbox" checked={on} onChange={() => toggle(r.id)} disabled={busy} />
              <span>{r.name}</span>
              {!r.enabled && <span className="text-xs text-white/35">（例程未启用）</span>}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ── Milestone D §D3 — 投递 data export (ZIP) ──
function DataExportCard(): ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const exportZip = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const path = await window.daymate.exportApplicationsZip()
      if (path) setResult(`已导出到：${path}`)
      else setResult('已取消')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-white/5 p-4" style={{ background: 'var(--dm-panel)' }}>
      <h2 className="text-sm font-semibold text-white/90">数据导出</h2>
      <p className="mt-1 text-xs text-white/45">
        导出投递模块（投递记录 + 事件时间线 + 面经库 + 简历版本 + 面试逐字稿）为一个 ZIP 文件（无压缩）。仅本地写入，无需审批。
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={exportZip}
          disabled={busy}
          className="rounded px-3 py-1 text-xs text-white/80 disabled:opacity-50"
          style={{ background: 'var(--dm-accent)' }}
        >
          {busy ? '导出中…' : '导出投递数据'}
        </button>
        {result && <span className="text-xs text-white/55">{result}</span>}
        {error && <span className="text-xs text-rose-200">{error}</span>}
      </div>
    </div>
  )
}
