import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { initContainer } from '../main/app/container'
import { ServerSafeStorage } from './crypto'
import { createProxyFetch } from './fetch'
import { ServerGateway } from './gateway'
import { IPC } from '@shared/constants'

// Attempt to load .env if process.loadEnvFile is available (Node 20.6+)
try {
  if (typeof process.loadEnvFile === 'function') {
    const envPath = resolve(process.cwd(), '.env')
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath)
    }
  }
} catch {
  // Ignore env loading errors
}

const PORT = Number(process.env.PORT || process.env.DAYMATE_PORT || 3210)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = resolve(process.env.DAYMATE_DATA_DIR || './data')
const SECRET_KEY = process.env.DAYMATE_SECRET_KEY || 'daymate-default-server-key-change-in-production'
const SERVER_TOKEN = process.env.DAYMATE_SERVER_TOKEN || 'daymate-token'
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

console.log('───────────────────────────────────────────────────────')
console.log('  Daymate Headless Server Daemon')
console.log(`  Data Directory: ${DATA_DIR}`)
console.log(`  Listening:      http://${HOST}:${PORT}`)
console.log(`  Proxy Enabled:  ${PROXY_URL ? PROXY_URL : 'None (Direct connection)'}`)
console.log(`  Auth Token:     ${SERVER_TOKEN ? 'Configured' : 'None (Insecure)'}`)
console.log('───────────────────────────────────────────────────────')

const safeStorage = new ServerSafeStorage(SECRET_KEY)
const proxyFetch = createProxyFetch(PROXY_URL)

let gatewayRef: ServerGateway | null = null

const container = initContainer({
  dataDir: DATA_DIR,
  safeStorage,
  fetch: proxyFetch,
  openExternal: async (url: string) => {
    console.log(`[OAuth] Please open the following URL to authorize: \n${url}`)
  },
  broadcaster: (channel: string, ...args: unknown[]) => {
    gatewayRef?.broadcast(channel, ...args)
  },
  onRobotStateChange: (state) => {
    gatewayRef?.broadcast(IPC.ROBOT_STATE_CHANGED, state)
  },
  onRobotNotify: (notify) => {
    gatewayRef?.broadcast(IPC.ROBOT_NOTIFY, notify)
  },
  notifier: (title: string, body: string) => {
    console.log(`[Notification] ${title}: ${body}`)
  }
})

const gateway = new ServerGateway({
  port: PORT,
  host: HOST,
  token: SERVER_TOKEN,
  container
})
gatewayRef = gateway

async function start(): Promise<void> {
  await gateway.start()

  // Reconcile saved provider states
  await container.refreshEmailProviders()

  console.log('[server] All services and scheduled sync loops initialized.')
}

start().catch((err) => {
  console.error('[server] Fatal error during startup:', err)
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log('\n[server] Shutting down...')
  await gateway.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n[server] Shutting down...')
  await gateway.stop()
  process.exit(0)
})
