// Composition root — wires the SqliteStore, services, Tool Registry, Routine
// Engine and scheduler together at boot. This is the one place that knows the
// concrete implementations; everything else depends on interfaces.
//
// The DB lives in userData so it survives restarts (Spec §21 M1 exit
// criterion). better-sqlite3 must be rebuilt for Electron's ABI — see
// `rebuild:native` script and ADR 0002.

import { app, BrowserWindow, safeStorage, shell, net, Notification } from 'electron'
import { join } from 'node:path'
import { createDb } from '../db/client'
import { SqliteStore } from '../db/sqlite-store'
import { ActivityService } from '../services/activity-service'
import { TaskService } from '../services/task-service'
import { NeedToKnowService } from '../services/need-to-know-service'
import { ApprovalService } from '../services/approval-service'
import { MemoryService } from '../services/memory-service'
import { createToolRegistry } from '../agent/tool-registry'
import { createModelGateway } from '../agent/model-gateway'
import { createAgentRuntime } from '../agent/agent-runtime'
import { SecretStore } from '../util/secrets'
import { Settings } from '../util/settings'
import { RoutineEngine } from '../routines/engine'
import { RoutineScheduler } from '../routines/scheduler'
import { seedPresets } from '../routines/presets'
import { MockEmailProvider } from '../providers/email/mock-email-provider'
import { MockMail163Provider } from '../providers/email/mock-mail163-provider'
import { GmailProvider } from '../providers/email/gmail-provider'
import { Mail163Provider } from '../providers/email/mail163-provider'
import { MockCalendarProvider } from '../providers/calendar/mock-calendar-provider'
import { FeishuCalendarProvider } from '../providers/calendar/feishu-calendar-provider'
import { SwappableCalendarProvider } from '../providers/calendar/swappable-calendar-provider'
import { MockBossProvider } from '../providers/boss/mock-boss-provider'
import { BossCliProvider } from '../providers/boss/boss-cli-provider'
import { SwappableBossProvider } from '../providers/boss/boss-provider'
import cron from 'node-cron'
import type { EmailProvider } from '../providers/email/email-provider'
import type { ModelGateway } from '../agent/model-gateway'
import type { AgentRuntime } from '../agent/agent-runtime'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import type { BossProvider } from '../providers/boss/boss-provider'
import { ApplicationService } from '../services/application-service'
import { NotificationService } from '../services/notification-service'
import { RobotStateController } from '../services/robot-state-service'
import { setRobotState, pushRobotNotify } from '../ipc/handlers'
import { IPC } from '@shared/constants'

export interface Container {
  store: SqliteStore
  activityService: ActivityService
  taskService: TaskService
  needToKnowService: NeedToKnowService
  approvalService: ApprovalService
  memoryService: MemoryService
  toolRegistry: ReturnType<typeof createToolRegistry>
  modelGateway: ModelGateway
  /** Plain (non-secret) app settings (LLM config + jobSearch paths). */
  settings: Settings
  agentRuntime: AgentRuntime
  engine: RoutineEngine
  scheduler: RoutineScheduler
  emailProviders: EmailProvider[]
  /** Default calendar (mock) — real Feishu is a skeleton until creds arrive. */
  calendarProvider: CalendarProvider
  /** Swappable delegate: mock by default, real Feishu when connected. */
  calendarDelegate: SwappableCalendarProvider
  /** Real Feishu Calendar provider (Spec §10). Swapped in on connect. */
  feishuProvider: FeishuCalendarProvider
  /** Real Gmail provider (Spec §9). Swapped into emailProviders[0] on connect. */
  gmailProvider: GmailProvider
  /** Real 163 Mail provider (Spec §9). Swapped into emailProviders when connected. */
  mail163Provider: Mail163Provider
  /** Cross-channel job-application funnel (boss-cli integration). */
  applicationService: ApplicationService
  /** Centralized notify path (Milestone D §D2): prefs + quiet hours +
   *  aggregation + native macOS Notification Center. */
  notificationService: NotificationService
  /** BOSS 直聘 provider — mock by default, real boss-cli when installed + authed. */
  bossProvider: BossProvider
  /** Swappable delegate: mock by default, real BossCliProvider when authed. */
  bossDelegate: SwappableBossProvider
  /** Real boss-cli subprocess provider (Spec §9 BOSS 直聘). */
  bossCliProvider: BossCliProvider
  /** Push the latest activity to the workbench + robot for live UI updates. */
  broadcastActivity: (runId?: string) => void
  /** Push the latest approvals to the workbench for live Approval Center. */
  broadcastApprovals: () => void
  /** Push the latest memory items to the workbench Memory page (M5 §16). */
  broadcastMemory: () => void
  /** Push the latest applications to the workbench Applications page. */
  broadcastApplications: () => void
  /** Push the pending email→application matches to the workbench queue. */
  broadcastEmailMatches: () => void
  /**
   * Reconcile emailProviders with Gmail + 163 connection state: when a real
   * provider is connected, ensure it is in the array (Gmail at index 0 so
   * `email.list` with no accountId picks it); when disconnected, remove it so
   * the mocks take over again. Called from the connect/disconnect handlers and
   * once at boot.
   */
  refreshEmailProviders: () => Promise<void>
  /**
   * Reconcile the swappable calendar delegate with Feishu connection state:
   * real Feishu when connected, mock when not. Called from the Feishu
   * connect/disconnect handlers and once at boot.
   */
  refreshCalendarProvider: () => Promise<void>
  /**
   * Reconcile the swappable boss delegate with boss-cli auth state: real
   * BossCliProvider when `boss status` is authenticated, mock otherwise (e.g.
   * boss-cli not installed → mock drives the credential-free path).
   */
  refreshBossProvider: () => Promise<void>
}

let container: Container | null = null

export function getContainer(): Container {
  if (!container) throw new Error('Container not initialized — call initContainer() after app ready')
  return container
}

export function initContainer(): Container {
  if (container) return container

  const dbPath = join(app.getPath('userData'), 'daymate.db')
  const { db } = createDb(dbPath)
  const store = new SqliteStore(db)

  const activityService = new ActivityService(store)
  const taskService = new TaskService(store)
  const needToKnowService = new NeedToKnowService(store)
  const approvalService = new ApprovalService(store)
  const memoryService = new MemoryService(store)

  // Unified normalized feed: mock Gmail + mock 163 (Spec §21 M2). The real
  // Gmail provider is constructed below (needs `secrets`) and only swapped
  // into this array at index 0 once the user connects via the Integrations
  // page — so the credential-free default still uses the mocks. The array is
  // the same reference the engine reads each buildContext, so in-place swaps
  // are visible to the running engine without re-wiring.
  const emailProviders: EmailProvider[] = [new MockEmailProvider(), new MockMail163Provider()]
  const calendarProvider: CalendarProvider = new MockCalendarProvider()

  // LLM access (Spec §17.6/§17.8). The key is encrypted at rest by the
  // SecretStore (safeStorage → macOS Keychain) and NEVER crosses to the
  // renderer; settings.json holds only the non-secret {provider, modelId}.
  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), safeStorage)
  const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
  const modelGateway = createModelGateway(secrets, settings)
  const agentRuntime = createAgentRuntime(modelGateway)
  // Real Gmail provider — constructed once; connect swaps it into
  // emailProviders[0] (Spec §9). openExternal launches the OAuth browser flow.
  // `net.fetch` (Chromium network stack) routes Gmail/OAuth REST calls through
  // the system proxy/VPN — Node's undici fetch does not, so it times out
  // behind a proxy (e.g. CN networks reaching Google).
  const gmailProvider = new GmailProvider({
    secrets,
    openExternal: (url) => shell.openExternal(url),
    fetch: net.fetch
  })
  // Real 163 Mail provider (Spec §9). 163 is domestic (CN) — IMAP/SMTP use
  // direct TCP (Node net/tls), reachable without a proxy, so unlike Gmail it
  // needs no proxy-aware fetch. email + 授权码 are stored in the SecretStore.
  const mail163Provider = new Mail163Provider({ secrets })

  // Real Feishu Calendar provider (Spec §10). User-OAuth; app_id/app_secret +
  // user refresh token in the SecretStore. `net.fetch` (Chromium stack) routes
  // open.feishu.cn through the system proxy if present (mirrors Gmail). The
  // swappable delegate holds mock-by-default and swaps to this on connect.
  const feishuProvider = new FeishuCalendarProvider({
    secrets,
    openExternal: (url) => shell.openExternal(url),
    fetch: net.fetch
  })
  const calendarDelegate = new SwappableCalendarProvider(calendarProvider)

  // Real boss-cli subprocess provider (boss-cli integration). boss-cli auth is
  // cookie-based (handled by boss-cli itself); `getStatus` validates the saved
  // session. The swappable delegate holds mock-by-default and swaps to this
  // when `boss status` is authenticated. If boss-cli is not installed,
  // getStatus returns 'disconnected' and the mock stays active.
  const bossCliProvider = new BossCliProvider()
  const bossDelegate = new SwappableBossProvider(new MockBossProvider())
  const applicationService = new ApplicationService(store, bossDelegate, activityService)

  const toolRegistry = createToolRegistry()

  // NotificationService (Milestone D §D2) centralizes the user-facing notify
  // path: per-category / per-routine toggles, quiet hours (native-only
  // suppression), aggregation, and the native macOS Notification Center popup.
  // The robot bubble + native notifier are injected so the service stays
  // framework-agnostic; prefs are cached and refreshed at boot + on every
  // `setNotificationPrefs` write.
  const notificationService = new NotificationService({
    readPrefs: () => settings.readNotifications(),
    pushBubble: (n) => pushRobotNotify(n),
    notifier: (title, body) => {
      try {
        new Notification({ title, body }).show()
      } catch {
        // Unsupported / denied — the robot bubble already surfaced.
      }
    }
  })
  void notificationService.refreshPrefs()

  // Robot state is owned by the RobotStateController, which derives it from
  // Activity events (Spec §18: the robot reflects real runtime state). The
  // notify callback below only emits a proactive bubble — it no longer sets a
  // hard-coded state. The activity subscriber also bubbles approval requests.
  const robotState = new RobotStateController({
    onChange: (s) => setRobotState(s)
  })
  activityService.subscribe((e) => {
    robotState.onEvent(e)
    if (e.type === 'approval_requested') {
      // Proactive approval bubble — routed through NotificationService so the
      // `approval` category toggle + quiet hours apply uniformly.
      notificationService.notify({
        message: e.summary,
        category: 'approval',
        navigateTo: 'Approvals'
      })
    }
  })

  // desktop.notify pushes a proactive bubble to the robot window (M4 §18).
  // State transitions are handled by the activity subscriber above.
  const notify = (message: string): void => {
    pushRobotNotify({ message })
  }

  const broadcastActivity = (runId?: string): void => {
    const events = activityService.list(runId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.ACTIVITY_CHANGED, events)
    }
  }

  const broadcastApprovals = (): void => {
    const approvals = approvalService.list()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.APPROVAL_CHANGED, approvals)
    }
  }

  const broadcastMemory = (): void => {
    const items = memoryService.list()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.MEMORY_CHANGED, items)
    }
  }

  const broadcastApplications = (): void => {
    const views = applicationService.list()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.APPLICATION_CHANGED, views)
    }
  }

  const broadcastEmailMatches = (): void => {
    const matches = applicationService.listPendingEmailMatches()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.EMAIL_MATCHES_CHANGED, matches)
    }
  }
  applicationService.setEmailMatchesListener(broadcastEmailMatches)

  // Reconcile the emailProviders array with the real Gmail + 163 connection
  // state. Real providers are kept in the array when connected (Gmail at index 0)
  // and removed when disconnected so the mocks take over again. The array is the
  // same reference the engine reads each buildContext, so in-place swaps are
  // visible to the running engine without re-wiring.
  const refreshEmailProviders = async (): Promise<void> => {
    // Gmail → index 0 when connected (email.list with no accountId picks it).
    const gmailConnected = (await gmailProvider.getStatus()) === 'connected'
    const gmailIdx = emailProviders.indexOf(gmailProvider)
    if (gmailConnected && gmailIdx !== 0) {
      if (gmailIdx >= 0) emailProviders.splice(gmailIdx, 1)
      emailProviders.unshift(gmailProvider)
    } else if (!gmailConnected && gmailIdx >= 0) {
      emailProviders.splice(gmailIdx, 1)
    }
    // 163 → present when connected (after Gmail, before any mock).
    const mail163Connected = (await mail163Provider.getStatus()) === 'connected'
    const mail163Idx = emailProviders.indexOf(mail163Provider)
    if (mail163Connected && mail163Idx < 0) {
      // Insert after a connected Gmail (index 0) if present, else at 0.
      const insertAt = gmailConnected && emailProviders[0] === gmailProvider ? 1 : 0
      emailProviders.splice(insertAt, 0, mail163Provider)
    } else if (!mail163Connected && mail163Idx >= 0) {
      emailProviders.splice(mail163Idx, 1)
    }
  }

  // Reconcile the swappable calendar delegate with Feishu connection state:
  // real Feishu when connected (so Meeting Prep / Daily Work Summary read the
  // user's real primary calendar), mock when disconnected (credential-free
  // path). The delegate is the single reference the engine + scheduler hold.
  const refreshCalendarProvider = async (): Promise<void> => {
    const connected = (await feishuProvider.getStatus()) === 'connected'
    calendarDelegate.swap(feishuProvider, connected)
  }

  // Reconcile the swappable boss delegate with boss-cli auth state: real
  // BossCliProvider when `boss status` is authenticated, mock otherwise. If
  // boss-cli is not installed, getStatus returns 'disconnected' and the mock
  // stays active (credential-free dev path). Called once at boot and on the
  // BOSS connect handler.
  const refreshBossProvider = async (): Promise<void> => {
    try {
      const connected = (await bossCliProvider.getStatus()) === 'connected'
      console.log(`[boss] refreshBossProvider: connected=${connected}`)
      bossDelegate.swap(bossCliProvider, connected)
    } catch (e) {
      console.error(`[boss] refreshBossProvider ERROR:`, e)
    }
  }

  const engine = new RoutineEngine({
    store,
    toolRegistry,
    activityService,
    taskService,
    needToKnowService,
    approvalService,
    memoryService,
    emailProviders,
    calendarProvider: calendarDelegate,
    bossProvider: bossDelegate,
    agentRuntime,
    applicationService,
    settings,
    notify: (m) => {
      notify(m)
      broadcastActivity()
      broadcastApprovals()
      broadcastMemory()
    },
    notifyRich: (input) => {
      // Route through NotificationService so prefs (per-routine toggle, quiet
      // hours, aggregation, native popup) apply, then sync renderer state.
      notificationService.notify(input)
      broadcastActivity()
      broadcastApprovals()
      broadcastMemory()
    }
  })

  const scheduler = new RoutineScheduler(engine, store, calendarDelegate, applicationService)

  // Seed preset routines, then start the scheduler.
  seedPresets(store)
  scheduler.start()

  // Daily 运势 (fortune) bubble (Milestone E). NOT a routine preset and NOT a
  // NTK item — the user chose the lightest surface (a robot bubble). A hidden
  // daily cron reads the user's birth data (non-secret settings.json), runs the
  // `generate_daily_fortune` agent step (deterministic stub when no LLM key),
  // and pushes one robot bubble via NotificationService (category 'fortune' →
  // respects per-category toggle + quiet hours + aggregation). 08:17 local,
  // off the :00 fleet-collision mark. The birth-data read is best-effort: no
  // birth data → the stub still produces a generic date-based fortune.
  const fortuneJob = cron.schedule('17 8 * * *', () => {
    void (async () => {
      try {
        const birth = await settings.readBirthData()
        const date = new Date().toISOString().slice(0, 10)
        const out = (await agentRuntime.runAgentStep('generate_daily_fortune', {
          birth,
          date
        })) as { title: string; summary: string; tip: string; mood: number }
        notificationService.notify({
          message: `${out.title}｜${out.summary}`,
          category: 'fortune'
        })
      } catch (err) {
        console.error(
          '[container] daily fortune failed:',
          err instanceof Error ? err.message : err
        )
      }
    })()
  })
  void fortuneJob

  container = {
    store,
    activityService,
    taskService,
    needToKnowService,
    approvalService,
    memoryService,
    toolRegistry,
    modelGateway,
    settings,
    agentRuntime,
    engine,
    scheduler,
    emailProviders,
    calendarProvider: calendarDelegate,
    calendarDelegate,
    feishuProvider,
    gmailProvider,
    mail163Provider,
    applicationService,
    bossProvider: bossDelegate,
    bossDelegate,
    bossCliProvider,
    notificationService,
    broadcastActivity,
    broadcastApprovals,
    broadcastMemory,
    broadcastApplications,
    broadcastEmailMatches,
    refreshEmailProviders,
    refreshCalendarProvider,
    refreshBossProvider
  }
  return container
}
