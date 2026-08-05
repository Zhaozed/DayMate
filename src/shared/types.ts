// Domain + IPC contract types shared across main, preload and renderer.
// Spec reference: DEVELOPMENT_SPEC.md sections 4, 8, 9, 10, 11.

import type { WindowName } from './constants'

// Re-export so `@shared/types` is the single import surface for shared types.
export type { WindowName } from './constants'

// ── Robot ───────────────────────────────────────────────────────────────────
// The robot visually represents Agent state. It must never claim to understand
// behavior it did not observe. (Spec §4)
export type RobotState =
  | 'idle'
  | 'observing'
  | 'thinking'
  | 'working'
  | 'need_approval'
  | 'done'
  | 'error'

// ── Accounts ────────────────────────────────────────────────────────────────
export type AccountProvider = 'gmail' | 'mail163' | 'feishu'

export type IntegrationStatus = 'connected' | 'expired' | 'error' | 'disconnected'

export interface IntegrationAccount {
  id: string
  provider: AccountProvider
  displayName: string
  email?: string
  status: IntegrationStatus
  scopes: string[]
  lastSyncAt?: string
  createdAt: string
  updatedAt: string
}

// ── App info (safe to surface to renderer) ──────────────────────────────────
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

// ── IPC contract ─────────────────────────────────────────────────────────────
// The renderer never sees Node, tokens, auth codes or raw db access. It only
// sees the typed surface below, exposed by the preload via contextBridge.
export interface DaymateApi {
  ping(): Promise<string>
  getAppInfo(): Promise<AppInfo>
  getRobotState(): Promise<RobotState>
  setRobotState(state: RobotState): Promise<RobotState>
  openWindow(name: WindowName): Promise<void>
}

// Contract on the `window.daymate` global injected by preload.
// The renderer's `env.d.ts` augments the DOM `Window` interface directly with
// `daymate: DaymateApi`; kept out of shared types so the main/preload (node)
// tsconfig does not need the DOM lib.
