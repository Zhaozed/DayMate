// The workbench window — the main work surface. Spec §4 IA: Home, Assistant,
// Need to Know, Tasks, Routines, Approvals, Activity, Memory, Integrations.

import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'

let workbenchWindow: BrowserWindow | null = null

export function openWorkbench(): BrowserWindow {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.focus()
    return workbenchWindow
  }

  workbenchWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    // Title bar hidden so we can render a custom traffic-light-aware header;
    // buttons overlay the renderer. macOS only for MVP.
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  workbenchWindow.on('ready-to-show', () => workbenchWindow?.show())
  workbenchWindow.on('closed', () => {
    workbenchWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    workbenchWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/workbench.html`)
  } else {
    workbenchWindow.loadFile(join(__dirname, '../renderer/workbench.html'))
  }

  return workbenchWindow
}

export function getWorkbenchWindow(): BrowserWindow | null {
  return workbenchWindow && !workbenchWindow.isDestroyed() ? workbenchWindow : null
}
