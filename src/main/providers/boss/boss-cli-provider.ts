// Real Boss Provider — wraps the `boss` CLI (jackwener/boss-cli, PyPI
// `kabi-boss-cli`) as a subprocess. boss-cli handles auth entirely (cookies
// auto-extracted from local browsers, 7-day TTL refresh), so Daymate touches no
// credential. Every command is invoked with `--json`; boss-cli prints Rich
// diagnostics to stderr (which we ignore) and the `{ok,schema_version,data}`
// envelope to stdout (which we parse).
//
// FIELD-MAPPING CAVEAT: boss-cli's envelope `data` shape is reverse-engineered
// and only partially documented in its SCHEMA.md (the per-command payload
// fields are not exhaustively listed). The mappers below read a few common
// field-name variants defensively; if real output uses a different key the
// resulting DTO simply omits the optional field (no crash). The mock provider
// drives every test, so this real path is exercised only when the user has
// boss-cli installed — adjust the mappers then against real output.
//
// boss-cli is ESM-ish Python, spawned via `execFile('boss', …)`. If `boss` is
// not on PATH (not installed), `getStatus` returns 'disconnected' and the
// container falls back to the mock — the credential-free dev path is unaffected.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  IntegrationAccount,
  IntegrationStatus,
  BossJob,
  BossApplication,
  BossInterview,
  BossChat,
  BossSearchQuery
} from '@shared/types'
import type { BossProvider } from './boss-provider'
import { BossCliError } from './boss-provider'
import { nowIso } from '../../util/ids'

const execFileAsync = promisify(execFile)
const ACCOUNT_ID = 'boss-real'
const BOSS_BIN = process.env.DAYMATE_BOSS_BIN ?? 'boss'
const SPAWN_TIMEOUT_MS = 60_000

/** The boss-cli `{ok, data, error}` envelope. */
interface Envelope<T> {
  ok: boolean
  schema_version?: string
  data: T | null
  error?: { code: string; message: string }
}

/** Run `boss <args> --json` and return the parsed `data`, or throw BossCliError. */
async function runBoss<T>(args: string[]): Promise<T> {
  let stdout: string
  try {
    const res = await execFileAsync(BOSS_BIN, [...args, '--json'], {
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    stdout = res.stdout
  } catch (err) {
    const e = err as { code?: string; message?: string; stdout?: string }
    // ENOENT = the `boss` binary is not installed.
    if (e.code === 'ENOENT') {
      throw new BossCliError('未安装 boss-cli（找不到 boss 命令）', 'not_installed')
    }
    // execFile rejects on non-zero exit; boss-cli may still have written a
    // JSON error envelope to stdout before exiting.
    const stdoutMaybe = e.stdout ?? ''
    if (stdoutMaybe.trim()) {
      const env = parseEnvelope<T>(stdoutMaybe)
      if (env && !env.ok) {
        throw new BossCliError(env.error?.message ?? 'boss-cli 调用失败', mapCode(env.error?.code))
      }
    }
    throw new BossCliError(e.message ?? 'boss-cli 调用失败', 'unknown_error')
  }
  const env = parseEnvelope<T>(stdout)
  if (!env) throw new BossCliError('boss-cli 输出无法解析', 'unknown_error')
  if (!env.ok || env.data == null) {
    throw new BossCliError(env.error?.message ?? 'boss-cli 返回错误', mapCode(env.error?.code))
  }
  return env.data
}

function parseEnvelope<T>(stdout: string): Envelope<T> | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Envelope<T>
  } catch {
    return null
  }
}

function mapCode(code?: string): BossCliError['code'] {
  switch (code) {
    case 'not_authenticated':
    case 'rate_limited':
    case 'invalid_params':
    case 'api_error':
      return code
    default:
      return 'unknown_error'
  }
}

// Defensive field readers: try several likely key names, return the first hit.
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k]
  }
  return undefined
}
function str(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const v = pick(obj, keys)
  return typeof v === 'string' ? v : v != null ? String(v) : undefined
}

function mapJob(d: Record<string, unknown>): BossJob {
  return {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: String(d.securityId ?? d.security_id ?? d.encryptId ?? d.encrypt_id ?? ''),
    jobName: String(d.jobName ?? d.job_name ?? d.position ?? d.postName ?? ''),
    companyName: String(d.companyName ?? d.brandName ?? d.company ?? ''),
    salary: str(d, ['salary', 'salaryDesc']),
    city: str(d, ['cityName', 'city', 'locationName']),
    experience: str(d, ['experienceName', 'experience', 'postAge']),
    degree: str(d, ['degreeName', 'degree', 'education']),
    hrName: str(d, ['bossName', 'hrName', 'activeTimeDesc']),
    brandName: str(d, ['brandName', 'companyName']),
    jobLabels: Array.isArray(d.jobLabels) ? (d.jobLabels as string[]) : undefined
  }
}

function mapApplication(d: Record<string, unknown>): BossApplication {
  return {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: String(d.securityId ?? d.security_id ?? d.encryptJobId ?? ''),
    jobName: String(d.jobName ?? d.job_name ?? d.positionName ?? ''),
    companyName: String(d.companyName ?? d.brandName ?? d.companyShortName ?? ''),
    salary: str(d, ['salary', 'salaryDesc']),
    city: str(d, ['cityName', 'city']),
    brandName: str(d, ['brandName', 'companyName']),
    hrName: str(d, ['bossName', 'hrName', 'friendName']),
    appliedAt: str(d, ['addTime', 'applyTime', 'createTime'])
  }
}

function mapInterview(d: Record<string, unknown>): BossInterview {
  return {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: str(d, ['securityId', 'security_id', 'encryptJobId']) as string | undefined,
    interviewId: String(d.id ?? d.encryptId ?? d.interviewId ?? ''),
    jobName: String(d.jobName ?? d.positionName ?? d.job_name ?? ''),
    companyName: String(d.companyName ?? d.brandName ?? d.companyShortName ?? ''),
    interviewTime: str(d, ['interviewTime', 'expectTime', 'time']),
    address: str(d, ['address', 'addressDesc', 'location']),
    contact: str(d, ['contact', 'bossName', 'hrName']),
    status: str(d, ['status', 'statusDesc', 'interviewStatus'])
  }
}

function mapChat(d: Record<string, unknown>): BossChat {
  return {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    friendId: String(d.encryptUid ?? d.friendId ?? d.encryptFriendId ?? d.id ?? ''),
    hrName: str(d, ['bossName', 'hrName', 'friendName']),
    companyName: str(d, ['companyName', 'brandName']),
    jobName: str(d, ['jobName', 'positionName']),
    lastMessage: str(d, ['lastContent', 'lastMessage', 'lastMsg']),
    lastTime: str(d, ['lastTime', 'updateTime', 'lastCreateTime']),
    unread: typeof d.unread === 'boolean' ? d.unread : undefined,
    securityId: str(d, ['securityId', 'security_id', 'encryptJobId']) as string | undefined
  }
}

/** Normalize `boss <cmd> --json` `data` (object, array, or {list:[…]}) → array. */
function asArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const k of ['list', 'applications', 'jobs', 'zpData', 'results']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[]
    }
    // Single object → wrap.
    return [o]
  }
  return []
}

export class BossCliProvider implements BossProvider {
  readonly provider = 'boss' as const
  readonly accountId = ACCOUNT_ID

  async connect(): Promise<IntegrationAccount> {
    // boss-cli auth is cookie-based (login happens in the browser + `boss login`
    // in a terminal); "connect" here = validate the saved session.
    const authenticated = await this.isAuthenticated()
    this._lastStatus = authenticated ? 'connected' : 'disconnected'
    return {
      id: ACCOUNT_ID,
      provider: 'boss',
      displayName: 'BOSS 直聘 (boss-cli)',
      status: authenticated ? 'connected' : 'disconnected',
      scopes: ['boss:read'],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  private _lastStatus: IntegrationStatus = 'disconnected'

  async disconnect(): Promise<void> {
    // No-op: we never clear boss-cli's cookies (that is `boss logout`, a manual
    // terminal action). Disconnect just marks Daymate's view as offline.
    this._lastStatus = 'disconnected'
  }

  /**
   * `boss status --json` → whether to swap the mock out for the real provider.
   * Never reads cookies. NOTE: `boss status --json` prints a FLAT object
   * ({credential_present, authenticated, …}), NOT the `{ok, data, error}`
   * envelope that list commands (applied/interviews/…) use — so it must be
   * exec'd + parsed directly; `runBoss` would reject it as a non-envelope.
   *
   * Gates on `credential_present` (a saved credential file exists) rather than
   * boss-cli's strict `authenticated` flag: that flag is false whenever the
   * browser-JS cookie `__zp_stoken__` is missing, even though the funnel read
   * APIs (`boss applied`/`interviews`/`chat`) work fine with the 4 session
   * cookies QR login grants. `__zp_stoken__` is only needed by `search`/
   * `recommend`, which degrade to a `provider_unavailable` Activity (the
   * existing error path) rather than blocking the funnel. So a present-but-
   * stoken-less credential still swaps to real — honest behavior for a
   * read-only P1 funnel. A truly absent session (`credential_present:false`)
   * stays mock; a later session that fully expires surfaces as an error
   * envelope on the next read.
   */
  private async isAuthenticated(): Promise<boolean> {
    try {
      const res = await execFileAsync(BOSS_BIN, ['status', '--json'], {
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      })
      const obj = JSON.parse((res.stdout ?? '').trim() || '{}') as Record<string, unknown>
      const present = pick(obj, ['credential_present', 'credentialPresent', 'has_credential'])
      if (present === true || present === 'true') return true
      const auth = pick(obj, ['authenticated', 'isAuthenticated', 'logged_in', 'loggedIn'])
      return auth === true || auth === 'true'
    } catch (e) {
      // ENOENT (boss not installed), non-zero exit, or parse failure → mock.
      console.error(`[boss] isAuthenticated ERROR:`, e)
      return false
    }
  }

  async getStatus(): Promise<IntegrationStatus> {
    if (this._lastStatus === 'connected') {
      // Re-validate lazily; an expired session surfaces on the next read.
      return 'connected'
    }
    const ok = await this.isAuthenticated()
    this._lastStatus = ok ? 'connected' : 'disconnected'
    return this._lastStatus
  }

  async listApplications(): Promise<BossApplication[]> {
    const data = await runBoss<unknown>(['applied'])
    return asArray(data).map(mapApplication)
  }

  async listInterviews(): Promise<BossInterview[]> {
    const data = await runBoss<unknown>(['interviews'])
    return asArray(data).map(mapInterview)
  }

  async listChats(): Promise<BossChat[]> {
    const data = await runBoss<unknown>(['chat'])
    return asArray(data).map(mapChat)
  }

  async getJobDetail(securityId: string): Promise<BossJob> {
    const data = await runBoss<Record<string, unknown>>(['detail', securityId])
    return mapJob(data)
  }

  async searchJobs(query: BossSearchQuery): Promise<BossJob[]> {
    const args = ['search', query.keyword]
    if (query.city) args.push('--city', query.city)
    if (query.salary) args.push('--salary', query.salary)
    if (query.experience) args.push('--exp', query.experience)
    if (query.degree) args.push('--degree', query.degree)
    if (query.page) args.push('-p', String(query.page))
    const data = await runBoss<unknown>(args)
    const jobs = asArray(data).map(mapJob)
    return query.limit ? jobs.slice(0, query.limit) : jobs
  }
}
