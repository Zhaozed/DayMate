// The ambient desktop robot window. Transparent, always-on-top, draggable,
// compact. Spec §18: does not steal focus for normal notifications; click opens
// the quick panel, double click opens workbench, right-click opens a context
// menu (pause/resume routines, open workbench, quit).
//
// The window resizes between three views (orb / bubble / panel) around a FIXED
// screen anchor so the orb never jumps. The renderer can't resize the window
// directly (sandboxed), so it asks main via the typed SET_ROBOT_VIEW channel.

import { BrowserWindow, Menu, screen } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import type { RobotView } from '@shared/types'

let robotWindow: BrowserWindow | null = null
/** Fixed screen anchor = the orb's center. Computed once on first open. */
let anchor: { x: number; y: number } | null = null

// Per-view window geometry. The orb/dot center stays at `anchor` in every view,
// so views expand up-and-to-the-left from the anchor (the orb never moves).
const VIEW_GEOMETRY: Record<RobotView, { w: number; h: number; dotR: number }> = {
  // Ambient orb: the orb fills the whole window; its center is the anchor.
  orb: { w: 168, h: 168, dotR: 84 },
  // Proactive bubble: a small card with the orb dot at its bottom-right.
  bubble: { w: 320, h: 96, dotR: 14 },
  // Quick panel: a card with the orb dot at its bottom-right corner.
  panel: { w: 360, h: 460, dotR: 14 }
}

function boundsFor(view: RobotView): { x: number; y: number; width: number; height: number } {
  const a = anchor ?? { x: 0, y: 0 }
  const { w, h, dotR } = VIEW_GEOMETRY[view]
  // windowX + (w - dotR) = anchor.x  →  the dot center lands on the anchor.
  return { x: Math.round(a.x - w + dotR), y: Math.round(a.y - h + dotR), width: w, height: h }
}

export function openRobot(): BrowserWindow {
  if (robotWindow && !robotWindow.isDestroyed()) {
    robotWindow.focus()
    return robotWindow
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  // Orb center sits 108px in from the bottom-right corner of the work area.
  anchor = { x: screenW - 108, y: screenH - 108 }

  robotWindow = new BrowserWindow({
    title: `${APP_NAME} Robot`,
    ...boundsFor('orb'),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    // Security: contextIsolation on, nodeIntegration off, sandbox on.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  robotWindow.on('ready-to-show', () => robotWindow?.show())

  // Dragging the frameless, transparent robot.
  robotWindow.on('will-resize', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    robotWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/robot/index.html`)
  } else {
    robotWindow.loadFile(join(__dirname, '../renderer/robot/index.html'))
  }

  return robotWindow
}

export function getRobotWindow(): BrowserWindow | null {
  return robotWindow && !robotWindow.isDestroyed() ? robotWindow : null
}

/** Resize + reposition the robot window to a view (M4 §18). No-op if closed. */
export function setRobotView(view: RobotView): void {
  const win = getRobotWindow()
  if (!win) return
  win.setBounds(boundsFor(view))
}

export interface RobotContextMenuActions {
  onPause: () => void
  onResume: () => void
  onOpenWorkbench: () => void
  onQuit: () => void
}

/**
 * Install the native right-click context menu on the robot window (M4 §18).
 * Actions are injected so this module does not import the container (avoids a
 * module-load cycle: container → handlers → windows → robot-window).
 */
export function installRobotContextMenu(actions: RobotContextMenuActions): void {
  const win = getRobotWindow()
  if (!win) return
  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => actions.onOpenWorkbench() },
    { type: 'separator' },
    { label: '暂停例程', click: () => actions.onPause() },
    { label: '恢复例程', click: () => actions.onResume() },
    { type: 'separator' },
    { label: '退出 Daymate', click: () => actions.onQuit() }
  ])
  win.webContents.on('context-menu', () => {
    menu.popup()
  })
}
