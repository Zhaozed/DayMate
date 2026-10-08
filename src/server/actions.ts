import { IPC } from '@shared/constants'
import type { Container } from '../main/app/container'
import type {
  TaskCreateInput,
  TaskUpdate,
  RoutineDefinition,
  RoutineUpdate,
  LlmConfigInput,
  MemorySaveInput,
  MemoryUpdate,
  ApplicationCreateInput,
  ApplicationEventInput,
  ApplicationUpdateFields,
  InterviewNoteInput,
  JobSearchSettings,
  NotificationPrefs,
  BirthData,
  TodoSettings,
  ApprovalRequest
} from '../main/ipc/contracts'
import type { GmailTokens } from '../main/providers/email/gmail-oauth'
import { nowIso } from '../main/util/ids'

export async function dispatchBusinessAction(
  container: Container,
  channel: string,
  args: unknown[] = []
): Promise<unknown> {
  switch (channel) {
    // ── Routines ──
    case IPC.ROUTINE_LIST:
      return container.store.listRoutines()

    case IPC.ROUTINE_RUN: {
      const routineId = args[0] as string
      const run = await container.engine.run(routineId, { manual: true })
      container.broadcastActivity(run.id)
      container.broadcastApprovals()
      return run
    }

    case IPC.ROUTINE_LIST_RUNS:
      return container.store.listRuns(args[0] as string | undefined)

    case IPC.ROUTINE_GET_RUN: {
      const runId = args[0] as string
      const run = container.store.getRun(runId)
      const steps = container.store.listRunSteps(runId)
      return { run, steps }
    }

    case IPC.ROUTINE_SET_ENABLED: {
      const [routineId, enabled] = args as [string, boolean]
      const next = container.store.setRoutineEnabled(routineId, enabled)
      container.scheduler.reschedule()
      return next
    }

    case IPC.ROUTINE_UPDATE: {
      const [routineId, patch] = args as [string, RoutineUpdate]
      const existing = container.store.getRoutine(routineId)
      if (!existing) throw new Error(`未找到例程：${routineId}`)
      const updated = {
        ...existing,
        ...(patch.trigger ? { trigger: patch.trigger } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: nowIso()
      }
      container.store.saveRoutine(updated)
      container.scheduler.reschedule()
      return updated
    }

    case IPC.ROUTINE_PAUSE_ALL:
      return container.scheduler.pause()

    case IPC.ROUTINE_RESUME_ALL:
      return container.scheduler.resume()

    case IPC.ROUTINE_CREATE: {
      const def = args[0] as Omit<RoutineDefinition, 'createdAt' | 'updatedAt'>
      const created = await container.engine.createRoutine(def)
      container.scheduler.reschedule()
      return created
    }

    case IPC.ROUTINE_DELETE: {
      const routineId = args[0] as string
      await container.engine.deleteRoutine(routineId)
      container.scheduler.reschedule()
      return { ok: true }
    }

    // ── Tasks ──
    case IPC.TASK_LIST:
      return container.taskService.list()

    case IPC.TASK_CREATE: {
      const input = args[0] as TaskCreateInput
      const task = container.taskService.create(input)
      container.broadcastTasks()
      return task
    }

    case IPC.TASK_UPDATE: {
      const [id, patch] = args as [string, TaskUpdate]
      const task = container.taskService.update(id, patch)
      container.broadcastTasks()
      return task
    }

    case IPC.TASK_DELETE: {
      const id = args[0] as string
      container.taskService.delete(id)
      container.broadcastTasks()
      return { ok: true }
    }

    // ── Need to Know ──
    case IPC.NEED_TO_KNOW_LIST:
      return container.needToKnowService.list()

    case IPC.NEED_TO_KNOW_DISMISS: {
      const id = args[0] as string
      container.needToKnowService.dismiss(id)
      return { ok: true }
    }

    case IPC.NEED_TO_KNOW_CLEAR_ALL:
      container.needToKnowService.clearAll()
      return { ok: true }

    case IPC.NEED_TO_KNOW_UPDATE: {
      const [id, patch] = args as [string, { title?: string; summary?: string }]
      const clean: { title?: string; summary?: string } = {}
      if (typeof patch?.title === 'string' && patch.title.trim().length > 0) {
        clean.title = patch.title.trim().slice(0, 120)
      }
      if (typeof patch?.summary === 'string') {
        clean.summary = patch.summary.trim().slice(0, 600)
      }
      if (Object.keys(clean).length > 0) {
        container.needToKnowService.update(id, clean)
      }
      return { ok: true }
    }

    // ── Activity ──
    case IPC.ACTIVITY_LIST:
      return container.activityService.list(args[0] as string | undefined)

    // ── Approvals ──
    case IPC.APPROVAL_LIST:
      return container.approvalService.list()

    case IPC.APPROVAL_GET:
      return container.approvalService.get(args[0] as string) ?? null

    case IPC.APPROVAL_APPROVE: {
      const id = args[0] as string
      const request = container.approvalService.approve(id)
      if (request.routineRunId) {
        await container.engine.resume(request.routineRunId, { approval: { requestId: id } })
      }
      container.broadcastActivity(request.routineRunId)
      container.broadcastApprovals()
      return container.approvalService.get(id) as ApprovalRequest
    }

    case IPC.APPROVAL_REJECT: {
      const id = args[0] as string
      const request = container.approvalService.reject(id)
      if (request.routineRunId) {
        await container.engine.cancelPausedRun(request.routineRunId)
        container.broadcastActivity(request.routineRunId)
      }
      container.broadcastApprovals()
      return container.approvalService.get(id) as ApprovalRequest
    }

    // ── Memory ──
    case IPC.MEMORY_LIST:
      return container.memoryService.list()

    case IPC.MEMORY_SAVE: {
      const input = args[0] as MemorySaveInput
      const item = container.memoryService.save(input)
      container.broadcastMemory()
      return item
    }

    case IPC.MEMORY_UPDATE: {
      const [id, patch] = args as [string, MemoryUpdate]
      const item = container.memoryService.update(id, patch)
      container.broadcastMemory()
      return item
    }

    case IPC.MEMORY_CONFIRM: {
      const id = args[0] as string
      const item = container.memoryService.confirm(id)
      container.broadcastMemory()
      return item
    }

    case IPC.MEMORY_DELETE: {
      const id = args[0] as string
      container.memoryService.delete(id)
      container.broadcastMemory()
      return { ok: true }
    }

    // ── LLM Configuration ──
    case IPC.LLM_GET_CONFIG:
      return container.modelGateway.getLlmConfig()

    case IPC.LLM_SET_CONFIG:
      return container.modelGateway.setLlmConfig(args[0] as LlmConfigInput)

    case IPC.LLM_SET_KEY:
      return container.modelGateway.setLlmKey(args[0] as string)

    case IPC.LLM_DELETE_KEY:
      return container.modelGateway.deleteLlmKey()

    case IPC.LLM_TEST:
      return container.modelGateway.testLlm()

    // ── Gmail Integration ──
    case IPC.GMAIL_GET_STATUS:
      return {
        status: await container.gmailProvider.getStatus(),
        hasClient: await container.gmailProvider.hasClient(),
        email: await container.gmailProvider.getEmailAddress()
      }

    case IPC.GMAIL_SET_CLIENT: {
      const input = args[0] as { clientId: string; clientSecret: string }
      await container.gmailProvider.setClient(input.clientId, input.clientSecret)
      return {
        status: await container.gmailProvider.getStatus(),
        hasClient: await container.gmailProvider.hasClient(),
        email: await container.gmailProvider.getEmailAddress()
      }
    }

    case IPC.GMAIL_HAS_CLIENT:
      return container.gmailProvider.hasClient()

    case 'daymate:gmail:get-client':
      return container.gmailProvider.getClient()

    case IPC.GMAIL_CONNECT:
      await container.gmailProvider.connect()
      await container.refreshEmailProviders()
      return {
        status: await container.gmailProvider.getStatus(),
        hasClient: await container.gmailProvider.hasClient(),
        email: await container.gmailProvider.getEmailAddress()
      }

    case IPC.GMAIL_DISCONNECT:
      await container.gmailProvider.disconnect()
      await container.refreshEmailProviders()
      return {
        status: await container.gmailProvider.getStatus(),
        hasClient: await container.gmailProvider.hasClient(),
        email: await container.gmailProvider.getEmailAddress()
      }

    case IPC.GMAIL_TEST: {
      try {
        const msgs = await container.gmailProvider.listMessages({ limit: 1 })
        return {
          ok: true,
          message: msgs[0]
            ? `已连接 —— 读取到 1 封邮件（id ${msgs[0].messageId}）。`
            : '已连接 —— 邮箱可读，暂无匹配邮件。',
          sampleMessageId: msgs[0]?.messageId
        }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    }

    case 'daymate:gmail:save-tokens': {
      const tokens = args[0] as GmailTokens
      await container.gmailProvider.saveTokens(tokens)
      await container.refreshEmailProviders()
      return {
        status: await container.gmailProvider.getStatus(),
        hasClient: await container.gmailProvider.hasClient(),
        email: await container.gmailProvider.getEmailAddress()
      }
    }

    // ── 163 Mail Integration ──
    case IPC.MAIL163_GET_STATUS:
      return {
        status: await container.mail163Provider.getStatus(),
        hasClient: await container.mail163Provider.hasClient(),
        email: await container.mail163Provider.getEmailAddress()
      }

    case IPC.MAIL163_SET_CLIENT: {
      const input = args[0] as { email: string; authCode: string }
      await container.mail163Provider.setClient(input.email, input.authCode)
      return {
        status: await container.mail163Provider.getStatus(),
        hasClient: await container.mail163Provider.hasClient(),
        email: await container.mail163Provider.getEmailAddress()
      }
    }

    case IPC.MAIL163_HAS_CLIENT:
      return container.mail163Provider.hasClient()

    case IPC.MAIL163_CONNECT:
      await container.mail163Provider.connect()
      await container.refreshEmailProviders()
      return {
        status: await container.mail163Provider.getStatus(),
        hasClient: await container.mail163Provider.hasClient(),
        email: await container.mail163Provider.getEmailAddress()
      }

    case IPC.MAIL163_DISCONNECT:
      await container.mail163Provider.disconnect()
      await container.refreshEmailProviders()
      return {
        status: await container.mail163Provider.getStatus(),
        hasClient: await container.mail163Provider.hasClient(),
        email: await container.mail163Provider.getEmailAddress()
      }

    case IPC.MAIL163_TEST: {
      try {
        const msgs = await container.mail163Provider.listMessages({ limit: 1 })
        return {
          ok: true,
          message: msgs[0]
            ? `已连接 —— 读取到 1 封邮件（id ${msgs[0].messageId}）。`
            : '已连接 —— 邮箱可读，暂无匹配邮件。',
          sampleMessageId: msgs[0]?.messageId
        }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    }

    // ── Applications (Funnel & Job Search) ──
    case IPC.APPLICATION_LIST:
      return container.applicationService.list()

    case IPC.APPLICATION_CREATE: {
      const input = args[0] as ApplicationCreateInput
      const view = container.applicationService.create(input)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_ADD_EVENT: {
      const input = args[0] as ApplicationEventInput
      const view = container.applicationService.addEvent(input)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_UPDATE_FIELDS: {
      const [id, patch] = args as [string, ApplicationUpdateFields]
      const view = container.applicationService.updateFields(id, patch)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_FETCH_JD: {
      const applicationId = args[0] as string
      const overrides = args[1] as { company?: string; position?: string; jobCode?: string } | undefined
      const app = container.applicationService.list().find((v) => v.application.id === applicationId)
      if (!app) return { jdText: null, error: '未找到投递记录' }
      const company = overrides?.company?.trim() || app.application.company
      const position = overrides?.position?.trim() || app.application.position
      const jobCode = overrides?.jobCode?.trim() || app.application.jobCode
      const result = await container.toolRegistry.execute(
        'web.fetch_jd',
        { company, position, jobCode },
        {
          emailProviders: container.emailProviders,
          calendarProvider: container.calendarProvider,
          taskService: container.taskService,
          needToKnowService: container.needToKnowService,
          activityService: container.activityService,
          memoryService: container.memoryService,
          applicationService: container.applicationService,
          settings: container.settings,
          webFetch: container.webFetch,
          notify: (m: string) => container.notificationService.notify({ message: m, category: 'info' })
        }
      )
      if (result.status !== 'ok') {
        return { jdText: null, error: 'error' in result ? result.error : 'web 抓取失败' }
      }
      const data = result.data as { text?: string; note?: string }
      const text = data.text ?? ''
      if (text) {
        container.applicationService.updateFields(applicationId, { jdText: text })
        container.broadcastApplications()
      }
      return { jdText: text || null, error: data.note ?? null }
    }

    case IPC.APPLICATION_UPLOAD_RESUME: {
      // In server mode, args can be { applicationId, content }
      const input = args[0] as { applicationId?: string; content?: string } | undefined
      if (input && typeof input.applicationId === 'string' && typeof input.content === 'string') {
        const version = container.applicationService.saveResume(input.applicationId, input.content)
        container.broadcastApplications()
        return version
      }
      return null
    }

    case IPC.APPLICATION_GENERATE_PREP: {
      const applicationId = args[0] as string
      const material = await container.applicationService.generatePrepMaterial(
        applicationId,
        container.agentRuntime
      )
      container.broadcastApplications()
      return material
    }

    case IPC.APPLICATION_LIST_RESUMES:
      return container.applicationService.listResumeVersions(args[0] as string)

    case IPC.APPLICATION_LIST_PREP:
      return container.applicationService.listPrepMaterials(args[0] as string)

    case IPC.APPLICATION_LIST_INTERVIEW_NOTES:
      return container.applicationService.listInterviewNotes(args[0] as string | undefined)

    case IPC.APPLICATION_CREATE_INTERVIEW_NOTE: {
      const input = args[0] as InterviewNoteInput
      return container.applicationService.createInterviewNote(input)
    }

    case IPC.APPLICATION_SOFT_DELETE: {
      const id = args[0] as string
      container.applicationService.softDelete(id)
      container.broadcastApplications()
      return { ok: true }
    }

    case IPC.APPLICATION_RESTORE: {
      const id = args[0] as string
      const view = container.applicationService.restore(id)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_PURGE: {
      const id = args[0] as string
      container.applicationService.purgeApplication(id)
      container.broadcastApplications()
      return { ok: true }
    }

    case IPC.APPLICATION_LIST_DELETED:
      return container.applicationService.listDeleted()

    case IPC.APPLICATION_ARCHIVE: {
      const id = args[0] as string
      const view = container.applicationService.archive(id)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_UNARCHIVE: {
      const id = args[0] as string
      const view = container.applicationService.unarchive(id)
      container.broadcastApplications()
      return view
    }

    case IPC.APPLICATION_STATS:
      return container.applicationService.stats()

    case IPC.APPLICATION_UNDO_EVENT: {
      const applicationId = args[0] as string
      const eventId = args[1] as string
      return container.applicationService.undoEmailEvent(applicationId, eventId)
    }

    case IPC.APPLICATION_REBIND_EVENT: {
      const fromAppId = args[0] as string
      const eventId = args[1] as string
      const toAppId = args[2] as string
      return container.applicationService.rebindEmailEvent(fromAppId, eventId, toAppId)
    }

    case IPC.APPLICATION_UPDATE_JD: {
      const applicationId = args[0] as string
      const jdText = args[1] as string
      return container.applicationService.updateJdText(applicationId, jdText)
    }

    case IPC.APPLICATION_GENERATE_FUNNEL_REVIEW:
      return container.applicationService.generateFunnelReview(container.agentRuntime)

    case IPC.EMAIL_MATCHES_LIST:
      return container.applicationService.listPendingEmailMatches()

    case IPC.EMAIL_MATCH_CONFIRM: {
      const [messageId, applicationId] = args as [string, string | undefined]
      container.applicationService.confirmEmailMatch(messageId, applicationId)
      container.broadcastApplications()
      container.broadcastEmailMatches()
      return { ok: true }
    }

    case IPC.EMAIL_MATCH_IGNORE: {
      const messageId = args[0] as string
      container.applicationService.ignoreEmailMatch(messageId)
      container.broadcastEmailMatches()
      return { ok: true }
    }

    case IPC.JOB_SEARCH_GET_CONFIG:
      return container.settings.readJobSearch()

    case IPC.JOB_SEARCH_SET_CONFIG: {
      const cfg = args[0] as JobSearchSettings
      await container.settings.writeJobSearch(cfg)
      return cfg
    }

    case IPC.APPLICATION_SYNC_EMAIL: {
      const cursor = await container.settings.readEmailSyncCursor()
      const result = await container.applicationService.syncFromEmails(
        container.emailProviders,
        container.agentRuntime,
        cursor
      )
      await container.settings.writeEmailSyncCursor(result.cursor)
      container.broadcastApplications()
      container.broadcastEmailMatches()
      if (result.newEmails.length > 0) {
        await container.emailBriefing.briefNewEmails(result.newEmails)
      }
      return result
    }

    case IPC.APPLICATION_EXPORT_ZIP: {
      const bytes = container.applicationService.exportApplicationsZip()
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      return {
        filename: `daymate-投递-${stamp}.zip`,
        base64: Buffer.from(bytes).toString('base64')
      }
    }

    // ── Notifications ──
    case IPC.NOTIFICATION_GET_PREFS:
      return container.settings.readNotifications()

    case IPC.NOTIFICATION_SET_PREFS: {
      const patch = args[0] as Partial<NotificationPrefs>
      const next = await container.settings.writeNotifications(patch)
      await container.notificationService.refreshPrefs()
      return next
    }

    // ── Birth Data & Fortune ──
    case IPC.BIRTH_DATA_GET:
      return container.settings.readBirthData()

    case IPC.BIRTH_DATA_SET: {
      const birth = args[0] as BirthData
      return container.settings.writeBirthData(birth)
    }

    case IPC.BIRTH_DATA_CLEAR:
      return container.settings.clearBirthData()

    // ── Weather ──
    case IPC.WEATHER_GET:
      return container.weatherService.getCached()

    case IPC.WEATHER_REFRESH:
      return container.weatherService.refresh()

    case IPC.WEATHER_CITY_GET:
      return container.settings.readWeatherCity()

    case IPC.WEATHER_CITY_SET:
      return container.settings.writeWeatherCity(args[0] as string)

    // ── ToDo Settings ──
    case IPC.TODO_GET_SETTINGS:
      return container.settings.readTodo()

    case IPC.TODO_SET_SETTINGS: {
      const todo = args[0] as TodoSettings
      const next = await container.settings.writeTodo(todo)
      const tokens = next.skipTokens && next.skipTokens.length > 0 ? next.skipTokens : ['[student_ips]']
      container.emailBriefing.setSkipTokens(tokens)
      container.applicationService.setSkipTokens(tokens)
      return next
    }

    case IPC.TODO_COLD_START: {
      const accountId = args[0] as string
      const todo = await container.settings.readTodo()
      const done = (todo.coldStartDone ?? []).filter((id) => id !== accountId)
      await container.settings.writeTodo({ ...todo, coldStartDone: done })
      const provider = container.emailProviders.find((p) => p.accountId === accountId)
      if (provider) {
        void container.emailBriefing.backfillAccount(provider, { batchSize: todo.backfillBatchSize })
      }
      return { ok: true }
    }

    // ── Email Thread ──
    case IPC.EMAIL_THREAD_GET: {
      const input = args[0] as { threadId: string; provider: 'gmail' | 'mail163'; accountId: string }
      if (!input?.threadId) return []
      if (input.provider === 'gmail') {
        return container.gmailProvider.getThread(input.threadId)
      } else if (input.provider === 'mail163') {
        return container.mail163Provider.getThread(input.threadId)
      }
      return []
    }

    default:
      throw new Error(`Unknown business action channel: ${channel}`)
  }
}
