// Locks the BossCliProvider mappers to the REAL boss-cli `--json` envelope
// shapes, derived from boss_cli/commands/*.py render code (not the mock
// fixtures). The mock provider drove every test before; this suite is the
// anchor that the real path maps real output correctly (CLAUDE.md deferred
// "真实 boss-cli 字段映射对照调整（待用户安装）" across 0010/0011/0013/C/D/E).

import { describe, it, expect } from 'vitest'
import {
  asArray,
  mapJob,
  mapJobDetail,
  mapApplication,
  mapInterview,
  mapChat
} from '../../src/main/providers/boss/boss-cli-provider'

describe('boss-cli provider mappers (real envelope shapes)', () => {
  describe('asArray', () => {
    it('unwraps cardList (boss applied)', () => {
      const data = { cardList: [{ jobInfo: { jobName: 'a' } }, { jobInfo: { jobName: 'b' } }], totalCount: 2 }
      expect(asArray(data)).toHaveLength(2)
      expect((asArray(data)[0] as Record<string, unknown>).jobInfo).toEqual({ jobName: 'a' })
    })

    it('unwraps interviewList (boss interviews)', () => {
      expect(asArray({ interviewList: [{ jobName: 'x' }] })).toHaveLength(1)
    })

    it('unwraps result and friendList (boss chat)', () => {
      expect(asArray({ result: [{ name: 'hr1' }] })).toHaveLength(1)
      expect(asArray({ friendList: [{ name: 'hr2' }] })).toHaveLength(1)
    })

    it('unwraps jobList (boss search/recommend)', () => {
      expect(asArray({ jobList: [{ jobName: 'go' }], hasMore: false })).toHaveLength(1)
    })

    it('passes through a plain array', () => {
      expect(asArray([{ a: 1 }, { a: 2 }])).toHaveLength(2)
    })

    it('wraps a single object (boss detail data)', () => {
      expect(asArray({ jobInfo: { jobName: 'd' } })).toEqual([{ jobInfo: { jobName: 'd' } }])
    })

    it('returns [] for null/primitive', () => {
      expect(asArray(null)).toEqual([])
      expect(asArray('x')).toEqual([])
      expect(asArray(undefined)).toEqual([])
    })

    it('returns [] for an empty object (boss chat with no conversations returns data:{})', () => {
      // Without this guard, {} would wrap to [{}] and synthesize a single
      // all-empty chat entry. Confirmed against real `boss chat --json`.
      expect(asArray({})).toEqual([])
    })

    it('returns [] for an empty cardList (boss applied with no applications)', () => {
      expect(asArray({ cardList: [], totalCount: 0 })).toEqual([])
    })
  })

  describe('mapApplication — nested jobInfo/brandInfo card', () => {
    const card = {
      jobInfo: {
        securityId: 'enc-123',
        jobName: 'Go 后端',
        salaryDesc: '20-30K',
        cityName: '杭州'
      },
      brandInfo: { brandName: '字节跳动' },
      bossName: '张三',
      deliverStatusDesc: '已投递',
      updateTimeDesc: '2026-08-10'
    }

    it('reads job fields from jobInfo, company from brandInfo', () => {
      const app = mapApplication(card)
      expect(app.securityId).toBe('enc-123')
      expect(app.jobName).toBe('Go 后端')
      expect(app.salary).toBe('20-30K')
      expect(app.city).toBe('杭州')
      expect(app.companyName).toBe('字节跳动')
      expect(app.brandName).toBe('字节跳动')
      expect(app.hrName).toBe('张三')
      expect(app.appliedAt).toBe('2026-08-10')
    })

    it('falls back to the card itself when jobInfo/brandInfo are absent', () => {
      const flat = { securityId: 's1', jobName: '前端', brandName: '美团', salary: '15K' }
      const app = mapApplication(flat)
      expect(app.jobName).toBe('前端')
      expect(app.companyName).toBe('美团')
      expect(app.salary).toBe('15K')
    })
  })

  describe('mapJob — flat search result (jobExperience/jobDegree/skills)', () => {
    const job = {
      securityId: 'sec-9',
      jobName: 'Python',
      brandName: '阿里',
      salaryDesc: '25-40K',
      jobExperience: '3-5年',
      jobDegree: '本科',
      cityName: '北京',
      areaDistrict: '海淀',
      skills: ['Python', 'FastAPI', 'Docker']
    }

    it('maps jobExperience/jobDegree (not the legacy experienceName/degreeName)', () => {
      const j = mapJob(job)
      expect(j.securityId).toBe('sec-9')
      expect(j.jobName).toBe('Python')
      expect(j.companyName).toBe('阿里')
      expect(j.salary).toBe('25-40K')
      expect(j.experience).toBe('3-5年')
      expect(j.degree).toBe('本科')
      expect(j.city).toBe('北京')
      expect(j.jobLabels).toEqual(['Python', 'FastAPI', 'Docker'])
    })

    it('prefers experienceName/degreeName when present (detail-style job object)', () => {
      const j = mapJob({ jobName: 'x', experienceName: '5-7年', degreeName: '硕士' })
      expect(j.experience).toBe('5-7年')
      expect(j.degree).toBe('硕士')
    })
  })

  describe('mapJobDetail — nested jobInfo/brandComInfo/bossInfo', () => {
    const detail = {
      jobInfo: {
        securityId: 'det-1',
        jobName: '架构师',
        salaryDesc: '40-60K',
        experienceName: '5-7年',
        degreeName: '硕士',
        locationName: '上海',
        skills: ['Go', 'K8s']
      },
      bossInfo: { name: '李四', title: '技术总监' },
      brandComInfo: { brandName: '腾讯', industryName: '互联网' }
    }

    it('reads job fields from jobInfo, company from brandComInfo, hr from bossInfo.name', () => {
      const j = mapJobDetail(detail, 'fallback-sid')
      expect(j.securityId).toBe('det-1')
      expect(j.jobName).toBe('架构师')
      expect(j.salary).toBe('40-60K')
      expect(j.experience).toBe('5-7年')
      expect(j.degree).toBe('硕士')
      expect(j.city).toBe('上海')
      expect(j.companyName).toBe('腾讯')
      expect(j.brandName).toBe('腾讯')
      expect(j.hrName).toBe('李四')
      expect(j.jobLabels).toEqual(['Go', 'K8s'])
    })

    it('uses the passed securityId when jobInfo lacks one', () => {
      const j = mapJobDetail({ jobInfo: { jobName: 'x' } }, 'sid-from-args')
      expect(j.securityId).toBe('sid-from-args')
    })
  })

  describe('mapInterview — flat interview item', () => {
    it('maps the real interviews shape', () => {
      const iv = mapInterview({
        id: 42,
        jobName: 'Java',
        brandName: '百度',
        interviewTime: '2026-08-12 14:00',
        address: '百度大厦',
        statusDesc: '待确认'
      })
      expect(iv.interviewId).toBe('42')
      expect(iv.jobName).toBe('Java')
      expect(iv.companyName).toBe('百度')
      expect(iv.interviewTime).toBe('2026-08-12 14:00')
      expect(iv.address).toBe('百度大厦')
      expect(iv.status).toBe('待确认')
    })
  })

  describe('mapChat — flat chat item (name/lastMsg)', () => {
    it('prefers name over bossName, and lastMsg over lastContent', () => {
      const c = mapChat({
        encryptUid: 'uid-1',
        name: '王五',
        brandName: '网易',
        jobName: '后端',
        lastMsg: '你好，方便聊聊吗',
        lastTime: '2026-08-09'
      })
      expect(c.friendId).toBe('uid-1')
      expect(c.hrName).toBe('王五')
      expect(c.companyName).toBe('网易')
      expect(c.jobName).toBe('后端')
      expect(c.lastMessage).toBe('你好，方便聊聊吗')
      expect(c.lastTime).toBe('2026-08-09')
    })

    it('falls back to bossName when name is absent', () => {
      expect(mapChat({ bossName: '赵六' }).hrName).toBe('赵六')
    })
  })
})
