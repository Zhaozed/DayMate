// Main-process IPC handlers. Implements the typed DaymateApi surface.
// Everything here runs in main: no credential or token ever crosses to the
// renderer — only validated, plain-data responses do.

import { app, ipcMain, dialog } from 'electron'
import { IPC } from './contracts'
import type {
  AppInfo,
  RobotState,
  RobotView,
  WindowName,
  TaskUpdate,
  ApprovalRequest,
  LlmConfigInput,
  RobotNotify,
  WorkbenchPage,
  RoutineUpdate,
  MemorySaveInput,
  MemoryUpdate,
  RoutineDefinition,
  ApplicationCreateInput,
  ApplicationEventInput,
  ApplicationUpdateFields,
  InterviewNoteInput,
  JobSearchSettings,
  JobRecommendations,
  FetchJobRecommendationsOpts,
  BossJob,
  NotificationPrefs,
  BirthData
} from './contracts'
import { APP_NAME, WINDOWS } from '@shared/constants'
import { openWorkbench, openRobot } from '../windows'
import { getRobotWindow, setRobotView } from '../windows/robot-window'
import { getWorkbenchWindow } from '../windows/workbench-window'
import { getContainer, initContainer } from '../app/container'
import { nowIso } from '../util/ids'
import { writeFile } from 'node:fs/promises'

// M0 in-memory robot state. From M4 onward the RobotStateController drives this
// from Activity events (container.ts); it is still surfaced to the renderer
// through getRobotState/setRobotState.
let currentRobotState: RobotState = 'idle'

export function getRobotState(): RobotState {
  return currentRobotState
}

export function setRobotState(next: RobotState): RobotState {
  currentRobotState = next
  getRobotWindow()?.webContents.send(IPC.ROBOT_STATE_CHANGED, next)
  return currentRobotState
}

/** Push a proactive bubble to the robot window (M4 §18). */
export function pushRobotNotify(msg: RobotNotify): void {
  getRobotWindow()?.webContents.send(IPC.ROBOT_NOTIFY, msg)
}

/** Deep-link the workbench to a page (M4 — e.g. Approvals from the robot). */
export function navigateWorkbench(page: WorkbenchPage): void {
  getWorkbenchWindow()?.webContents.send(IPC.WORKBENCH_NAV, page)
}

function buildAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }
}

function openWindowByName(name: WindowName): void {
  if (name === WINDOWS.workbench) openWorkbench()
  else if (name === WINDOWS.robot) openRobot()
}

export function registerIpcHandlers(): void {
  // System / health
  ipcMain.handle(IPC.PING, () => 'pong')
  ipcMain.handle(IPC.GET_APP_INFO, () => buildAppInfo())
  ipcMain.handle(IPC.GET_ROBOT_STATE, () => getRobotState())
  ipcMain.handle(IPC.SET_ROBOT_STATE, (_e, state: RobotState) => setRobotState(state))
  ipcMain.handle(IPC.OPEN_WINDOW, (_e, name: WindowName) => openWindowByName(name))
  // Open the workbench and deep-link it to a page (M4 — robot "Review" button).
  ipcMain.handle(IPC.OPEN_WORKBENCH_AT, (_e, page: WorkbenchPage) => {
    openWorkbench()
    navigateWorkbench(page)
  })
  // App lifecycle (M4 context menu).
  ipcMain.handle(IPC.APP_QUIT, () => {
    app.quit()
  })
  // Resize the ambient robot window to a view (M4 §18).
  ipcMain.handle(IPC.SET_ROBOT_VIEW, (_e, view: RobotView) => {
    setRobotView(view)
  })

  const container = getContainer()

  // Routines
  ipcMain.handle(IPC.ROUTINE_LIST, () => container.store.listRoutines())
  ipcMain.handle(IPC.ROUTINE_RUN, async (_e, routineId: string) => {
    const run = await container.engine.run(routineId, { manual: true })
    container.broadcastActivity(run.id)
    // A run may pause waiting for approval — surface it to the Approval Center.
    container.broadcastApprovals()
    return run
  })
  ipcMain.handle(IPC.ROUTINE_LIST_RUNS, (_e, routineId?: string) =>
    container.store.listRuns(routineId)
  )
  ipcMain.handle(IPC.ROUTINE_GET_RUN, (_e, runId: string) => {
    const run = container.store.getRun(runId)
    const steps = container.store.listRunSteps(runId)
    return { run, steps }
  })
  ipcMain.handle(IPC.ROUTINE_SET_ENABLED, (_e, routineId: string, enabled: boolean) => {
    const next = container.store.setRoutineEnabled(routineId, enabled)
    container.scheduler.reschedule()
    return next
  })
  // Patch a routine's trigger/enabled config (M4); steps are not editable yet.
  ipcMain.handle(IPC.ROUTINE_UPDATE, (_e, routineId: string, patch: RoutineUpdate) => {
    const existing = container.store.getRoutine(routineId)
    if (!existing) throw new Error(`未找到例程：${routineId}`)
    const updated: typeof existing = {
      ...existing,
      ...(patch.trigger ? { trigger: patch.trigger } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: nowIso()
    }
    container.store.saveRoutine(updated)
    container.scheduler.reschedule()
    return updated
  })
  // Pause / resume all scheduled triggers (M4 context menu). Manual runs still work.
  ipcMain.handle(IPC.ROUTINE_PAUSE_ALL, () => container.scheduler.pause())
  ipcMain.handle(IPC.ROUTINE_RESUME_ALL, () => container.scheduler.resume())
  // Create a custom routine from validated builder JSON (M5 §14). The builder
  // output is parsed against the Routine Schema here — a malformed routine is
  // refused, so users can never inject arbitrary steps (§14: "Users cannot
  // insert arbitrary code").
  ipcMain.handle(IPC.ROUTINE_CREATE, async (_e, def: Omit<RoutineDefinition, 'createdAt' | 'updatedAt'>) => {
    const created = await container.engine.createRoutine(def)
    container.scheduler.reschedule()
    return created
  })
  ipcMain.handle(IPC.ROUTINE_DELETE, async (_e, routineId: string) => {
    await container.engine.deleteRoutine(routineId)
    container.scheduler.reschedule()
  })

  // Tasks
  ipcMain.handle(IPC.TASK_LIST, () => container.taskService.list())
  ipcMain.handle(IPC.TASK_UPDATE, (_e, id: string, patch: TaskUpdate) =>
    container.taskService.update(id, patch)
  )

  // Need to Know
  ipcMain.handle(IPC.NEED_TO_KNOW_LIST, () => container.needToKnowService.list())

  // Activity
  ipcMain.handle(IPC.ACTIVITY_LIST, (_e, runId?: string) =>
    container.activityService.list(runId)
  )

  // Approvals (M2 — Spec §8, §15, §18)
  ipcMain.handle(IPC.APPROVAL_LIST, () => container.approvalService.list())
  ipcMain.handle(IPC.APPROVAL_GET, (_e, id: string) =>
    container.approvalService.get(id) ?? null
  )
  ipcMain.handle(IPC.APPROVAL_APPROVE, async (_e, id: string) => {
    // Approve, then resume the paused run so the gated action executes under
    // the approval context (Spec §15). Content immutability is rechecked
    // inside engine.resume.
    const request = container.approvalService.approve(id)
    if (request.routineRunId) {
      await container.engine.resume(request.routineRunId, { approval: { requestId: id } })
    }
    container.broadcastActivity(request.routineRunId)
    container.broadcastApprovals()
    return container.approvalService.get(id) as ApprovalRequest
  })
  ipcMain.handle(IPC.APPROVAL_REJECT, async (_e, id: string) => {
    // Reject → cancel the paused run. The gated action NEVER executes
    // (sends nothing, writes nothing) (Spec §15, §19).
    const request = container.approvalService.reject(id)
    if (request.routineRunId) {
      await container.engine.cancelPausedRun(request.routineRunId)
      container.broadcastActivity(request.routineRunId)
    }
    container.broadcastApprovals()
    return container.approvalService.get(id) as ApprovalRequest
  })

  // LLM configuration (M3 — Spec §17.6/§17.8). The API key is WRITE-ONLY: it is
  // accepted here, encrypted at rest by the SecretStore, and never read back.
  // `getLlmConfig` returns only { provider, modelId, keyConfigured } — the key
  // string never crosses to the renderer, never enters model context, and is
  // never logged (the SDK resolves it into StreamOptions.apiKey at call time).
  ipcMain.handle(IPC.LLM_GET_CONFIG, () => container.modelGateway.getLlmConfig())
  ipcMain.handle(IPC.LLM_SET_CONFIG, (_e, input: LlmConfigInput) =>
    container.modelGateway.setLlmConfig(input)
  )
  ipcMain.handle(IPC.LLM_SET_KEY, (_e, key: string) =>
    container.modelGateway.setLlmKey(key)
  )
  ipcMain.handle(IPC.LLM_DELETE_KEY, () => container.modelGateway.deleteLlmKey())
  ipcMain.handle(IPC.LLM_TEST, () => container.modelGateway.testLlm())

  // Gmail integration (Spec §9). client_id/secret + tokens are credentials in
  // the SecretStore; these handlers never return a token, auth code, or the
  // client secret — only opaque status + the connected email address. Connect
  // opens the OAuth browser flow on a loopback callback; the real provider is
  // swapped into emailProviders[0] so `email.list` picks it.
  const gmailStatus = async () => ({
    status: await container.gmailProvider.getStatus(),
    hasClient: await container.gmailProvider.hasClient(),
    email: await container.gmailProvider.getEmailAddress()
  })
  ipcMain.handle(IPC.GMAIL_SET_CLIENT, async (_e, input: { clientId: string; clientSecret: string }) => {
    await container.gmailProvider.setClient(input.clientId, input.clientSecret)
    return gmailStatus()
  })
  ipcMain.handle(IPC.GMAIL_GET_STATUS, gmailStatus)
  ipcMain.handle(IPC.GMAIL_CONNECT, async () => {
    await container.gmailProvider.connect()
    await container.refreshEmailProviders()
    return gmailStatus()
  })
  ipcMain.handle(IPC.GMAIL_DISCONNECT, async () => {
    await container.gmailProvider.disconnect()
    await container.refreshEmailProviders()
    return gmailStatus()
  })
  ipcMain.handle(IPC.GMAIL_TEST, async () => {
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
  })

  // 163 Mail (Spec §9). IMAP/SMTP authorized by the mailbox's 授权码; the
  // 授权码 is a credential in the SecretStore and never crosses to the renderer.
  // Connect validates by actually logging in to IMAP; the real provider is
  // swapped into emailProviders so `email.list` can pick it.
  const mail163Status = async () => ({
    status: await container.mail163Provider.getStatus(),
    hasClient: await container.mail163Provider.hasClient(),
    email: await container.mail163Provider.getEmailAddress()
  })
  ipcMain.handle(IPC.MAIL163_SET_CLIENT, async (_e, input: { email: string; authCode: string }) => {
    await container.mail163Provider.setClient(input.email, input.authCode)
    return mail163Status()
  })
  ipcMain.handle(IPC.MAIL163_HAS_CLIENT, () => container.mail163Provider.hasClient())
  ipcMain.handle(IPC.MAIL163_GET_STATUS, mail163Status)
  ipcMain.handle(IPC.MAIL163_CONNECT, async () => {
    await container.mail163Provider.connect()
    await container.refreshEmailProviders()
    return mail163Status()
  })
  ipcMain.handle(IPC.MAIL163_DISCONNECT, async () => {
    await container.mail163Provider.disconnect()
    await container.refreshEmailProviders()
    return mail163Status()
  })
  ipcMain.handle(IPC.MAIL163_TEST, async () => {
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
  })

  // Feishu Calendar (Spec §10). User-OAuth (user_access_token reads the user's
  // primary calendar); app_id/app_secret + user refresh token are credentials
  // in the SecretStore and never cross to the renderer. Connect opens the
  // browser authorize flow on a fixed-port loopback; the swappable calendar
  // delegate flips to the real provider so Meeting Prep / Daily Work Summary
  // read real events.
  const feishuStatus = async () => ({
    status: await container.feishuProvider.getStatus(),
    hasClient: await container.feishuProvider.hasClient()
  })
  ipcMain.handle(IPC.FEISHU_SET_CLIENT, async (_e, input: { appId: string; appSecret: string }) => {
    await container.feishuProvider.setClient(input.appId, input.appSecret)
    return feishuStatus()
  })
  ipcMain.handle(IPC.FEISHU_HAS_CLIENT, () => container.feishuProvider.hasClient())
  ipcMain.handle(IPC.FEISHU_GET_STATUS, feishuStatus)
  ipcMain.handle(IPC.FEISHU_CONNECT, async () => {
    await container.feishuProvider.connect()
    await container.refreshCalendarProvider()
    return feishuStatus()
  })
  ipcMain.handle(IPC.FEISHU_DISCONNECT, async () => {
    await container.feishuProvider.disconnect()
    await container.refreshCalendarProvider()
    return feishuStatus()
  })
  ipcMain.handle(IPC.FEISHU_TEST, async () => {
    try {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setHours(23, 59, 59, 999)
      const events = await container.feishuProvider.listEvents({
        start: start.toISOString(),
        end: end.toISOString()
      })
      return {
        ok: true,
        message:
          events.length > 0
            ? `已连接 —— 今日读取到 ${events.length} 个日历事件。`
            : '已连接 —— 主日历可读，今日无事件。',
        eventCount: events.length,
        sampleEventTitle: events[0]?.title
      }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.MEMORY_LIST, () => container.memoryService.list())
  ipcMain.handle(IPC.MEMORY_SAVE, (_e, input: MemorySaveInput) => {
    const item = container.memoryService.save(input)
    container.broadcastMemory()
    return item
  })
  ipcMain.handle(IPC.MEMORY_UPDATE, (_e, id: string, patch: MemoryUpdate) => {
    const item = container.memoryService.update(id, patch)
    container.broadcastMemory()
    return item
  })
  ipcMain.handle(IPC.MEMORY_DELETE, (_e, id: string) => {
    container.memoryService.delete(id)
    container.broadcastMemory()
  })

  // Job applications (boss-cli integration) — the cross-channel funnel panel.
  // Manual create / add-event are local R1 writes (no approval); boss sync
  // pulls `boss applied/interviews/chat` into the funnel and is idempotent.
  ipcMain.handle(IPC.APPLICATION_LIST, () => container.applicationService.list())
  ipcMain.handle(IPC.APPLICATION_CREATE, (_e, input: ApplicationCreateInput) => {
    const view = container.applicationService.create(input)
    container.broadcastApplications()
    return view
  })
  ipcMain.handle(IPC.APPLICATION_ADD_EVENT, (_e, input: ApplicationEventInput) => {
    const view = container.applicationService.addEvent(input)
    container.broadcastApplications()
    return view
  })
  ipcMain.handle(
    IPC.APPLICATION_UPDATE_FIELDS,
    (_e, id: string, patch: ApplicationUpdateFields) => {
      const view = container.applicationService.updateFields(id, patch)
      container.broadcastApplications()
      return view
    }
  )
  ipcMain.handle(IPC.APPLICATION_SYNC_BOSS, async () => {
    const result = await container.applicationService.syncFromBoss()
    container.broadcastApplications()
    // Reconcile the boss delegate after a sync (auth may have changed).
    void container.refreshBossProvider()
    return result
  })
  // boss-cli login/cookie health (never a cookie crosses to the renderer).
  ipcMain.handle(IPC.BOSS_GET_STATUS, async () => {
    try {
      const status = await container.bossCliProvider.getStatus()
      return {
        status,
        authenticated: status === 'connected',
        message: status === 'connected' ? 'BOSS 直聘已连接' : 'BOSS 直聘未连接（请安装 boss-cli 并在浏览器登录 zhipin.com）'
      }
    } catch (e) {
      return {
        status: 'disconnected' as const,
        authenticated: false,
        message: e instanceof Error ? e.message : String(e)
      }
    }
  })

  // ── Milestone A: rich-field CRUD, email inference, AI generation, config ──
  ipcMain.handle(
    IPC.APPLICATION_SYNC_EMAIL,
    async () => {
      const result = await container.applicationService.syncFromEmails(
        container.emailProviders,
        container.agentRuntime
      )
      container.broadcastApplications()
      container.broadcastEmailMatches()
      return result
    }
  )
  ipcMain.handle(IPC.APPLICATION_GENERATE_RESUME, async (_e, applicationId: string) => {
    // The base resume is the user's OWN document (trusted §17) — read from the
    // configured path at generation time, never stored in the DB.
    const baseResume = await container.settings.readBaseResumeContent()
    const version = await container.applicationService.generateResume(
      applicationId,
      container.agentRuntime,
      baseResume
    )
    container.broadcastApplications()
    return version
  })
  ipcMain.handle(IPC.APPLICATION_GENERATE_PREP, async (_e, applicationId: string) => {
    const material = await container.applicationService.generatePrepMaterial(
      applicationId,
      container.agentRuntime
    )
    container.broadcastApplications()
    return material
  })
  ipcMain.handle(IPC.APPLICATION_LIST_RESUMES, (_e, applicationId: string) =>
    container.applicationService.listResumeVersions(applicationId)
  )
  ipcMain.handle(IPC.APPLICATION_LIST_PREP, (_e, applicationId: string) =>
    container.applicationService.listPrepMaterials(applicationId)
  )
  ipcMain.handle(IPC.APPLICATION_LIST_INTERVIEW_NOTES, (_e, query?: string) =>
    container.applicationService.listInterviewNotes(query)
  )
  ipcMain.handle(IPC.APPLICATION_CREATE_INTERVIEW_NOTE, (_e, input: InterviewNoteInput) => {
    const note = container.applicationService.createInterviewNote(input)
    return note
  })
  ipcMain.handle(IPC.APPLICATION_SOFT_DELETE, (_e, id: string) => {
    container.applicationService.softDelete(id)
    container.broadcastApplications()
  })
  ipcMain.handle(IPC.APPLICATION_RESTORE, (_e, id: string) => {
    const view = container.applicationService.restore(id)
    container.broadcastApplications()
    return view
  })
  ipcMain.handle(IPC.APPLICATION_PURGE, (_e, id: string) => {
    container.applicationService.purgeApplication(id)
    container.broadcastApplications()
  })
  ipcMain.handle(IPC.APPLICATION_LIST_DELETED, () =>
    container.applicationService.listDeleted()
  )
  ipcMain.handle(IPC.APPLICATION_ARCHIVE, (_e, id: string) => {
    const view = container.applicationService.archive(id)
    container.broadcastApplications()
    return view
  })
  ipcMain.handle(IPC.APPLICATION_UNARCHIVE, (_e, id: string) => {
    const view = container.applicationService.unarchive(id)
    container.broadcastApplications()
    return view
  })
  // ── Milestone B: funnel review (stats + AI 复盘) ──
  ipcMain.handle(IPC.APPLICATION_STATS, () => container.applicationService.stats())
  ipcMain.handle(IPC.APPLICATION_GENERATE_FUNNEL_REVIEW, async () => {
    // Manual AI generation — does NOT go through the Routine Engine (mirrors
    // generateResume/generatePrepMaterial). The recap is an on-demand snapshot;
    // it is not persisted (regenerate on demand). §13.4: descriptive only.
    const review = await container.applicationService.generateFunnelReview(
      container.agentRuntime
    )
    return review
  })
  ipcMain.handle(
    IPC.JOB_RECOMMENDATIONS_FETCH,
    async (_e, opts?: FetchJobRecommendationsOpts): Promise<JobRecommendations> => {
      // Manual 抓取 — reads jobIntent from settings (server-side, never from the
      // renderer), searches BOSS in two buckets (实习 + 秋招正职), scores via
      // the `score_job_matches` agent step, splits results by securityId. No args
      // = refresh both buckets (page 1); {bucket, append:true} = next page for
      // one bucket. Mirrors generateFunnelReview (manual AI, not via Routine Engine).
      const { jobIntent } = await container.settings.readJobSearch()
      if (!jobIntent) {
        return {
          title: '岗位推荐',
          summary: '尚未配置求职意向，请在「岗位推荐」区设置关键词/城市/薪资。',
          reason: 'jobIntent 未配置',
          priority: 'medium',
          intern: [],
          campus: [],
          internHasMore: false,
          campusHasMore: false,
          internFetched: false,
          campusFetched: false
        } satisfies JobRecommendations
      }
      return container.applicationService.fetchJobRecommendations(
        container.agentRuntime,
        jobIntent,
        opts ?? {}
      )
    }
  )
  ipcMain.handle(IPC.JOB_CONVERT_TO_APPLICATION, (_e, securityId: string) => {
    const view = container.applicationService.convertJobToApplication(securityId)
    container.broadcastApplications()
    return view
  })
  // Full job detail (JD body, company industry/scale/stage, HR title) for the
  // clickable job-card detail view. JD body is untrusted boss data — rendered
  // as text by the renderer, never HTML (§17.12/§17.13).
  ipcMain.handle(IPC.JOB_DETAIL_GET, async (_e, securityId: string): Promise<BossJob> => {
    return container.bossProvider.getJobDetail(securityId)
  })
  // Pending email→application match queue (§3.3 待确认队列).
  ipcMain.handle(IPC.EMAIL_MATCHES_LIST, () =>
    container.applicationService.listPendingEmailMatches()
  )
  ipcMain.handle(IPC.EMAIL_MATCH_CONFIRM, (_e, messageId: string, applicationId?: string) => {
    container.applicationService.confirmEmailMatch(messageId, applicationId)
    container.broadcastApplications()
    container.broadcastEmailMatches()
  })
  ipcMain.handle(IPC.EMAIL_MATCH_IGNORE, (_e, messageId: string) => {
    container.applicationService.ignoreEmailMatch(messageId)
    container.broadcastEmailMatches()
  })
  // Job-search config (non-secret file paths, §G).
  ipcMain.handle(IPC.JOB_SEARCH_GET_CONFIG, () => container.settings.readJobSearch())
  ipcMain.handle(IPC.JOB_SEARCH_SET_CONFIG, (_e, jobSearch: JobSearchSettings) =>
    container.settings.writeJobSearch(jobSearch)
  )
  // Milestone D — notification prefs (non-secret) + 投递 data export.
  ipcMain.handle(IPC.NOTIFICATION_GET_PREFS, () => container.settings.readNotifications())
  ipcMain.handle(IPC.NOTIFICATION_SET_PREFS, async (_e, prefs: NotificationPrefs) => {
    const next = await container.settings.writeNotifications(prefs)
    // Refresh the cached prefs in the live NotificationService so the change
    // applies immediately (no restart needed).
    await container.notificationService.refreshPrefs()
    return next
  })
  ipcMain.handle(IPC.APPLICATION_EXPORT_ZIP, async () => {
    const bytes = container.applicationService.exportApplicationsZip()
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const result = await dialog.showSaveDialog({
      title: '导出投递数据',
      defaultPath: `daymate-投递-${stamp}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, bytes)
    container.activityService.record({
      type: 'tool_completed',
      summary: `已导出投递数据：${result.filePath}`,
      metadata: { exportedTo: result.filePath, bytes: bytes.length }
    })
    return result.filePath
  })
  // Milestone E — birth data for the daily 运势 (non-secret settings.json).
  ipcMain.handle(IPC.BIRTH_DATA_GET, () => container.settings.readBirthData())
  ipcMain.handle(IPC.BIRTH_DATA_SET, async (_e, birth: BirthData) =>
    container.settings.writeBirthData(birth)
  )
  ipcMain.handle(IPC.BIRTH_DATA_CLEAR, async () => {
    await container.settings.clearBirthData()
  })
}

// Called from bootstrap once the app is ready and the DB path is resolvable.
export function bootstrapContainer(): void {
  const c = initContainer()
  // If real-provider tokens are already in the Keychain from a prior session,
  // swap the real providers back in now so a restart reconnects automatically
  // (Spec §9). Fire-and-forget — the scheduler runs mock-safe until it resolves.
  void c.refreshEmailProviders()
  void c.refreshCalendarProvider()
  void c.refreshBossProvider()
}
