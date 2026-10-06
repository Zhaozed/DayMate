// Main-process IPC handlers. Implements the typed DaymateApi surface.
// Everything here runs in main: no credential or token ever crosses to the
// renderer — only validated, plain-data responses do.

import { app, ipcMain, dialog, safeStorage, net, shell, BrowserWindow, Notification, powerMonitor } from 'electron'
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
  ApplicationEventType,
  ApplicationUpdateFields,
  InterviewNoteInput,
  JobSearchSettings,
  NotificationPrefs,
  BirthData,
  TaskCreateInput,
  TodoSettings
} from './contracts'
import { APP_NAME, WINDOWS } from '@shared/constants'
import { openWorkbench, openRobot } from '../windows'
import { getRobotWindow, setRobotView } from '../windows/robot-window'
import { getWorkbenchWindow } from '../windows/workbench-window'
import { getContainer, initContainer } from '../app/container'
import { nowIso } from '../util/ids'
import { writeFile, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractTextFromPdf } from '../util/pdf'
import { RemoteGatewayClient } from '../remote/remote-client'
import {
  startCallbackServer,
  buildAuthUrl,
  exchangeCode,
  newState,
  type OAuthClient
} from '../providers/email/gmail-oauth'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

let remoteClient: RemoteGatewayClient | null = null

export function isRemoteMode(): boolean {
  return !!process.env.DAYMATE_SERVER_URL
}

export function getRemoteClient(): RemoteGatewayClient | null {
  return remoteClient
}

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

let ipcHandlersRegistered = false

export function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

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

  // In remote mode: forward all business channels to remote server
  if (remoteClient) {
    const localChannels = new Set<string>([
      IPC.PING,
      IPC.GET_APP_INFO,
      IPC.GET_ROBOT_STATE,
      IPC.SET_ROBOT_STATE,
      IPC.OPEN_WINDOW,
      IPC.OPEN_WORKBENCH_AT,
      IPC.APP_QUIT,
      IPC.SET_ROBOT_VIEW,
      IPC.APPLICATION_UPLOAD_RESUME,
      IPC.APPLICATION_SELECT_BASE_RESUME,
      IPC.APPLICATION_EXPORT_ZIP,
      IPC.GMAIL_CONNECT
    ])

    // Special local + remote handlers
    ipcMain.handle(IPC.APPLICATION_UPLOAD_RESUME, async (_e, applicationId: string) => {
      const result = await dialog.showOpenDialog({
        title: '上传简历',
        filters: [{ name: '简历文件 (*.pdf, *.html, *.txt, *.md)', extensions: ['pdf', 'html', 'htm', 'txt', 'md'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]
      let content: string
      if (filePath.toLowerCase().endsWith('.pdf')) {
        const buf = await readFile(filePath)
        const plainText = await extractTextFromPdf(buf)
        content = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume</title><style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; white-space: pre-wrap; line-height: 1.6; padding: 24px; color: #1f2937; }</style></head><body>${escapeHtml(plainText)}</body></html>`
      } else {
        content = await readFile(filePath, 'utf8')
      }
      return remoteClient!.call(IPC.APPLICATION_UPLOAD_RESUME, [{ applicationId, content }])
    })

    ipcMain.handle(IPC.APPLICATION_SELECT_BASE_RESUME, async () => {
      const result = await dialog.showOpenDialog({
        title: '选择主简历文件',
        filters: [{ name: '简历文件 (*.pdf, *.html, *.txt, *.md)', extensions: ['pdf', 'html', 'htm', 'txt', 'md'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]
      let content = ''
      if (filePath.toLowerCase().endsWith('.pdf')) {
        const buf = await readFile(filePath)
        content = await extractTextFromPdf(buf)
      } else {
        content = await readFile(filePath, 'utf8')
      }
      const current = (await remoteClient!.call(IPC.JOB_SEARCH_GET_CONFIG, [])) as JobSearchSettings
      await remoteClient!.call(IPC.JOB_SEARCH_SET_CONFIG, [{ ...current, baseResumePath: filePath }])
      return { path: filePath, fileName: basename(filePath), text: content.slice(0, 500) }
    })

    ipcMain.handle(IPC.APPLICATION_EXPORT_ZIP, async () => {
      const remoteRes = (await remoteClient!.call(IPC.APPLICATION_EXPORT_ZIP, [])) as {
        base64: string
        filename?: string
      }
      const bytes = Buffer.from(remoteRes.base64, 'base64')
      const filename = remoteRes.filename || `daymate-投递-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`
      const result = await dialog.showSaveDialog({
        title: '导出投递数据',
        defaultPath: filename,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, bytes)
      return result.filePath
    })

    ipcMain.handle(IPC.GMAIL_CONNECT, async () => {
      const client = (await remoteClient!.call('daymate:gmail:get-client', [])) as OAuthClient
      const cb = await startCallbackServer()
      const state = newState()
      const authUrl = buildAuthUrl(client, cb.redirectUri, state)
      await shell.openExternal(authUrl)
      const { code, state: returned } = await cb.waitForCode()
      if (returned !== state) throw new Error('OAuth 状态不匹配 —— 可能存在 CSRF，已中止。')
      const tokens = await exchangeCode(client, code, cb.redirectUri)
      return remoteClient!.call('daymate:gmail:save-tokens', [tokens])
    })

    // Forward all remaining IPC channels
    for (const channel of Object.values(IPC)) {
      if (!localChannels.has(channel)) {
        ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
          return remoteClient!.call(channel, args)
        })
      }
    }
    return
  }

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

  // Tasks. CREATE/DELETE added ADR 0026 (Home ToDo mgmt). broadcasts on mutation.
  ipcMain.handle(IPC.TASK_LIST, () => container.taskService.list())
  ipcMain.handle(IPC.TASK_CREATE, (_e, input: TaskCreateInput) => {
    const task = container.taskService.create(input)
    container.broadcastTasks()
    return task
  })
  ipcMain.handle(IPC.TASK_UPDATE, (_e, id: string, patch: TaskUpdate) => {
    const task = container.taskService.update(id, patch)
    container.broadcastTasks()
    return task
  })
  ipcMain.handle(IPC.TASK_DELETE, (_e, id: string) => {
    container.taskService.delete(id)
    container.broadcastTasks()
  })

  // Need to Know. listMorningBriefs added ADR 0026 (Home 晨报 carousel).
  ipcMain.handle(IPC.NEED_TO_KNOW_LIST, () => container.needToKnowService.list())
  ipcMain.handle(IPC.NEED_TO_KNOW_DISMISS, (_e, id: string) => {
    container.needToKnowService.dismiss(id)
  })
  ipcMain.handle(IPC.NEED_TO_KNOW_CLEAR_ALL, () => {
    container.needToKnowService.clearAll()
  })
  // ADR 0029 — user edits a 必读 item's headline (title) / summary inline.
  // Only title + summary are user-editable; thread/source fields stay put.
  ipcMain.handle(
    IPC.NEED_TO_KNOW_UPDATE,
    (_e, id: string, patch: { title?: string; summary?: string }) => {
      const clean: { title?: string; summary?: string } = {}
      if (typeof patch?.title === 'string' && patch.title.trim().length > 0) {
        clean.title = patch.title.trim().slice(0, 120)
      }
      if (typeof patch?.summary === 'string') {
        clean.summary = patch.summary.trim().slice(0, 600)
      }
      if (Object.keys(clean).length === 0) return
      container.needToKnowService.update(id, clean)
    }
  )

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

  // Memory (M5 — Spec §16)
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
  ipcMain.handle(IPC.MEMORY_CONFIRM, (_e, id: string) => {
    const item = container.memoryService.confirm(id)
    container.broadcastMemory()
    return item
  })
  ipcMain.handle(IPC.MEMORY_DELETE, (_e, id: string) => {
    container.memoryService.delete(id)
    container.broadcastMemory()
  })

  // Job applications — the cross-channel funnel panel.
  // Manual create / add-event are local R1 writes (no approval).
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
  // On-demand JD enrichment (post-MVP). NOT a routine engine run — mirrors the
  // generateResume/generatePrepMaterial on-demand path. Reads the application's
  // company/position, invokes the deterministic `web.fetch_jd` R0 tool (DDG
  // HTML + extractSnippets), and patches `jdText`. §17: the fetched JD text is
  // UNTRUSTED public web content — never enters model context (the model never
  // calls this tool; it's a deterministic step), stored as data, rendered in a
  // `sandbox=""` iframe. R1 local write (§15 only gates external writes).
  ipcMain.handle(
    IPC.APPLICATION_FETCH_JD,
    async (
      _e,
      applicationId: string,
      overrides?: { company?: string; position?: string; jobCode?: string }
    ) => {
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
      let text = (result.status === 'ok' ? (result.data as { text?: string }).text : '') || ''
      if (!text) {
        text = (await container.applicationService.fetchJd(company, position, jobCode)) || ''
      }
      if (text) {
        container.applicationService.updateFields(applicationId, { jdText: text })
        container.broadcastApplications()
      }
      const note = result.status === 'ok' ? (result.data as { note?: string }).note : undefined
      return { jdText: text || null, error: text ? null : (note ?? '未能获取到 JD') }
    }
  )

  // ── Milestone A: rich-field CRUD, email inference, AI generation, config ──
  ipcMain.handle(
    IPC.APPLICATION_SYNC_EMAIL,
    async () => {
      const result = await container.applicationService.syncFromEmails(
        container.emailProviders,
        container.agentRuntime,
        {}
      )
      // Auto-enrich JD for any application missing JD text
      const apps = container.applicationService.list()
      for (const app of apps) {
        if (!app.application.jdText && (app.application.company || app.application.position)) {
          void container.toolRegistry.execute(
            'web.fetch_jd',
            {
              company: app.application.company,
              position: app.application.position,
              jobCode: app.application.jobCode
            },
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
          ).then((res) => {
            if (res.status === 'ok') {
              const data = res.data as { text?: string }
              if (data.text) {
                container.applicationService.updateFields(app.application.id, { jdText: data.text })
                container.broadcastApplications()
              }
            }
          }).catch(() => {})
        }
      }
      container.broadcastApplications()
      container.broadcastEmailMatches()
      return result
    }
  )
  ipcMain.handle(IPC.APPLICATION_UPLOAD_RESUME, async (_e, applicationId: string) => {
    // The user uploads their OWN resume (trusted §17 — their document, never
    // untrusted external mail). It is stored verbatim as a new resume version
    // (version = prev+1; latest is active). The interview-transcript generator
    // reads the latest resume via `application.get_latest_resume`, so uploading
    // is what feeds transcript generation. Text-based formats only (.html/.txt/
    // .md) — PDF binary can't feed the agent or render in the sandbox iframe.
    const result = await dialog.showOpenDialog({
      title: '上传简历',
      filters: [
        { name: '简历文件 (*.pdf, *.html, *.txt, *.md)', extensions: ['pdf', 'html', 'htm', 'txt', 'md'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    let content: string
    if (filePath.toLowerCase().endsWith('.pdf')) {
      const buf = await readFile(filePath)
      content = `data:application/pdf;base64,${buf.toString('base64')}`
    } else {
      content = await readFile(filePath, 'utf8')
    }
    const version = container.applicationService.saveResume(applicationId, content)
    container.broadcastApplications()
    return version
  })
  ipcMain.handle(IPC.APPLICATION_OPEN_PDF, async (_e, dataUrlOrBase64: string) => {
    let buf: Buffer
    if (dataUrlOrBase64.startsWith('data:application/pdf;base64,')) {
      buf = Buffer.from(dataUrlOrBase64.slice('data:application/pdf;base64,'.length), 'base64')
    } else {
      buf = Buffer.from(dataUrlOrBase64, 'base64')
    }
    const tmpPath = join(tmpdir(), `daymate-resume-${Date.now()}.pdf`)
    await writeFile(tmpPath, buf)
    await shell.openPath(tmpPath)
    return true
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
  ipcMain.handle(IPC.APPLICATION_STATS, () => container.applicationService.stats())
  ipcMain.handle(IPC.APPLICATION_UNDO_EVENT, (_e, applicationId: string, eventId: string) =>
    container.applicationService.undoEmailEvent(applicationId, eventId)
  )
  ipcMain.handle(IPC.APPLICATION_REBIND_EVENT, (_e, fromAppId: string, eventId: string, toAppId: string) =>
    container.applicationService.rebindEmailEvent(fromAppId, eventId, toAppId)
  )
  ipcMain.handle(IPC.APPLICATION_DELETE_EVENT, (_e, applicationId: string, eventId: string) => {
    const view = container.applicationService.deleteEvent(applicationId, eventId)
    container.broadcastApplications()
    return view
  })
  ipcMain.handle(
    IPC.APPLICATION_UPDATE_STATUS,
    (
      _e,
      applicationId: string,
      status: ApplicationEventType,
      options?: { round?: number; evidence?: string; eventAt?: string }
    ) => {
      const view = container.applicationService.updateStatus(applicationId, status, options)
      container.broadcastApplications()
      return view
    }
  )
  ipcMain.handle(IPC.APPLICATION_UPDATE_JD, (_e, applicationId: string, jdText: string) =>
    container.applicationService.updateJdText(applicationId, jdText)
  )
  ipcMain.handle(IPC.APPLICATION_GENERATE_FUNNEL_REVIEW, async () => {
    // Manual AI generation — does NOT go through the Routine Engine (mirrors
    // generateResume/generatePrepMaterial). The recap is an on-demand snapshot;
    // it is not persisted (regenerate on demand). §13.4: descriptive only.
    const review = await container.applicationService.generateFunnelReview(
      container.agentRuntime
    )
    return review
  })
  // Pending email→application match queue (§3.3 待确认队列).
  ipcMain.handle(IPC.EMAIL_MATCHES_LIST, () =>
    container.applicationService.listPendingEmailMatches()
  )
  ipcMain.handle(
    IPC.EMAIL_MATCH_CONFIRM,
    (
      _e,
      messageId: string,
      applicationId?: string,
      options?: {
        company?: string
        position?: string
        jobCode?: string
        eventType?: import('@shared/types').ApplicationEventType
      }
    ) => {
      container.applicationService.confirmEmailMatch(messageId, applicationId, options)
      container.broadcastApplications()
      container.broadcastEmailMatches()
    }
  )
  ipcMain.handle(IPC.EMAIL_MATCH_IGNORE, (_e, messageId: string) => {
    container.applicationService.ignoreEmailMatch(messageId)
    container.broadcastEmailMatches()
  })
  // ADR 0029 — lazy R0 fetch of a whole email thread for the 必读 page expand.
  // Locates the provider by (provider, accountId) in the live emailProviders
  // array and calls its best-effort getThread. Never throws to the renderer:
  // any failure (provider missing getThread, IMAP error) returns [] so the UI
  // falls back to the surfaced sourceRefs. Read-only (§15 — no external write).
  ipcMain.handle(
    IPC.EMAIL_THREAD_GET,
    async (
      _e,
      input: { threadId: string; provider: 'gmail' | 'mail163'; accountId: string }
    ) => {
      try {
        const provider = container.emailProviders.find(
          (p) => p.provider === input.provider && p.accountId === input.accountId
        )
        if (!provider?.getThread) return []
        return await provider.getThread(input.threadId)
      } catch {
        return []
      }
    }
  )
  // Job-search config (non-secret file paths, §G).
  ipcMain.handle(IPC.JOB_SEARCH_GET_CONFIG, () => container.settings.readJobSearch())
  ipcMain.handle(IPC.JOB_SEARCH_SET_CONFIG, (_e, jobSearch: JobSearchSettings) =>
    container.settings.writeJobSearch(jobSearch)
  )
  ipcMain.handle(IPC.APPLICATION_SELECT_BASE_RESUME, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择主简历文件',
      filters: [
        { name: '简历文件 (*.pdf, *.html, *.txt, *.md)', extensions: ['pdf', 'html', 'htm', 'txt', 'md'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const current = await container.settings.readJobSearch()
    await container.settings.writeJobSearch({
      ...current,
      baseResumePath: filePath
    })
    let text = ''
    try {
      text = (await container.settings.readBaseResumeContent()) ?? ''
    } catch {
      // best-effort
    }
    return {
      path: filePath,
      fileName: basename(filePath),
      text: text.slice(0, 500)
    }
  })
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

  // ADR 0026 — Home 今日天气 card. WEATHER_GET returns today's cached briefing
  // (or null when stale/absent → Home shows the empty state + 生成 button).
  // WEATHER_REFRESH force-regenerates (manual). City is non-secret settings.json
  // (default 北京), editable on the 集成与设置 page.
  ipcMain.handle(IPC.WEATHER_GET, async () => container.weatherService.getCached())
  ipcMain.handle(IPC.WEATHER_REFRESH, async () => container.weatherService.refresh())
  ipcMain.handle(IPC.WEATHER_CITY_GET, async () => container.settings.readWeatherCity())
  ipcMain.handle(IPC.WEATHER_CITY_SET, async (_e, city: string) =>
    container.settings.writeWeatherCity(city)
  )
  // ADR 0027 — ToDo overhaul settings (school-spam skip tokens + cold-start
  // toggle). R1 local reads/writes (§15 — no external side-effect).
  ipcMain.handle(IPC.TODO_GET_SETTINGS, () => container.settings.readTodo())
  ipcMain.handle(IPC.TODO_SET_SETTINGS, async (_e, todo: TodoSettings) => {
    const next = await container.settings.writeTodo(todo)
    // Propagate skip-tokens to the live services so a change applies without
    // a restart (mirrors NOTIFICATION_SET_PREFS's refresh-on-write pattern).
    const tokens =
      next.skipTokens && next.skipTokens.length > 0
        ? next.skipTokens
        : ['[student_ips]']
    container.emailBriefing.setSkipTokens(tokens)
    container.applicationService.setSkipTokens(tokens)
    return next
  })
  // Manual re-scan: clear the account's coldStartDone entry so the backfill
  // re-runs, then fire-and-forget. `accountId` is 'gmail-real' / 'mail163-real'
  // (the real provider accountIds) — matched against the live providers array.
  ipcMain.handle(IPC.TODO_COLD_START, async (_e, accountId: string) => {
    const todo = await container.settings.readTodo()
    const cleared = (todo.coldStartDone ?? []).filter((a) => a !== accountId)
    await container.settings.writeTodo({ ...todo, coldStartDone: cleared })
    const provider = container.emailProviders.find((p) => p.accountId === accountId)
    if (!provider) {
      container.activityService.record({
        type: 'provider_unavailable',
        summary: `冷启动回填失败：未找到已连接的账号 ${accountId}`,
        metadata: { accountId }
      })
      return { ok: false, message: '账号未连接' }
    }
    void container.emailBriefing
      .backfillAccount(provider, { batchSize: todo.backfillBatchSize })
      .catch((err: unknown) =>
        container.activityService.record({
          type: 'provider_unavailable',
          summary: `手动冷启动失败 ${accountId}：${err instanceof Error ? err.message : String(err)}`,
          metadata: { accountId }
        })
      )
    return { ok: true }
  })
}

let containerBootstrapped = false

// Called from bootstrap once the app is ready and the DB path is resolvable.
export function bootstrapContainer(): void {
  if (containerBootstrapped) return
  containerBootstrapped = true

  if (process.env.DAYMATE_SERVER_URL) {
    console.log(`[bootstrap] Operating in REMOTE mode. Target server: ${process.env.DAYMATE_SERVER_URL}`)
    remoteClient = new RemoteGatewayClient({
      serverUrl: process.env.DAYMATE_SERVER_URL,
      token: process.env.DAYMATE_SERVER_TOKEN || ''
    })
    remoteClient.connect()
    return
  }

  const c = initContainer({
    dataDir: app.getPath('userData'),
    safeStorage,
    fetch: net.fetch,
    openExternal: (url) => shell.openExternal(url),
    broadcaster: (channel, ...args) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, ...args)
      }
    },
    onRobotStateChange: (s) => setRobotState(s),
    onRobotNotify: (n) => pushRobotNotify(n),
    notifier: (title, body) => {
      try {
        new Notification({ title, body }).show()
      } catch {
        // notification not supported
      }
    },
    onWake: (cb) => {
      try {
        powerMonitor.on('resume', cb)
      } catch {
        // powerMonitor not supported
      }
    }
  })
  // If real-provider tokens are already in the Keychain from a prior session,
  // swap the real providers back in now so a restart reconnects automatically
  // (Spec §9). Fire-and-forget — the scheduler runs mock-safe until it resolves.
  void c.refreshEmailProviders()
}
