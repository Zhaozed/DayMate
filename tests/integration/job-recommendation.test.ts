// Milestone C integration: the `job_recommendation` routine runs end-to-end
// (job_search.get_intent → boss.search → score_job_matches → need_to_know
// fromKey → notify) over the credential-free mock path, with `settings`
// wired into EngineDeps so the intent tool can read jobIntent. Asserts the
// run completes, a Need-to-Know brief is published, and the robot is notified.

import { describe, it, expect } from 'vitest'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockMail163Provider } from '../../src/main/providers/email/mock-mail163-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import type { Settings } from '../../src/main/util/settings'

function buildEngine() {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const applicationService = new ApplicationService(store, new MockBossProvider(), activityService)
  const notifyCalls: string[] = []
  // A fake Settings that surfaces a configured jobIntent to the
  // `job_search.get_intent` R0 tool (the real Settings reads settings.json;
  // here we hard-code the intent for determinism).
  const fakeSettings = {
    async readJobSearch() {
      return {
        jobIntent: { keyword: 'Go 后端', cities: ['北京'], salaryMin: 25, salaryMax: 40 }
      }
    }
  } as unknown as Settings
  const deps: EngineDeps = {
    store,
    toolRegistry: createToolRegistry(),
    activityService,
    taskService: new TaskService(store),
    needToKnowService: new NeedToKnowService(store),
    approvalService: new ApprovalService(store),
    emailProviders: [new MockEmailProvider(), new MockMail163Provider()],
    calendarProvider: new MockCalendarProvider(),
    bossProvider: new MockBossProvider(),
    agentRuntime: createDeterministicAgentRuntime(),
    memoryService: new MemoryService(store),
    applicationService,
    settings: fakeSettings,
    notify: (m: string) => {
      notifyCalls.push(m)
    }
  }
  const engine = new RoutineEngine(deps)
  return { engine, store, applicationService, needToKnowService: deps.needToKnowService, notifyCalls }
}

describe('job_recommendation routine (Milestone C)', () => {
  it('runs end-to-end: intent → search → score → NTK → notify', async () => {
    const { engine, store, needToKnowService, notifyCalls } = buildEngine()
    seedPresets(store)

    // The preset ships disabled (opt-in until jobIntent is configured).
    // Here a jobIntent IS configured (via the fake settings), so enable it.
    const r = store.getRoutine('job_recommendation')
    expect(r).toBeDefined()
    store.saveRoutine({ ...r!, enabled: true })

    const run = await engine.run('job_recommendation', { manual: true })
    expect(run.status).toBe('completed')

    // A Need-to-Know brief was published from the `score_job_matches` output.
    // (The NTK service does not persist routineRunId — find by the brief title.)
    const ntk = needToKnowService.list().find((n) => n.title === '岗位推荐')
    expect(ntk).toBeDefined()
    expect(ntk!.summary).toContain('Go') // the mock's Go job was scored + surfaced

    // The robot was notified with the brief's title.
    expect(notifyCalls).toContain('岗位推荐')
  })

  it('is disabled by default (opt-in until jobIntent is configured)', () => {
    const { store } = buildEngine()
    seedPresets(store)
    const r = store.getRoutine('job_recommendation')
    expect(r!.enabled).toBe(false)
  })
})

// ── Dual-bucket service path (校招生 实习 + 秋招正职) ──────────────────────
// Bucket is a deterministic business rule (§12): the service splits scored
// results back into buckets by securityId; the agent stays bucket-unaware. The
// MockBossProvider branches on `jobType` to return distinct securityIds per
// bucket, so the split is observable here.

import type { BossProvider, BossSearchQuery, BossJob } from '@shared/types'
import { BossCliError } from '../../src/main/providers/boss/boss-provider'
import type { JobIntent, IntegrationAccount, IntegrationStatus, BossApplication, BossInterview, BossChat } from '@shared/types'

const SAMPLE_INTENT: JobIntent = {
  keyword: 'Go',
  cities: ['北京', '杭州'],
  salaryMin: 20,
  salaryMax: 40,
  degree: '本科'
}

/** A boss provider whose `searchJobsPaged` throws `BossCliError(rate_limited)`
 *  on the Nth call — used to assert partial-result + error-surfacing behavior. */
class RateLimitBossProvider implements BossProvider {
  readonly provider = 'boss' as const
  readonly accountId = 'mock-boss-rl'
  private calls = 0
  constructor(private readonly failOn: number, private readonly inner: BossProvider) {}
  async connect(): Promise<IntegrationAccount> { return this.inner.connect() }
  async disconnect(): Promise<void> { return this.inner.disconnect() }
  async getStatus(): Promise<IntegrationStatus> { return this.inner.getStatus() }
  async listApplications(): Promise<BossApplication[]> { return this.inner.listApplications() }
  async listInterviews(): Promise<BossInterview[]> { return this.inner.listInterviews() }
  async listChats(): Promise<BossChat[]> { return this.inner.listChats() }
  async getJobDetail(securityId: string): Promise<BossJob> { return this.inner.getJobDetail(securityId) }
  async searchJobs(query: BossSearchQuery): Promise<BossJob[]> { return this.inner.searchJobs(query) }
  async searchJobsPaged(query: BossSearchQuery): Promise<{ jobs: BossJob[]; hasMore: boolean }> {
    this.calls += 1
    if (this.calls >= this.failOn) {
      throw new BossCliError('BOSS 限流，请稍后重试', 'rate_limited')
    }
    return this.inner.searchJobsPaged(query)
  }
}

function buildService(provider: BossProvider = new MockBossProvider()) {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const applicationService = new ApplicationService(store, provider, activityService)
  const agentRuntime = createDeterministicAgentRuntime()
  return { applicationService, agentRuntime, store, activityService }
}

describe('fetchJobRecommendations dual-bucket service (校招生 双投)', () => {
  it('splits results into 实习 / 秋招正职 buckets by securityId', async () => {
    const { applicationService, agentRuntime } = buildService()
    const out = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT)
    // Distinct securityIds per bucket (mock branches on jobType).
    expect(out.intern.length).toBeGreaterThan(0)
    expect(out.campus.length).toBeGreaterThan(0)
    const internIds = new Set(out.intern.map((r) => r.securityId))
    const campusIds = new Set(out.campus.map((r) => r.securityId))
    for (const id of internIds) expect(campusIds.has(id)).toBe(false)
    // Intern jobs carry the 元/天 salary style; campus carry K style.
    expect(out.intern.some((r) => r.salary?.includes('元/天'))).toBe(true)
    expect(out.campus.some((r) => r.salary?.includes('K'))).toBe(true)
  })

  it('refreshes ONE bucket per click (anti-bot: N calls not 2N) + fetched flags', async () => {
    const { applicationService, agentRuntime } = buildService()
    // Refresh ONLY the intern bucket — campus must stay empty + unfetched.
    const out = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT, {
      bucket: 'intern'
    })
    expect(out.intern.length).toBeGreaterThan(0)
    expect(out.campus.length).toBe(0)
    expect(out.internFetched).toBe(true)
    expect(out.campusFetched).toBe(false)
    // Now refresh campus alone — intern stays cached, campus fills.
    const out2 = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT, {
      bucket: 'campus'
    })
    expect(out2.campus.length).toBeGreaterThan(0)
    expect(out2.intern.length).toBe(out.intern.length) // intern not re-fetched
    expect(out2.internFetched).toBe(true)
    expect(out2.campusFetched).toBe(true)
  })

  it('appends the next page into the chosen bucket on load-more', async () => {
    const { applicationService, agentRuntime } = buildService()
    const first = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT)
    const before = first.intern.length
    const more = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT, {
      bucket: 'intern',
      append: true
    })
    // Append merges into the intern bucket; campus bucket is untouched.
    expect(more.intern.length).toBeGreaterThanOrEqual(before)
    expect(more.campus.length).toBe(first.campus.length)
    // No duplicate securityIds within the bucket after append.
    const ids = more.intern.map((r) => r.securityId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps partial results + sets error when BOSS rate-limits mid-fetch', async () => {
    // Fail on the 3rd searchJobsPaged call: 实习 bucket runs 2 cities → 2 calls
    // (both succeed), then 秋招正职 bucket's 1st city call (3rd overall) throws.
    const inner = new MockBossProvider()
    const rl = new RateLimitBossProvider(3, inner)
    const { applicationService, agentRuntime } = buildService(rl)
    const out = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT)
    expect(out.error).toBeDefined()
    expect(out.error).toContain('限流')
    // The 实习 bucket (fetched first, before the trip) still has results.
    expect(out.intern.length).toBeGreaterThan(0)
  })

  it('allows converting a low-match job to an application (no recommend gate)', async () => {
    const { applicationService, agentRuntime, store } = buildService()
    const out = await applicationService.fetchJobRecommendations(agentRuntime, SAMPLE_INTENT)
    // Pick any result (regardless of tier/recommend) and convert it.
    const target = out.intern[0] ?? out.campus[0]
    expect(target).toBeDefined()
    const view = applicationService.convertJobToApplication(target.securityId)
    expect(view.application.bossSecurityId).toBe(target.securityId)
    // Idempotent: a second convert returns the same application, no duplicate.
    const again = applicationService.convertJobToApplication(target.securityId)
    expect(again.application.id).toBe(view.application.id)
    expect(store.listApplications().filter((a) => a.bossSecurityId === target.securityId).length).toBe(1)
  })
})
