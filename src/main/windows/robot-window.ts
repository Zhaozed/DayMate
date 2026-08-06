// The ambient desktop robot window. Transparent, always-on-top, draggable,
// compact. Spec §18: does not steal focus for normal notifications; click opens
// quick panel, double click opens workbench.

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'

let robotWindow: BrowserWindow | null = null

export function openRobot(): BrowserWindow {
  if (robotWindow && !robotWindow.isDestroyed()) {
    robotWindow.focus()
    return robotWindow
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const w = 168
  const h = 168

  robotWindow = new BrowserWindow({
    title: `${APP_NAME} Robot`,
    width: w,
    height: h,
    x: screenW - w - 24,
    y: screenH - h - 24,
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
