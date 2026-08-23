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
import { EmailBriefingService } from '../services/email-briefing-service'
import { WeatherService } from '../services/weather-service'
import { purgeEmailOriginTasks } from '../services/todo-purge'
import { RobotStateController } from '../services/robot-state-service'
import { setRobotState, pushRobotNotify } from '../ipc/handlers'
import { IPC } from '@shared/constants'
import type { ToolContext } from '../agent/tool-registry'

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
  /** Proxy-aware HTML fetch (Electron `net.fetch`) for `web.fetch_jd`. */
  webFetch: import('../agent/tool-registry').WebFetch
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
  /** Push a tasks-changed ping to the workbench Home ToDo list (ADR 0026). */
  broadcastTasks: () => void
  /** Daily weather briefing cache + refresh (ADR 0026 Home 今日天气). */
  weatherService: WeatherService
  /** Email-briefing pipeline (必读 + ToDo extraction + cold-start backfill,
   *  ADR 0022/0026/0027). Exposed for the manual re-scan IPC handler. */
  emailBriefing: EmailBriefingService
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
  const mockGmail = new MockEmailProvider()
  const mockMail163 = new MockMail163Provider()
  const emailProviders: EmailProvider[] = [mockGmail, mockMail163]
  const mockCalendar = new MockCalendarProvider()

  // LLM access (Spec §17.6/§17.8). The key is encrypted at rest by the
  // SecretStore (safeStorage → macOS Keychain) and NEVER crosses to the
  // renderer; settings.json holds only the non-secret {provider, modelId}.
  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), safeStorage)
  const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
  const modelGateway = createModelGateway(secrets, settings)
  const agentRuntime = createAgentRuntime(modelGateway)
  // Proxy-aware HTML fetch for `web.fetch_jd` (post-MVP JD enrichment).
  // `net.fetch` (Chromium stack) routes through the system proxy/VPN — same
  // reason Gmail/OAuth use it. Returns the response body as text. Wired into
  // the engine's EngineDeps (for routine `tool` steps) and exposed for the
  // on-demand APPLICATION_FETCH_JD handler.
  const webFetch: import('../agent/tool-registry').WebFetch = (input: string) =>
    net.fetch(input).then((r) => r.text())

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
  const calendarDelegate = new SwappableCalendarProvider(mockCalendar)

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

  // ADR 0026 — push the latest tasks to the Home ToDo list whenever a task is
  // created / updated / deleted (manual or auto-extracted from email). The
  // briefing + funnel services call this after auto-extracting a ToDo so the
  // Home list updates live without a manual refetch.
  const broadcastTasks = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASKS_CHANGED)
    }
  }

  // Reconcile the emailProviders array with the real Gmail + 163 connection
  // state. Real providers are kept in the array when connected (Gmail at index 0)
  // and removed when disconnected so the mocks take over again. The array is the
  // same reference the engine reads each buildContext, so in-place swaps are
  // visible to the running engine without re-wiring.
  // ADR 0027 — one-time cold-start backfill per account. Triggered from
  // refreshEmailProviders the moment a real provider is confirmed connected
  // (and not already in `coldStartDone`). Fire-and-forget: never blocks boot or
  // the provider reconciliation. Reads `coldStartEnabled !== false` so the user
  // can opt out from the 集成与设置 page; marks the account done on completion
  // so a reconnect (or app restart) doesn't re-run the 60-day scan. State is
  // kept SEPARATE from the incremental EmailSyncCursor (keyed by accountId, not
  // provider type) so the sync loop's high-water-mark is untouched.
  // ADR 0027 — boot purge must settle BEFORE the cold-start trigger reads +
  // writes todo settings, else the two fire-and-forget writers race and
  // cold-start's writeTodo clobbers purge's `purgeDone` (→ every restart
  // re-purged email ToDos → they vanished after the 2nd boot because
  // cold-start wouldn't re-run). The gate resolves once the purge IIFE
  // completes (success or failure); the trigger awaits it before touching
  // settings. writeTodo also merges at field level now (defense in depth).
  let resolvePurgeGate: () => void = () => {}
  const purgeSettled: Promise<void> = new Promise((resolve) => {
    resolvePurgeGate = resolve
  })

  // In-flight cold-start backfills, so a reconnect mid-scan doesn't kick off
  // a duplicate scan (the account is marked done only AFTER backfill settles —
  // see below — so without this guard a second trigger would fire).
  const coldStartInFlight = new Set<string>()
  const triggerColdStartIfNeeded = (provider: EmailProvider): void => {
    void (async () => {
      try {
        // Wait for the one-time purge to land so our readTodo sees purgeDone
        // and our writeTodo (merged) preserves it.
        await purgeSettled
        const todo = await settings.readTodo()
        if (todo.coldStartEnabled === false) return
        const done = todo.coldStartDone ?? []
        if (done.includes(provider.accountId)) return
        if (coldStartInFlight.has(provider.accountId)) return
        coldStartInFlight.add(provider.accountId)
        // Mark done ONLY after the backfill settles (success). The previous
        // code marked done BEFORE the fire-and-forget backfill, so if the app
        // was killed mid-scan (restart during a 60-day gmail backfill), the
        // account stayed "done" but its history was never re-surfaced — the
        // incremental cursor is past those emails, so they were gone for good.
        // Leaving it un-marked on interruption makes the next boot re-fire.
        void emailBriefing
          .backfillAccount(provider, { batchSize: todo.backfillBatchSize })
          .then(async () => {
            coldStartInFlight.delete(provider.accountId)
            const t = await settings.readTodo()
            const d = t.coldStartDone ?? []
            if (!d.includes(provider.accountId)) {
              await settings.writeTodo({ ...t, coldStartDone: [...d, provider.accountId] })
            }
          })
          .catch(() => {
            // Leave un-marked so the next boot/reconnect retries. Don't spam
            // the activity log — backfillAccount already records failures.
            coldStartInFlight.delete(provider.accountId)
          })
      } catch (err) {
        coldStartInFlight.delete(provider.accountId)
        activityService.record({
          type: 'provider_unavailable',
          summary: `冷启动回填触发失败 ${provider.accountId}：${err instanceof Error ? err.message : String(err)}`,
          metadata: { accountId: provider.accountId }
        })
      }
    })()
  }

  const refreshEmailProviders = async (): Promise<void> => {
    try {
    // Gmail → real at index 0 when connected (email.list with no accountId
    // picks it); mock takes over when disconnected. CRITICAL: when the real
    // provider is connected the matching mock MUST be removed — otherwise both
    // coexist and the mock re-feeds its fixtures to the sync loop every round,
    // burning LLM on already-seen mail (cursor can't advance past mock
    // fixtures whose messageId is non-numeric → NaN).
    const gmailConnected = (await gmailProvider.getStatus()) === 'connected'
    if (gmailConnected) {
      const gmailIdx = emailProviders.indexOf(gmailProvider)
      if (gmailIdx !== 0) {
        if (gmailIdx >= 0) emailProviders.splice(gmailIdx, 1)
        emailProviders.unshift(gmailProvider)
      }
      const mockIdx = emailProviders.indexOf(mockGmail)
      if (mockIdx >= 0) emailProviders.splice(mockIdx, 1)
      triggerColdStartIfNeeded(gmailProvider)
    } else {
      const gmailIdx = emailProviders.indexOf(gmailProvider)
      if (gmailIdx >= 0) emailProviders.splice(gmailIdx, 1)
      if (emailProviders.indexOf(mockGmail) < 0) emailProviders.unshift(mockGmail)
    }
    // 163 → real present when connected (after Gmail); mock when disconnected.
    const mail163Connected = (await mail163Provider.getStatus()) === 'connected'
    if (mail163Connected) {
      const mail163Idx = emailProviders.indexOf(mail163Provider)
      if (mail163Idx < 0) {
        const insertAt = gmailConnected && emailProviders[0] === gmailProvider ? 1 : 0
        emailProviders.splice(insertAt, 0, mail163Provider)
      }
      const mockIdx = emailProviders.indexOf(mockMail163)
      if (mockIdx >= 0) emailProviders.splice(mockIdx, 1)
      triggerColdStartIfNeeded(mail163Provider)
    } else {
      const mail163Idx = emailProviders.indexOf(mail163Provider)
      if (mail163Idx >= 0) emailProviders.splice(mail163Idx, 1)
      if (emailProviders.indexOf(mockMail163) < 0) {
        const insertAt = gmailConnected && emailProviders[0] === gmailProvider ? 1 : 0
        emailProviders.splice(insertAt, 0, mockMail163)
      }
    }
    // ADR 0028 — mute the mock calendar fixtures the moment a real email
    // provider is connected (real user), so the morning_brief routine stops
    // generating fake "Q3 roadmap review" briefs. Harmless when Feishu is
    // connected (the delegate swaps to Feishu and never reads the mock).
    const hasRealEmail = emailProviders.some((p) => !p.accountId.startsWith('mock'))
    mockCalendar.setRealMode(hasRealEmail)
    } catch (err) {
      console.error('[refreshEmailProviders] FAILED:', err instanceof Error ? err.message : String(err))
    }
  }

  // Reconcile the swappable calendar delegate with Feishu connection state:
  // real Feishu when connected (so Meeting Prep / Daily Work Summary read the
  // user's real primary calendar), mock when disconnected (credential-free
  // path). The delegate is the single reference the engine + scheduler hold.
  const refreshCalendarProvider = async (): Promise<void> => {
    const connected = (await feishuProvider.getStatus()) === 'connected'
    calendarDelegate.swap(feishuProvider, connected)
    // ADR 0028 — when Feishu isn't connected but a real EMAIL provider is,
    // the user is real (not a fresh dev install): mute the mock calendar's
    // canned fixtures so the morning_brief routine stops generating fake
    // "Q3 roadmap review" briefs + the routine-extracted ToDo "Decide:
    // Approval Center in P0 or defer for Q3 roadmap". In real mode the mock
    // returns no events (honest: no calendar connected) instead of fake ones.
    // When no real email is connected either (dev/credential-free path), the
    // mock fixtures stay so the Routine Engine runs end-to-end (Spec rule 9).
    if (!connected) {
      const realEmail = emailProviders.some((p) => !p.accountId.startsWith('mock'))
      mockCalendar.setRealMode(realEmail)
    }
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
    webFetch,
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

  // Seed preset routines, then start the scheduler. (AI产品经理 demo funnel
  // data is seeded inside the ToDo-purge IIFE below — gated by a one-time
  // `demoSeeded` flag so it never re-seeds after a purge clears it.)
  seedPresets(store)
  // One-time cleanup: the auto_inbox routine (now retired — ADR 0024) used to
  // publish a "收件箱已分类" bucket-count NeedToKnow that was pure noise.
  // 必读 is now the curated daily brief only (mail-driven urgent/high, ADR
  // 0022/0023). Purge any stale rows with that exact title (both the zh-CN
  // localized title and the pre-localization English "Inbox classified" title)
  // so they don't linger in the 必读 list.
  needToKnowService.deleteByTitle('收件箱已分类')
  needToKnowService.deleteByTitle('Inbox classified')
  // One-time memory reconciliation: agent proposals now auto-confirm (no
  // manual confirmation gate), so nothing should be pending going forward.
  // Promote any legacy pending rows + collapse duplicates to one confirmed
  // value per key.
  memoryService.reconcile()
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

  // Daily weather briefing (ADR 0026 — Home 今日天气 card). Real weather is
  // fetched from wttr.in (no key, proxy-aware via Electron `net.fetch`) for the
  // user's configured city, then a daily LLM step (`generate_daily_weather`)
  // polishes it into a Chinese summary + clothing + practical 宜/忌 and caches
  // it in non-secret settings.json (keyed by date). The Home card reads the
  // cache; stale/absent → empty state with a "生成" button (WEATHER_REFRESH).
  // 27 8 — off the :00 fleet mark, after the 08:17 fortune bubble. One LLM call
  // per day; the no-key path falls back to the deterministic stub (zero LLM).
  const weatherService = new WeatherService({
    settings,
    agentRuntime,
    activityService,
    // `net.fetch` (Chromium stack) routes wttr.in through the system proxy; its
    // input type omits `URL` so a narrow cast satisfies the `typeof fetch` dep.
    fetch: net.fetch as unknown as typeof fetch
  })
  const weatherJob = cron.schedule('27 8 * * *', () => {
    void (async () => {
      try {
        await weatherService.refresh()
      } catch (err) {
        console.error(
          '[container] daily weather failed:',
          err instanceof Error ? err.message : err
        )
      }
    })()
  })
  void weatherJob

  // Mail-driven funnel feed (post-MVP rebuild). NOT a routine preset and NOT
  // scheduler-owned — a container-level setInterval polls every connected email
  // provider for NEW mail (per-provider high-water-mark cursor in non-secret
  // settings.json), runs `classify_application_email` on the delta only (token-
  // cost control), and the service aggressively auto-creates / appends-to
  // applications (user decision: 全部自动建). Independent of scheduler.pause
  // (mail is the primary feed; a paused routine schedule should not stall the
  // funnel). `enabled` is re-read each round so the user can toggle it live;
  // the interval is read once at boot (a cadence change needs a restart). Per-
  // round try/catch — a failed round logs an Activity and never kills the loop.
  //
  // After the funnel pass, the SAME delta is handed to EmailBriefingService,
  // which runs `classify_inbox` (topic dimension) to surface important mail
  // (招聘 / 账单 / 会议 / 导师 / reply-needed) as urgent/high 必读 and, for
  // reply-needed important mail, auto-saves a tone-mirrored draft to the
  // Drafts folder (R1, no approval — §15 exception, ADR 0022). The briefing
  // records its own Activity on success, which is the 必读 page's refetch
  // signal (it has no dedicated push channel).
  const briefingToolContext: ToolContext = {
    emailProviders,
    calendarProvider: calendarDelegate,
    bossProvider: bossDelegate,
    taskService,
    needToKnowService,
    activityService,
    memoryService,
    applicationService,
    settings,
    webFetch,
    notify: (m: string) => notificationService.notify({ message: m, category: 'info' })
  }
  const emailBriefing = new EmailBriefingService({
    agentRuntime,
    needToKnowService,
    toolRegistry,
    memoryService,
    emailProviders,
    activityService,
    toolContext: briefingToolContext,
    // ADR 0026 — auto-extract ToDos from the 必读 classify pass (todoTitle).
    taskService,
    onTasksChanged: broadcastTasks
  })
  // ADR 0026 — auto-extract ToDos from the funnel classify pass (面试/笔试
  // notices with todoTitle). The setter avoids touching the ApplicationService
  // constructor signature (a circular-dep-risky wide ctor).
  applicationService.setTaskExtraction(taskService, broadcastTasks)

  // ADR 0027 — wire ToDo pipeline settings (school-spam skip tokens) + one-time
  // purge of legacy email-origin ToDos / 必读 / 投递 (unreadable stub titles,
  // mock mail, fake low-confidence recruiting-outlook 投递, junk NTKs the
  // pre-fix surface logic let through). Gated by `settings.todo.purgeVersion`
  // — bump the version to re-run once after a filtering fix so the cold-start
  // re-backfill regenerates a clean set with the fixed filters. Fire-and-forget;
  // the cold-start trigger `await purgeSettled`s this so it lands first.
  void (async () => {
    try {
      const todo = await settings.readTodo()
      const tokens = todo.skipTokens && todo.skipTokens.length > 0
        ? todo.skipTokens
        : ['[student_ips]']
      emailBriefing.setSkipTokens(tokens)
      applicationService.setSkipTokens(tokens)
      // ADR 0027 fix — one-time demo-seed gate. `seedDemoData()` seeds
      // AI产品经理 demo 投递 (source:'email') whenever the funnel is empty.
      // Its own `hasRealData` guard treats its demo rows as "real", so once a
      // versioned purge wipes them the guard drops and seedDemoData RE-SEEDS
      // on every subsequent boot → fake 投递 persist forever for a real user
      // with connected providers ("我啥时候投递过"). Gate the seed behind a
      // one-time `demoSeeded` flag (never reset by the purge) so demo data
      // seeds at most once ever; after the purge clears it, it stays cleared.
      if (!todo.demoSeeded) {
        applicationService.seedDemoData()
        await settings.writeTodo({ demoSeeded: true })
      }
      // Bump PURGE_VERSION after each filtering fix that needs to re-clear
      // stale email-origin items + re-backfill. v2 = respect LLM `ignore` +
      // gate 投递 creation on confidence. v3 = drop bulk mail from 必读
      // entirely (LinkedIn ads / game notifications were surfacing via the
      // keyword carve-out). v4 = clear the re-seeded demo 投递 tug-of-war
      // (now blocked by `demoSeeded` so they won't reappear). v5 = clear
      // mock-sourced morning_brief NTKs + routine-extracted mock ToDos (the
      // mock calendar "Q3 roadmap" event fed morning_brief before real
      // providers connected; mock calendar now muted in real mode). v6 = clear
      // DISMISSED mock-sourced NTKs too (a user dismissed the "Q3 roadmap"
      // mock brief before real providers connected; `list()` excludes
      // dismissed so they survived v5 — `listAll()` scans the full table).
      // v7 = ADR 0029 必读 redesign: the old NTKs are one-per-email with no
      // threadId / briefingCategory / sourceProvider / sourceLink, so the new
      // thread-aggregated 4-section page would render them all under 其他
      // with no source badge / no expand. Purge them so the cold-start re-
      // backfill rebuilds every surfaced email as a thread-merged item with
      // the new fields + relaxed filter (operation-triggered bulk now kept).
      // v8 = ADR 0029 fix: the v7 `operationTriggered` surface arm force-
      // surfaced ANY bulk that cleared the pre-LLM ads/codes/alerts gate as
      // `medium`, overriding the LLM `ignore`. Grab / Malay promo marketing
      // ("Flash Sale" / "Deals" / "Diskaun" / "happy prices") the narrow
      // ADS_KEYWORD_RE missed flooded 必读 ("啥内容都没有"). Fix: surface
      // gate back to `important || actionable` (operation-triggered mail the
      // user cares about — 投递/面试/账单/会议 — lands on an important topic
      // anyway) + always respect the LLM `ignore`. Purge the junk NTKs the
      // broken arm let through so the cold-start re-backfill rebuilds clean.
      // v9 = 必读 headline swap: title is now the model's Chinese summary
      // (r.reason), with the raw email subject demoted to a subtitle. Existing
      // NTKs were created with title=subject (old behavior), so purge + re-
      // backfill to rebuild them with title=reason. Also widens the ToDo
      // todoTitle cap 25→40 chars so the advisor/sender name fits.
      const PURGE_VERSION = 9
      if ((todo.purgeVersion ?? 0) < PURGE_VERSION) {
        const purged = purgeEmailOriginTasks(
          taskService,
          applicationService,
          needToKnowService
        )
        const total = purged.tasks + purged.applications + purged.ntk
        if (total > 0) {
          activityService.record({
            type: 'tool_completed',
            summary: `清理旧邮件数据：待办 ${purged.tasks} / 必读 ${purged.ntk} / 投递 ${purged.applications} 条（已由冷启动回填按修复后过滤重建）`,
            metadata: { purged }
          })
        }
        // Reset coldStartDone so triggerColdStartIfNeeded re-fires the 60-day
        // backfill once with the FIXED filters (writeTodo MERGES, so this only
        // touches coldStartDone — purgeVersion/purgeDone/skipTokens survive).
        await settings.writeTodo({
          purgeVersion: PURGE_VERSION,
          purgeDone: true,
          skipTokens: tokens,
          coldStartDone: []
        })
      }
    } catch (err) {
      activityService.record({
        type: 'provider_unavailable',
        summary: `ToDo 设置初始化失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      // Release the cold-start trigger's gate regardless of outcome so it
      // never deadlocks waiting on a failed purge.
      resolvePurgeGate()
    }
  })()
  const startEmailSyncLoop = async (): Promise<void> => {
    const { intervalSec } = await settings.readEmailSyncConfig()
    const intervalMs = Math.max(60, intervalSec) * 1000
    const tick = async (): Promise<void> => {
      try {
        const { enabled } = await settings.readEmailSyncConfig()
        if (!enabled) return
        const cursor = await settings.readEmailSyncCursor()
        const result = await applicationService.syncFromEmails(
          emailProviders,
          agentRuntime,
          cursor
        )
        // Persist the advanced high-water-mark (even on empty / partial rounds
        // — the per-provider maxes already moved past the last-seen mail).
        await settings.writeEmailSyncCursor(result.cursor)
        // Surface changes only when something actually happened (avoid
        // spamming the renderer with empty broadcasts every 180s).
        if (result.synced > 0 || result.created > 0 || result.pending > 0) {
          broadcastApplications()
          broadcastEmailMatches()
        }
        // Brief the same delta into 必读 + (for reply-needed important mail)
        // a draft. Runs after the funnel pass so the cursor is already advanced.
        if (result.newEmails.length > 0) {
          await emailBriefing.briefNewEmails(result.newEmails)
        }
      } catch (err) {
        activityService.record({
          type: 'provider_unavailable',
          summary: `邮件同步轮询失败：${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: err instanceof Error ? err.message : String(err) }
        })
      }
    }
    // Fire once shortly after boot (don't block startup), then on the interval.
    setTimeout(() => void tick().catch(() => {}), 10_000)
    setInterval(() => void tick().catch(() => {}), intervalMs)
  }
  void startEmailSyncLoop()

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
    webFetch,
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
    weatherService,
    emailBriefing,
    broadcastActivity,
    broadcastApprovals,
    broadcastMemory,
    broadcastApplications,
    broadcastEmailMatches,
    broadcastTasks,
    refreshEmailProviders,
    refreshCalendarProvider,
    refreshBossProvider
  }
  return container
}
