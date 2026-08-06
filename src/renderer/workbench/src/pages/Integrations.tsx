import type { ReactElement } from 'react'

// Integrations (Spec §18). MVP shows the mock providers as connected. Real
// Gmail OAuth (loopback callback) and 163 IMAP/SMTP land in a later pass and
// require credentials the user supplies — never hardcoded (Spec rule 4/6/7).
const MOCK_ACCOUNTS = [
  { provider: 'gmail', displayName: 'Mock Gmail', email: 'me@example.com', status: 'connected' },
  { provider: 'mail163', displayName: 'Mock 163 Mail', email: 'me@163.com', status: 'connected' },
  { provider: 'feishu', displayName: 'Mock Feishu Calendar', email: '—', status: 'connected' }
] as const

export function IntegrationsPage(): ReactElement {
  return (
    <div>
      <h1 className="text-xl font-semibold text-white">Integrations</h1>
      <p className="mt-1 text-sm text-white/45">Connected accounts and providers.</p>

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

      <div className="mt-6 rounded-lg border border-amber-500/20 p-4" style={{ background: 'rgba(120,80,0,0.08)' }}>
        <h2 className="text-sm font-semibold text-amber-200/90">Real integration needs credentials</h2>
        <p className="mt-1 text-xs text-white/55">
          Gmail OAuth (loopback callback) and 163 IMAP/SMTP are skeletons. They activate when you
          provide credentials through the secure flow — Daymate never hardcodes tokens or exposes
          them to the renderer.
        </p>
      </div>
    </div>
  )
}
