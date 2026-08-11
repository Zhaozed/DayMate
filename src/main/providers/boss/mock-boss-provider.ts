// Mock Boss Provider — canned BOSS 直聘 fixtures so the funnel panel and the
// ApplicationService run end-to-end without boss-cli installed (Spec rule 6:
// mock providers before real integrations). The mock is the credential-free
// default; the real `BossCliProvider` swaps in only when boss-cli is installed
// + cookies are valid.

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
import { nowIso } from '../../util/ids'

const ACCOUNT_ID = 'mock-boss-001'

// Fixed securityIds so the mock's applied/interviews/chat fixtures line up
// (interviews + chats reference a job by the same securityId as an applied row).
const SID_GOLANG = 'mock-sid-golang-001'
const SID_FRONTEND = 'mock-sid-frontend-001'

const APPLIED: BossApplication[] = [
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: SID_GOLANG,
    jobName: 'Go 后端工程师',
    companyName: '字节跳动',
    salary: '25-40K·15薪',
    city: '北京',
    brandName: '字节跳动',
    hrName: '张HR',
    appliedAt: new Date(Date.now() - 6 * 86400000).toISOString()
  },
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: SID_FRONTEND,
    jobName: '前端开发工程师',
    companyName: '美团',
    salary: '20-35K·14薪',
    city: '上海',
    brandName: '美团',
    hrName: '李HR',
    appliedAt: new Date(Date.now() - 3 * 86400000).toISOString()
  }
]

const INTERVIEWS: BossInterview[] = [
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: SID_GOLANG,
    interviewId: 'mock-iv-001',
    jobName: 'Go 后端工程师',
    companyName: '字节跳动',
    interviewTime: new Date(Date.now() + 2 * 86400000).toISOString(),
    address: '北京市海淀区中航广场',
    contact: '张HR',
    status: '待确认'
  }
]

const CHATS: BossChat[] = [
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    friendId: 'mock-friend-001',
    hrName: '张HR',
    companyName: '字节跳动',
    jobName: 'Go 后端工程师',
    lastMessage: '你好，简历已收到，安排下周面试',
    lastTime: new Date(Date.now() - 1 * 86400000).toISOString(),
    unread: false,
    securityId: SID_GOLANG
  }
]

const JOB_DETAILS: Record<string, BossJob> = {
  [SID_GOLANG]: {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: SID_GOLANG,
    jobName: 'Go 后端工程师',
    companyName: '字节跳动',
    salary: '25-40K·15薪',
    city: '北京',
    experience: '3-5年',
    degree: '本科',
    hrName: '张HR',
    brandName: '字节跳动',
    jobLabels: ['Go', '微服务', 'Kubernetes']
  },
  [SID_FRONTEND]: {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: SID_FRONTEND,
    jobName: '前端开发工程师',
    companyName: '美团',
    salary: '20-35K·14薪',
    city: '上海',
    experience: '1-3年',
    degree: '本科',
    hrName: '李HR',
    brandName: '美团',
    jobLabels: ['React', 'TypeScript', 'Vite']
  }
}

// Search-only fixtures split by `jobType` so the dual-bucket (实习 / 秋招正职)
// service path returns DISTINCT securityIds per bucket — the service splits
// scored results back into buckets by securityId, so without distinct sets both
// buckets would collapse into one. Intern salaries use the 元/天 style real
// intern postings use; campus uses K style. The applied/interviews/chat
// fixtures above stay keyed by SID_GOLANG/SID_FRONTEND (unchanged).
const INTERN_JOBS: BossJob[] = [
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: 'mock-sid-intern-go',
    jobName: 'Go 后端实习生',
    companyName: '腾讯',
    salary: '200-300元/天',
    city: '北京',
    experience: '在校/应届',
    degree: '本科',
    hrName: '王HR',
    brandName: '腾讯',
    jobLabels: ['Go', '实习']
  },
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: 'mock-sid-intern-fe',
    jobName: '前端实习生',
    companyName: '阿里巴巴',
    salary: '180-250元/天',
    city: '杭州',
    experience: '在校/应届',
    degree: '本科',
    hrName: '陈HR',
    brandName: '阿里巴巴',
    jobLabels: ['React', '实习']
  }
]
const CAMPUS_JOBS: BossJob[] = [
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: 'mock-sid-campus-go',
    jobName: 'Go 后端工程师（校招）',
    companyName: '字节跳动',
    salary: '25-40K·15薪',
    city: '北京',
    experience: '在校/应届',
    degree: '本科',
    hrName: '张HR',
    brandName: '字节跳动',
    jobLabels: ['Go', '校招']
  },
  {
    provider: 'boss',
    accountId: ACCOUNT_ID,
    securityId: 'mock-sid-campus-fe',
    jobName: '前端工程师（校招）',
    companyName: '美团',
    salary: '20-35K·14薪',
    city: '上海',
    experience: '在校/应届',
    degree: '本科',
    hrName: '李HR',
    brandName: '美团',
    jobLabels: ['React', '校招']
  }
]

export class MockBossProvider implements BossProvider {
  readonly provider = 'boss' as const
  readonly accountId = ACCOUNT_ID
  private status: IntegrationStatus = 'connected'

  async connect(): Promise<IntegrationAccount> {
    this.status = 'connected'
    return {
      id: ACCOUNT_ID,
      provider: 'boss',
      displayName: 'Mock BOSS 直聘',
      status: 'connected',
      scopes: ['boss:read'],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected'
  }

  async getStatus(): Promise<IntegrationStatus> {
    return this.status
  }

  async listApplications(): Promise<BossApplication[]> {
    return APPLIED.map((a) => ({ ...a }))
  }

  async listInterviews(): Promise<BossInterview[]> {
    return INTERVIEWS.map((i) => ({ ...i }))
  }

  async listChats(): Promise<BossChat[]> {
    return CHATS.map((c) => ({ ...c }))
  }

  async getJobDetail(securityId: string): Promise<BossJob> {
    const job = JOB_DETAILS[securityId]
    if (!job) throw new Error(`未找到职位：${securityId}`)
    return { ...job }
  }

  async searchJobs(query: BossSearchQuery): Promise<BossJob[]> {
    return (await this.searchJobsPaged(query)).jobs
  }
  async searchJobsPaged(query: BossSearchQuery): Promise<{ jobs: BossJob[]; hasMore: boolean }> {
    const kw = (query.keyword ?? '').toLowerCase()
    // Branch by jobType so the dual-bucket service path (实习 vs 全职) returns
    // distinct securityIds per bucket. No jobType → all fixtures (legacy
    // `boss.search` tool / routine preset path).
    let pool: BossJob[]
    if (query.jobType === '实习') pool = INTERN_JOBS
    else if (query.jobType === '全职') pool = CAMPUS_JOBS
    else pool = Object.values(JOB_DETAILS)
    const matched = kw ? pool.filter((j) => j.jobName.toLowerCase().includes(kw)) : pool
    const limit = query.limit ?? matched.length
    const jobs = matched.slice(0, limit).map((j) => ({ ...j }))
    // Mock: pretend more pages exist when the match set exceeds the slice, OR
    // when the caller explicitly asks for page > 1 (simulates pagination —
    // append/load-more exercises the service's page-increment path).
    const hasMore = matched.length > limit || Boolean(query.page && query.page > 1 && matched.length > 0)
    return { jobs, hasMore }
  }
}
