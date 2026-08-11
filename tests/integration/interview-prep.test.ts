// Integration test for the interview_prep Routine (Milestone A §F): the
// `application_status` trigger fires the routine for an app whose status is
// `interview` and that has no prep material; the routine looks up the app,
// searches 面经, fetches the latest resume, generates a transcript, saves it
// as a prep material version, and notifies. Idempotent: a refire is a no-op
// (the app drops out of the candidate list once a prep material exists, and
// the idempotency key collides).

import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { TaskService } from '../../src/main/services/task-service'
import { NeedToKnowService } from '../../src/main/services/need-to-know-service'
import { ApprovalService } from '../../src/main/services/approval-service'
import { MemoryService } from '../../src/main/services/memory-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { createToolRegistry } from '../../src/main/agent/tool-registry'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { RoutineEngine, type EngineDeps } from '../../src/main/routines/engine'
import { seedPresets } from '../../src/main/routines/presets'
import { RoutineScheduler } from '../../src/main/routines/scheduler'
import { MockEmailProvider } from '../../src/main/providers/email/mock-email-provider'
import { MockMail163Provider } from '../../src/main/providers/email/mock-mail163-provider'
import { MockCalendarProvider } from '../../src/main/providers/calendar/mock-calendar-provider'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'

function buildEngine() {
  const store = new InMemoryStore()
  const activityService = new ActivityService(store)
  const applicationService = new ApplicationService(store, new MockBossProvider(), activityService)
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
    notify: () => {}
  }
  const engine = new RoutineEngine(deps)
  const scheduler = new RoutineScheduler(engine, store, undefined, applicationService)
  return { engine, store, scheduler, applicationService }
}

describe('interview_prep routine (Milestone A §F)', () => {
  it('fires for an interview-status app with no prep, generates + saves a transcript', async () => {
    const { store, scheduler, applicationService } = buildEngine()
    seedPresets(store)

    // An application in `interview` status (locked manual interview event).
    const app = applicationService.create({
      company: '字节跳动',
      position: '后端工程师',
      city: '北京',
      jdText: 'Go 微服务、Kubernetes、高并发'
    })
    applicationService.addEvent({
      applicationId: app.application.id,
      type: 'interview',
      round: 1,
      evidence: '一面'
    })
    // A resume version for the transcript step to read.
    applicationService.saveResume(app.application.id, '<b>我的简历</b>')
    // A 面经 note at this company for the notes step to find.
    applicationService.createInterviewNote({
      company: '字节跳动',
      position: '后端工程师',
      tags: ['项目', '八股'],
      content: '问了一道分布式锁的题'
    })

    // The app is a candidate (interview + no prep material).
    expect(applicationService.listInterviewStatusApps()).toHaveLength(1)

    // Disable the preset's poll-driven trigger is unnecessary — call the poll
    // entry point directly (the shared poller calls this every 60s).
    await scheduler.fireApplicationStatus()

    // A prep material was saved as version 1.
    const prep = applicationService.getLatestPrepMaterial(app.application.id)
    expect(prep).toBeDefined()
    expect(prep!.version).toBe(1)
    expect(prep!.html).toContain('面试准备逐字稿')
    expect(prep!.html).toContain('字节跳动')

    // The run completed.
    const run = store.getRunByIdempotencyKey(
      `appstatus:interview_prep:${app.application.id}:interview`
    )
    expect(run).toBeDefined()
    expect(run!.status).toBe('completed')
  })

  it('does not refire once a prep material exists (idempotent)', async () => {
    const { store, scheduler, applicationService } = buildEngine()
    seedPresets(store)

    const app = applicationService.create({ company: '腾讯', position: '前端' })
    applicationService.addEvent({ applicationId: app.application.id, type: 'interview' })
    applicationService.saveResume(app.application.id, '<b>r</b>')

    await scheduler.fireApplicationStatus()
    expect(applicationService.getLatestPrepMaterial(app.application.id)).toBeDefined()

    // The app now has a prep material → it drops out of the candidate list.
    expect(applicationService.listInterviewStatusApps()).toHaveLength(0)

    // Refire: no new run, no new version.
    const runsBefore = store.listRuns().length
    await scheduler.fireApplicationStatus()
    expect(store.listRuns().length).toBe(runsBefore)
    expect(applicationService.getLatestPrepMaterial(app.application.id)!.version).toBe(1)
  })

  it('does not fire for a non-interview app', async () => {
    const { store, scheduler, applicationService } = buildEngine()
    seedPresets(store)

    // An app still in `applied` status (no interview event).
    const app = applicationService.create({ company: '美团', position: '后端' })
    applicationService.saveResume(app.application.id, '<b>r</b>')

    expect(applicationService.listInterviewStatusApps()).toHaveLength(0)
    await scheduler.fireApplicationStatus()
    // No run created.
    expect(store.listRuns().length).toBe(0)
    expect(applicationService.getLatestPrepMaterial(app.application.id)).toBeUndefined()
  })

  it('notify fires with the company name in the message', async () => {
    const { store } = buildEngine()
    let notified = ''
    // Rebuild engine with a capturing notify.
    const activityService = new ActivityService(store)
    const applicationService = new ApplicationService(store, new MockBossProvider(), activityService)
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
      notify: (m) => {
        notified = m
      }
    }
    const engine = new RoutineEngine(deps)
    const scheduler = new RoutineScheduler(engine, store, undefined, applicationService)
    seedPresets(store)

    const app = applicationService.create({ company: '阿里', position: 'Java' })
    applicationService.addEvent({ applicationId: app.application.id, type: 'interview' })
    applicationService.saveResume(app.application.id, '<b>r</b>')

    await scheduler.fireApplicationStatus()
    expect(notified).toContain('阿里')
  })
})
