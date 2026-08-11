// BOSS 直聘 provider (boss-cli integration). boss-cli (jackwener/boss-cli) is a
// Python CLI that wraps BOSS 直聘's reverse-engineered API and returns a unified
// `{ok, schema_version, data}` JSON envelope (see its SCHEMA.md). Auth is
// cookie-based and handled entirely by boss-cli (auto-extracted from 10+ local
// browsers, 7-day TTL auto-refresh) — Daymate never touches a credential, so
// unlike Gmail/163 there is no SecretStore dance.
//
// The provider is read-heavy: `listApplications`/`listInterviews`/`listChats`/
// `getJobDetail`/`searchJobs` feed the funnel panel + the agent. The one write
// (`sendGreeting` = boss.greet) is R3-approval-gated and lands in a later pass.
//
// The boss-cli output envelope:
//   success: { ok: true,  schema_version: '1', data: { ... } }
//   error:   { ok: false, schema_version: '1', data: null,
//              error: { code: 'not_authenticated'|'rate_limited'|…, message } }
// A non-ok envelope throws `BossCliError` carrying the code, so callers can
// branch (e.g. not_authenticated → robot bubble "请在浏览器登录 BOSS 直聘").

import type {
  IntegrationAccount,
  IntegrationStatus,
  BossJob,
  BossApplication,
  BossInterview,
  BossChat,
  BossSearchQuery
} from '@shared/types'

/** An error mapped from a boss-cli `{ok:false}` envelope (or a spawn failure). */
export class BossCliError extends Error {
  constructor(
    message: string,
    readonly code: 'not_authenticated' | 'rate_limited' | 'invalid_params' | 'api_error' | 'unknown_error' | 'not_installed'
  ) {
    super(message)
    this.name = 'BossCliError'
  }
}

export interface BossProvider {
  readonly provider: 'boss'
  readonly accountId: string
  connect(): Promise<IntegrationAccount>
  disconnect(): Promise<void>
  getStatus(): Promise<IntegrationStatus>

  /** `boss applied` — jobs the user has applied to (the funnel's BOSS source). */
  listApplications(): Promise<BossApplication[]>
  /** `boss interviews` — interview invitations. */
  listInterviews(): Promise<BossInterview[]>
  /** `boss chat` — communicated recruiters (→ `communicated` events). */
  listChats(): Promise<BossChat[]>
  /** `boss detail <securityId>` — full job detail for company dossiers. */
  getJobDetail(securityId: string): Promise<BossJob>
  /** `boss search` / `boss recommend` — candidate jobs (P4 recommendation). */
  searchJobs(query: BossSearchQuery): Promise<BossJob[]>
  /** Same as `searchJobs` but also surfaces boss's `hasMore` (another page
   *  exists) so the renderer can offer "load more" without a blind probe.
   *  `searchJobs` is a thin wrapper dropping `hasMore` (kept for the
   *  `boss.search` tool + routine, which don't paginate). */
  searchJobsPaged(query: BossSearchQuery): Promise<{ jobs: BossJob[]; hasMore: boolean }>
}

/**
 * Swappable boss delegate (mirrors `SwappableCalendarProvider`). Default = mock
 * (credential-free dev path); when boss-cli is installed + cookies valid, the
 * delegate swaps to the real `BossCliProvider`, and back to the mock when the
 * status is disconnected. The engine + ApplicationService hold ONE
 * `bossProvider` reference for the app's lifetime, so in-place swaps are visible
 * without re-wiring.
 */
export class SwappableBossProvider implements BossProvider {
  readonly provider = 'boss' as const
  readonly accountId = 'boss-real'
  private current: BossProvider

  constructor(private readonly fallback: BossProvider) {
    this.current = fallback
  }

  /** Swap to `real` when `on`, back to the fallback when off. */
  swap(real: BossProvider, on: boolean): void {
    this.current = on ? real : this.fallback
  }

  get active(): BossProvider {
    return this.current
  }

  async connect(): Promise<IntegrationAccount> {
    return this.current.connect()
  }
  async disconnect(): Promise<void> {
    return this.current.disconnect()
  }
  async getStatus(): Promise<IntegrationStatus> {
    return this.current.getStatus()
  }
  async listApplications(): Promise<BossApplication[]> {
    return this.current.listApplications()
  }
  async listInterviews(): Promise<BossInterview[]> {
    return this.current.listInterviews()
  }
  async listChats(): Promise<BossChat[]> {
    return this.current.listChats()
  }
  async getJobDetail(securityId: string): Promise<BossJob> {
    return this.current.getJobDetail(securityId)
  }
  async searchJobs(query: BossSearchQuery): Promise<BossJob[]> {
    return this.current.searchJobs(query)
  }
  async searchJobsPaged(query: BossSearchQuery): Promise<{ jobs: BossJob[]; hasMore: boolean }> {
    return this.current.searchJobsPaged(query)
  }
}
