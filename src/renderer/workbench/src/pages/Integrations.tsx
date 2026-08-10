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
  IntegrationStatus
} from '@shared/types'
import { LLM_PROVIDERS, DEFAULT_LLM_MODEL_IDS } from '@shared/constants'
import { INTEGRATION_STATUS_LABEL, statusLabel } from '../labels'

// Integrations (Spec §18). The Gmail card drives the real OAuth flow
// (client_id/secret → SecretStore; Connect opens the browser loopback flow;
// Test lists one real message). The 163 card drives real IMAP/SMTP via the
// mailbox 授权码. The Feishu card drives real calendar read via user OAuth.
const MOCK_ACCOUNTS: { provider: string; displayName: string; email: string; status: string }[] = []

export function IntegrationsPage(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">集成</h1>
      <p className="mt-1 text-sm text-white/45">已连接的账户与提供方。</p>

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

      <div className="mt-6 rounded-lg border border-amber-500/20 p-4" style={{ background: 'rgba(120,80,0,0.08)' }}>
        <h2 className="text-sm font-semibold text-amber-200/90">说明</h2>
        <p className="mt-1 text-xs text-white/55">
          Daymate 绝不硬编码令牌，绝不向渲染进程暴露令牌；并且（对于 LLM 密钥）保存后不再回读。日历创建/更新（R2 写入）已推迟——这些集成为只读。
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
