// Composition root — wires the SqliteStore, services, Tool Registry, Routine
// Engine and scheduler together at boot. This is the one place that knows the
// concrete implementations; everything else depends on interfaces.
//
// The DB lives in userData so it survives restarts (Spec §21 M1 exit
// criterion). better-sqlite3 must be rebuilt for Electron's ABI — see
// `rebuild:native` script and ADR 0002.

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createDb } from '../db/client'
import { SqliteStore } from '../db/sqlite-store'
import { ActivityService } from '../services/activity-service'
import { TaskService } from '../services/task-service'
import { NeedToKnowService } from '../services/need-to-know-service'
import { createToolRegistry } from '../agent/tool-registry'
import { RoutineEngine } from '../routines/engine'
import { RoutineScheduler } from '../routines/scheduler'
import { seedPresets } from '../routines/presets'
import { MockEmailProvider } from '../providers/email/mock-email-provider'
import { MockCalendarProvider } from '../providers/calendar/mock-calendar-provider'
import { setRobotState } from '../ipc/handlers'
import { APP_NAME } from '@shared/constants'

export interface Container {
  store: SqliteStore
  activityService: ActivityService
  taskService: TaskService
  needToKnowService: NeedToKnowService
  toolRegistry: ReturnType<typeof createToolRegistry>
  engine: RoutineEngine
  scheduler: RoutineScheduler
  emailProvider: MockEmailProvider
  calendarProvider: MockCalendarProvider
  memory: Map<string, string>
  /** Push the latest activity to the workbench + robot for live UI updates. */
  broadcastActivity: (runId?: string) => void
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

  const emailProvider = new MockEmailProvider()
  const calendarProvider = new MockCalendarProvider()
  const memory = new Map<string, string>()

  const toolRegistry = createToolRegistry()

  // desktop.notify pushes a bubble to the robot window and flips the robot to
  // a 'done' state so the user sees something happened. (Robot state wiring
  // is fleshed out in M4.)
  const notify = (message: string): void => {
    setRobotState('done')
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.title === `${APP_NAME} Robot` || win.title === 'Daymate Robot') {
        win.webContents.send('daymate:robot-notify', { message })
      }
    }
  }

  const broadcastActivity = (runId?: string): void => {
    const events = activityService.list(runId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('daymate:activity:changed', events)
    }
  }

  const engine = new RoutineEngine({
    store,
    toolRegistry,
    activityService,
    taskService,
    needToKnowService,
    emailProvider,
    calendarProvider,
    memory,
    notify: (m) => {
      notify(m)
      broadcastActivity()
    }
  })

  const scheduler = new RoutineScheduler(engine, store)

  // Seed preset routines, then start the scheduler.
  seedPresets(store)
  scheduler.start()

  container = {
    store,
    activityService,
    taskService,
    needToKnowService,
    toolRegistry,
    engine,
    scheduler,
    emailProvider,
    calendarProvider,
    memory,
    broadcastActivity
  }
  return container
}
