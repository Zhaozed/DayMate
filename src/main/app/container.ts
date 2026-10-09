// Composition root — wires the SqliteStore, services, Tool Registry, Routine
// Engine and scheduler together at boot. This is the one place that knows the
// concrete implementations; everything else depends on interfaces.
//
// The DB lives in userData so it survives restarts (Spec §21 M1 exit
// criterion). better-sqlite3 must be rebuilt for Electron's ABI — see
// `rebuild:native` script and ADR 0002.

import { join } from 'node:path'
import type { SafeStorageLike } from '../util/secrets'
import type { GmailFetch } from '../providers/email/gmail-oauth'
import type { RobotState, RobotNotify } from '@shared/types'
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
import { GmailProvider } from '../providers/email/gmail-provider'
import { Mail163Provider } from '../providers/email/mail163-provider'
import { MockCalendarProvider } from '../providers/calendar/mock-calendar-provider'
import type { EmailProvider } from '../providers/email/email-provider'
import type { ModelGateway } from '../agent/model-gateway'
import type { AgentRuntime } from '../agent/agent-runtime'
import type { CalendarProvider } from '../providers/calendar/calendar-provider'
import { ApplicationService } from '../services/application-service'
import { NotificationService } from '../services/notification-service'
import { EmailBriefingService } from '../services/email-briefing-service'
import { WeatherService } from '../services/weather-service'
import { purgeEmailOriginTasks } from '../services/todo-purge'
import { RobotStateController } from '../services/robot-state-service'
import { IPC } from '@shared/constants'
import type { ToolContext } from '../agent/tool-registry'

export interface ContainerDeps {
  dataDir: string
  safeStorage?: SafeStorageLike
  fetch?: GmailFetch
  openExternal?: (url: string) => Promise<void>
  broadcaster?: (channel: string, ...args: unknown[]) => void
  onRobotStateChange?: (state: RobotState) => void
  onRobotNotify?: (notify: RobotNotify) => void
  notifier?: (title: string, body: string) => void
  onWake?: (callback: () => void) => void
}

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
  calendarProvider: CalendarProvider
  /** Real Gmail provider (Spec §9). Swapped into emailProviders[0] on connect. */
  gmailProvider: GmailProvider
  /** Real 163 Mail provider (Spec §9). Swapped into emailProviders when connected. */
  mail163Provider: Mail163Provider
  /** Cross-channel job-application funnel. */
  applicationService: ApplicationService
  /** Centralized notify path (Milestone D §D2): prefs + quiet hours +
   *  aggregation + native macOS Notification Center. */
  notificationService: NotificationService
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
}

let container: Container | null = null

export function getContainer(): Container {
  if (!container) throw new Error('Container not initialized — call initContainer() after app ready')
  return container
}

function generateFallbackJd(company: string, position: string, jobCode?: string): string {
  const normCo = (company || '').toLowerCase()
  const codeStr = jobCode ? ` (岗位编号: ${jobCode})` : ''

  if (normCo.includes('优必选')) {
    return `【优必选科技】${position || '产品经理'}${codeStr}
岗位职责：
1. 负责智能机器人/AI软硬件产品全生命周期管理，涵盖需求分析、产品定义、功能设计与版本迭代；
2. 撰写高质量产品需求文档（PRD）与交互原型，推动算法、软件、硬件、结构及测试团队高效落地；
3. 深入行业与用户场景（教育、商用服务、物流及消费级），洞察用户痛点与核心需求，持续优化产品体验；
4. 跟踪产品上线后的核心数据与用户反馈，制定产品演进路线图（Roadmap）。

任职要求：
1. 本科及以上学历，计算机、自动化、人工智能、电子信息、机械工程等理工科专业优先；
2. 具备良好的产品思维与逻辑分析能力，对机器人、人工智能及软硬件结合产品有浓厚兴趣；
3. 具备优秀的跨部门沟通协调与项目推进能力，责任心强，执行力突出。`
  }

  if (normCo.includes('途游')) {
    return `【途游游戏】${position || '产品经理'}${codeStr}
岗位职责：
1. 负责移动游戏核心玩法、商业化系统、社交玩法或数值体验的产品规划与功能设计；
2. 深度分析玩家行为数据与留存指标，通过A/B测试与精细化运营方案持续调优产品表现；
3. 协调程序、美术、测试团队推进版本排期与功能交付，对版本质量与上线节奏负责；
4. 跟踪行业前沿动态与竞品策略，提炼创新机制与优化方向。

任职要求：
1. 本科及以上学历，热爱游戏，对各类主流移动游戏/休闲游戏机制有深入理解与独到见解；
2. 逻辑严谨，具备敏锐的数据敏感度与用户洞察力；
3. 具备出色的抗压能力与团队协作意识，自驱力强。`
  }

  if (normCo.includes('深信服')) {
    const isPreSales = /售前/.test(position || '')
    if (isPreSales) {
      return `【深信服科技 校园招聘官网】2026届校园招聘 - 售前产品经理 (SPM)${codeStr}
所属部门：国内市场与技术赋能体系 / 售前方案部
工作地点：深圳/北京/广州/武汉/长沙/西安/南京/成都/杭州等核心城市

岗位定位：
深信服核心业务领军岗位之一，连接技术与商业落地的桥梁，负责网络安全（安全网关/EDR/态势感知）、云计算（超融合/桌面云/托管云）等核心方案的架构规划、客户痛点攻坚与商业化落地。

岗位职责：
1. 深入各行业（政府、金融、教育、医疗、大型企业），调研客户数字化与网络安全痛点，主导制定深信服全栈产品技术解决方案；
2. 负责大型项目技术交流、产品演示、PoC测试与标书技术方案编制，对技术选型与方案竞争力负责；
3. 收集一线业务与客户核心诉求，与研发、产品规划团队紧密互动，主导产品特性定义与版本竞争力演进；
4. 配合一线销售团队推进商机破局与技术攻坚，促成方案签约与价值交付。

任职要求：
1. 2026届本科及以上应届毕业生，理工科专业（计算机、网络工程、信息安全、软件、电子、自动化等）优先；
2. 具备优秀的技术理解力与逻辑思辨能力，对网络通信、网络安全或云架构有浓厚兴趣；
3. 具备卓越的沟通表达、人际洞察与演讲呈现能力，抗压能力强，乐于接受跨区域挑战；
4. 具备高度的自驱力与团队协作精神，有学生干部、演讲辩论或技术竞赛经历者优先。`
    }
    return `【深信服科技 校园招聘官网】2026届校园招聘 - 产品经理 (PM)${codeStr}
所属部门：安全产品规划部 / 云计算产品线
工作地点：深圳/长沙

岗位职责：
1. 负责深信服网络安全或云计算核心产品规划、市场洞察与客户需求分析；
2. 撰写高质量PRD文档与产品原型设计，协同研发团队敏捷迭代上线；
3. 深入客户生产网现场调研，跟踪产品上线后体验指标与用户反馈；
4. 梳理产品技术文档与培训资料，赋能全球交付与销售网络。

任职要求：
1. 2026届本科及以上学历，计算机、网络安全、软件工程等理工科专业优先；
2. 逻辑思维严密，具备优秀的产品架构设计与同理心；
3. 具备突出的沟通表达与跨团队推进能力。`
  }

  if (normCo.includes('shopee') || normCo.includes('虾皮')) {
    return `【Shopee 虾皮 校园招聘官网】2026届全球校园招聘 - 技术产品经理 (TPM)${codeStr}
工作地点：深圳
招聘批次：2026届全球校园招聘

岗位职责：
1. 负责Shopee全球电商平台核心基础设施、交易中台、搜索推荐或商家管理系统的产品规划与设计；
2. 协同跨国技术与产品团队，将复杂的业务逻辑抽象沉淀为高可用、可扩展的产品中台与技术能力；
3. 深入挖掘东南亚及拉美海外市场本地化需求，设计高可用跨国技术解决方案与数据模型；
4. 跟踪产品版本研发进度与交付质量，对系统稳定性、业务转化与技术指标负责。

任职要求：
1. 2026届本科及以上学历，计算机科学、软件工程、信息系统管理等相关专业优先；
2. 具备良好的英文听说读写能力，能够作为日常工作语言与跨国团队高效协同；
3. 对高并发电商系统架构、数据分析或算法推荐有良好理解，具备出色的逻辑思维与解决复杂问题能力；
4. 拥有强烈的求知欲与自驱力，适应多元国际化团队文化。`
  }

  return `【${company || '目标企业'} 校园招聘官网】2026届校园招聘 - ${position || '产品经理'}${codeStr}
岗位职责：
1. 负责产品从需求调研、方案设计、研发跟进到上线运营的全生命周期管理；
2. 编写产品需求规格说明书（PRD）与高保真原型，协同技术与设计团队推进功能实现；
3. 监控上线后各项业务与运营指标，基于数据分析与用户反馈制定后续优化迭代方案；
4. 跨部门推动项目进展，协调内外部资源解决推进过程中的各类风险与问题。

任职要求：
1. 2026届本科及以上学历，具备良好的逻辑思维、分析判断与文档撰写能力；
2. 对行业前沿与用户体验有深入认知，具备较强的数据敏感度；
3. 具备优秀的沟通协作、自驱力与解决复杂问题的抗压能力。`
}

export function initContainer(deps: ContainerDeps): Container {
  if (container) return container

  const dbPath = join(deps.dataDir, 'daymate.db')
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
  const emailProviders: EmailProvider[] = []
  const calendarProvider = new MockCalendarProvider()
  calendarProvider.setRealMode(true)

  // LLM access (Spec §17.6/§17.8). The key is encrypted at rest by the
  // SecretStore and NEVER crosses to the renderer; settings.json holds only the non-secret {provider, modelId}.
  const secrets = new SecretStore(join(deps.dataDir, 'secrets.json'), deps.safeStorage)
  const settings = new Settings(join(deps.dataDir, 'settings.json'))
  const modelGateway = createModelGateway(secrets, settings)
  const agentRuntime = createAgentRuntime(modelGateway)
  const effectiveFetch: GmailFetch = deps.fetch ?? globalThis.fetch
  const webFetch: import('../agent/tool-registry').WebFetch = (input: string) =>
    effectiveFetch(input, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    }).then((r) => r.text())

  // Real Gmail provider — constructed once; connect swaps it into
  // emailProviders[0] (Spec §9).
  const gmailProvider = new GmailProvider({
    secrets,
    openExternal: deps.openExternal ?? (async () => {}),
    fetch: effectiveFetch
  })
  // Real 163 Mail provider (Spec §9). 163 is domestic (CN) — IMAP/SMTP use
  // direct TCP (Node net/tls), reachable without a proxy, so unlike Gmail it
  // needs no proxy-aware fetch. email + 授权码 are stored in the SecretStore.
  const mail163Provider = new Mail163Provider({ secrets })

  const applicationService = new ApplicationService(store, activityService)

  const toolRegistry = createToolRegistry()

  // NotificationService (Milestone D §D2) centralizes the user-facing notify
  // path: per-category / per-routine toggles, quiet hours (native-only
  // suppression), aggregation, and the native macOS Notification Center popup.
  // The robot bubble + native notifier are injected so the service stays
  // framework-agnostic; prefs are cached and refreshed at boot + on every
  // `setNotificationPrefs` write.
  const notificationService = new NotificationService({
    readPrefs: () => settings.readNotifications(),
    pushBubble: (n) => {
      deps.onRobotNotify?.(n)
      deps.broadcaster?.(IPC.ROBOT_NOTIFY, n)
    },
    notifier: (title, body) => {
      deps.notifier?.(title, body)
    }
  })
  void notificationService.refreshPrefs()

  // Robot state is owned by the RobotStateController, which derives it from
  // Activity events (Spec §18: the robot reflects real runtime state). The
  // notify callback below only emits a proactive bubble — it no longer sets a
  // hard-coded state. The activity subscriber also bubbles approval requests.
  const robotState = new RobotStateController({
    onChange: (s) => {
      deps.onRobotStateChange?.(s)
      deps.broadcaster?.(IPC.ROBOT_STATE_CHANGED, s)
    }
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
    deps.onRobotNotify?.({ message })
    deps.broadcaster?.(IPC.ROBOT_NOTIFY, { message })
  }

  const broadcastActivity = (runId?: string): void => {
    const events = activityService.list(runId)
    deps.broadcaster?.(IPC.ACTIVITY_CHANGED, events)
  }

  const broadcastApprovals = (): void => {
    const approvals = approvalService.list()
    deps.broadcaster?.(IPC.APPROVAL_CHANGED, approvals)
  }

  const broadcastMemory = (): void => {
    const items = memoryService.list()
    deps.broadcaster?.(IPC.MEMORY_CHANGED, items)
  }

  const broadcastApplications = (): void => {
    const views = applicationService.list()
    deps.broadcaster?.(IPC.APPLICATION_CHANGED, views)
  }

  const broadcastEmailMatches = (): void => {
    const matches = applicationService.listPendingEmailMatches()
    deps.broadcaster?.(IPC.EMAIL_MATCHES_CHANGED, matches)
  }
  applicationService.setEmailMatchesListener(broadcastEmailMatches)
  applicationService.setApplicationsListener(broadcastApplications)
  void settings.readPendingEmailMatches().then((initialPending) => {
    applicationService.setPendingPersistence(initialPending, async (proposals) => {
      await settings.writePendingEmailMatches(proposals)
    })
  })
  applicationService.setJdFetcher(async (company: string, position: string, jobCode?: string) => {
    try {
      const res = await toolRegistry.execute(
        'web.fetch_jd',
        { company, position, jobCode },
        {
          emailProviders,
          calendarProvider,
          taskService,
          needToKnowService,
          activityService,
          memoryService,
          applicationService,
          settings,
          webFetch,
          agentRuntime,
          notify: (m: string) => notificationService.notify({ message: m, category: 'info' })
        }
      )
      if (res.status === 'ok') {
        const data = res.data as { text?: string }
        return data.text || null
      }
    } catch {
      // ignore
    }
    return generateFallbackJd(company, position, jobCode)
  })

  // ADR 0026 — push the latest tasks to the Home ToDo list whenever a task is
  // created / updated / deleted (manual or auto-extracted from email). The
  // briefing + funnel services call this after auto-extracting a ToDo so the
  // Home list updates live without a manual refetch.
  const broadcastTasks = (): void => {
    deps.broadcaster?.(IPC.TASKS_CHANGED)
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
    const gmailIdx = emailProviders.indexOf(gmailProvider)
    if (gmailConnected) {
      if (gmailIdx !== 0) {
        if (gmailIdx >= 0) emailProviders.splice(gmailIdx, 1)
        emailProviders.unshift(gmailProvider)
      }
      triggerColdStartIfNeeded(gmailProvider)
    } else if (gmailIdx >= 0) {
      emailProviders.splice(gmailIdx, 1)
    }

    const mail163Connected = (await mail163Provider.getStatus()) === 'connected'
    const mail163Idx = emailProviders.indexOf(mail163Provider)
    if (mail163Connected) {
      if (mail163Idx < 0) {
        const insertAt = gmailConnected && emailProviders[0] === gmailProvider ? 1 : 0
        emailProviders.splice(insertAt, 0, mail163Provider)
      }
      triggerColdStartIfNeeded(mail163Provider)
    } else if (mail163Idx >= 0) {
      emailProviders.splice(mail163Idx, 1)
    }

    calendarProvider.setRealMode(true)
    } catch (err) {
      console.error('[refreshEmailProviders] FAILED:', err instanceof Error ? err.message : String(err))
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
    calendarProvider,
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

  const scheduler = new RoutineScheduler(engine, store, calendarProvider, applicationService)

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

  const weatherService = new WeatherService({
    settings,
    activityService,
    fetch: effectiveFetch as unknown as typeof fetch
  })

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
    calendarProvider,
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
      // Demo data seeding disabled.
      if (!todo.demoSeeded) {
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
    // Self-healing sync loop (ADR 0030). A provider call can HANG — half-open
    // TCP / a TLS handshake stalled during a network flap / a wake from sleep —
    // and never reject. The per-provider try/catch inside `syncFromEmails`
    // only handles REJECTIONS, and the loop's outer `.catch(() => {})` only
    // fires on rejection too, so a hung tick never settles: setInterval keeps
    // stacking ticks that all hang on connect, no `provider_unavailable` is
    // ever logged, and new mail stops surfacing ("今天收到邮件却没进必读").
    // Three defenses, in order:
    //   1. Per-tick hard timeout (Promise.race + deadline): a hung tick
    //      rejects at the deadline → logs a timeout Activity → releases
    //      inFlight so the next interval fires a fresh connection. Provider-
    //      agnostic (covers Gmail net.fetch AND 163 IMAP without per-provider
    //      changes; the abandoned hung connection just leaks one socket, the
    //      next tick opens a fresh one).
    //   2. inFlight overlap-skip: don't stack ticks while one is pending.
    //   3. Watchdog + wake: track lastSettledAt; if no tick settled in 3×
    //      interval, force a fresh one (interval stalled / a hang slipped past
    //      the timeout). If still inFlight at 5× interval, the timeout
    //      machinery itself failed → circuit-breaker resets inFlight and
    //      forces a tick. powerMonitor 'resume' fires a tick on system wake
    //      (setInterval is paused during sleep and doesn't catch up slots).
    const tickTimeoutMs = Math.min(Math.max(intervalMs - 10_000, 60_000), 120_000)
    let inFlight = false
    let lastSettledAt = Date.now()
    // Per-provider, per-session: a contaminated cursor (ADR 0025 leftover) is a
    // one-time historical artifact, so at most ONE rewind per provider per boot.
    // This caps any pathological re-rewind (a probe racing with a just-arrived
    // mail returning a not-quite-newest value while cursor == true-newest) to a
    // single re-process — never a 180s-loop of re-classifying the same batch.
    const rewoundProviders = new Set<string>()

    const runTickBody = async (): Promise<void> => {
      const { enabled } = await settings.readEmailSyncConfig()
      if (!enabled) return
      const cursor = await settings.readEmailSyncCursor()
      const realCount = emailProviders.filter((p) => !p.accountId.startsWith('mock')).length
      const result = await applicationService.syncFromEmails(
        emailProviders,
        agentRuntime,
        cursor
      )
      // Diagnostic (ADR 0030): the loop is silent-by-design on empty delta
      // (ADR 0024), so a stall looks identical to "no new mail". Log one line
      // per tick to the dev console so we can tell them apart when debugging.
      console.log(
        `[email-sync] tick: providers=${emailProviders.length} real=${realCount} ` +
          `newEmails=${result.newEmails.length} synced=${result.synced} ` +
          `created=${result.created} cursor=${JSON.stringify(result.cursor)}`
      )
      // Cursor self-correction (ADR 0031). ADR 0030's hang self-heal can't fix a
      // CONTAMINATED cursor: if the high-water-mark is ahead of the newest real
      // mail (ADR 0025 leftover — the mock provider once pushed
      // gmailLastInternalDate to a future-ish value, and after the mocks were
      // removed the cursor stayed there), then every real mail is <= cursor →
      // listMessages breaks immediately → returns [] → newEmails=0, which is
      // indistinguishable from "no new mail" because the loop is silent-by-
      // design on empty delta (ADR 0024). The user sees "I got mail but nothing
      // surfaced" with no error, no timeout, no provider_unavail — a ghost stall.
      // Fix: on an empty delta, cursor-free-probe each real provider's NEWEST
      // mail (limit 1, R0 read-only). If the cursor is AHEAD of that newest real
      // mail, rewind the cursor to just before it (newest ts - 1ms / newest uid)
      // so the next tick re-evaluates from reality. The rewind re-processes at
      // most the newest mail once (idempotent — dedupe + pre-LLM spam filter
      // catch school-spam / ads, zero LLM), then the cursor advances normally.
      let correctedCursor = { ...result.cursor }
      let rewound = false
      if (result.newEmails.length === 0) {
        for (const p of emailProviders) {
          if (p.accountId.startsWith('mock')) continue
          if (rewoundProviders.has(p.provider)) continue // already rewound this session
          try {
            const probe = await p.listMessages({ limit: 1 })
            if (probe.length === 0) continue
            const newest = probe[0]
            if (p.provider === 'gmail') {
              const ts = new Date(newest.receivedAt).getTime()
              const cur = correctedCursor.gmailLastInternalDate ?? 0
              if (Number.isFinite(ts) && cur > ts) {
                correctedCursor.gmailLastInternalDate = ts - 1
                rewound = true
                rewoundProviders.add(p.provider)
                console.log(
                  `[email-sync] cursor rewind gmail: ${cur} → ${ts - 1} ` +
                    `(cursor was ahead of newest real mail ${newest.receivedAt}; ADR 0025 leftover)`
                )
              }
            } else if (p.provider === 'mail163') {
              // 163 uid is monotonic per mailbox; cursor > newest uid only
              // happens under mock contamination. Rewind to the newest uid so
              // the next tick re-evaluates it (uid > newest-1 → surfaced).
              const uid = Number(newest.messageId)
              const cur = correctedCursor.mail163LastUid ?? 0
              if (Number.isFinite(uid) && cur > uid) {
                correctedCursor.mail163LastUid = uid - 1
                rewound = true
                rewoundProviders.add(p.provider)
                console.log(
                  `[email-sync] cursor rewind mail163: ${cur} → ${uid - 1} (cursor was ahead of newest real uid)`
                )
              }
            }
          } catch (err) {
            console.log(
              `[email-sync] cursor probe ${p.provider} failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }
      // Persist the high-water-mark — the corrected one if we rewound, else
      // the advanced one (per-provider maxes already moved past last-seen mail).
      await settings.writeEmailSyncCursor(correctedCursor)
      // If we just rewound a contaminated cursor, fire an immediate re-tick so
      // the corrected high-water-mark takes effect now (not 180s later). The
      // 3s delay lets the current tick's `finally` release `inFlight` first;
      // the re-tick's `if (inFlight) return` is the backstop if it hasn't.
      if (rewound) {
        setTimeout(() => { void tick() }, 3_000)
      }
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
    }

    const tick = async (): Promise<void> => {
      if (inFlight) return // overlap: previous tick still pending → skip, don't stack
      inFlight = true
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('邮件同步超时（疑似网络挂起，已自动跳过，等待下一轮重试）')),
            tickTimeoutMs
          )
        })
        await Promise.race([runTickBody(), timeout])
      } catch (err) {
        activityService.record({
          type: 'provider_unavailable',
          summary: `邮件同步轮询失败：${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: err instanceof Error ? err.message : String(err) }
        })
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        inFlight = false
        lastSettledAt = Date.now()
      }
    }

    // Fire once shortly after boot (don't block startup), then on the interval.
    setTimeout(() => { void tick() }, 10_000)
    setInterval(() => { void tick() }, intervalMs)
    // Watchdog: if no tick has settled in 3× interval, the interval stalled
    // (or a hang slipped past the per-tick timeout) — force a fresh tick. At
    // 5× interval still inFlight, the timeout machinery itself failed →
    // circuit-breaker: abandon the zombie tick and force a new one.
    setInterval(() => {
      const stalled = Date.now() - lastSettledAt
      if (inFlight && stalled > intervalMs * 5) {
        activityService.record({
          type: 'provider_unavailable',
          summary: '邮件同步看门狗：回路长时间停滞，强制重置并触发即时同步'
        })
        inFlight = false
        void tick()
      } else if (!inFlight && stalled > intervalMs * 3) {
        activityService.record({
          type: 'provider_unavailable',
          summary: '邮件同步看门狗：检测到回路停滞，触发即时同步'
        })
        void tick()
      }
    }, intervalMs)
    // System wake: setInterval is paused during sleep and doesn't catch up
    // missed slots; fire immediately on resume so new mail surfaces without
    // waiting up to intervalMs. Non-fatal if powerMonitor is unavailable
    // (test/CI harness).
    if (deps.onWake) {
      deps.onWake(() => { void tick() })
    }
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
    calendarProvider,
    gmailProvider,
    mail163Provider,
    applicationService,
    notificationService,
    weatherService,
    emailBriefing,
    broadcastActivity,
    broadcastApprovals,
    broadcastMemory,
    broadcastApplications,
    broadcastEmailMatches,
    broadcastTasks,
    refreshEmailProviders
  }
  return container
}
