import { WebSocket } from 'ws'
import { BrowserWindow } from 'electron'
import { IPC } from '@shared/constants'
import { setRobotState, pushRobotNotify } from '../ipc/handlers'

export interface RemoteClientOptions {
  serverUrl: string
  token: string
}

export class RemoteGatewayClient {
  private ws: WebSocket | null = null
  private pendingCalls = new Map<string, { resolve: (val: unknown) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  private callCounter = 0
  private isConnecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  constructor(private readonly options: RemoteClientOptions) {}

  get isConnected(): boolean {
    return this.connected
  }

  connect(): void {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return
    this.isConnecting = true

    const httpUrl = new URL(this.options.serverUrl)
    const wsProto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProto}//${httpUrl.host}/?token=${encodeURIComponent(this.options.token)}`

    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        this.connected = true
        this.isConnecting = false
        console.log(`[remote-client] Connected to remote Daymate server: ${this.options.serverUrl}`)
        // Notify local renderer windows to refresh data now that connection is established
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.ACTIVITY_CHANGED, [])
          win.webContents.send(IPC.APPLICATION_CHANGED)
          win.webContents.send(IPC.TASKS_CHANGED)
        }
      })

      this.ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString())

          // Push event from server
          if (msg.type === 'event' && msg.channel) {
            this.handleServerEvent(msg.channel, msg.args || [])
            return
          }

          // RPC response
          if (msg.id && this.pendingCalls.has(msg.id)) {
            const { resolve, reject, timer } = this.pendingCalls.get(msg.id)!
            clearTimeout(timer)
            this.pendingCalls.delete(msg.id)

            if (msg.success) {
              resolve(msg.result)
            } else {
              reject(new Error(msg.error || 'Remote call failed'))
            }
          }
        } catch (err) {
          console.error('[remote-client] Error parsing server message:', err)
        }
      })

      this.ws.on('close', () => {
        this.connected = false
        this.isConnecting = false
        this.ws = null
        // Reject pending calls immediately instead of hanging for 30s
        for (const [, { reject, timer }] of this.pendingCalls.entries()) {
          clearTimeout(timer)
          reject(new Error('WebSocket connection closed'))
        }
        this.pendingCalls.clear()
        this.scheduleReconnect()
      })

      this.ws.on('error', (err) => {
        console.error('[remote-client] WebSocket error:', err.message)
        this.connected = false
        this.isConnecting = false
        this.ws = null
        for (const [, { reject, timer }] of this.pendingCalls.entries()) {
          clearTimeout(timer)
          reject(new Error(`WebSocket error: ${err.message}`))
        }
        this.pendingCalls.clear()
        this.scheduleReconnect()
      })
    } catch {
      this.connected = false
      this.isConnecting = false
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      console.log('[remote-client] Attempting to reconnect to remote server...')
      this.connect()
    }, 2000)
  }

  private handleServerEvent(channel: string, args: unknown[]): void {
    // Synchronize robot ambient state
    if (channel === IPC.ROBOT_STATE_CHANGED && args[0]) {
      setRobotState(args[0] as Parameters<typeof setRobotState>[0])
    } else if (channel === IPC.ROBOT_NOTIFY && args[0]) {
      pushRobotNotify(args[0] as Parameters<typeof pushRobotNotify>[0])
    }

    // Broadcast event to all local Electron windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, ...args)
    }
  }

  async call(channel: string, args: unknown[] = []): Promise<unknown> {
    // If WebSocket is open, send via WS
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = `rpc_${Date.now()}_${++this.callCounter}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingCalls.has(id)) {
            this.pendingCalls.delete(id)
            reject(new Error(`Remote RPC timeout for ${channel}`))
          }
        }, 10000)

        this.pendingCalls.set(id, { resolve, reject, timer })
        this.ws!.send(JSON.stringify({ id, channel, args }))
      })
    }

    // Fallback: HTTP POST /api/rpc
    const rpcUrl = new URL('/api/rpc', this.options.serverUrl).toString()
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Daymate-Token': this.options.token
      },
      body: JSON.stringify({ channel, args }),
      signal: AbortSignal.timeout(10000)
    })

    if (!res.ok) {
      throw new Error(`HTTP RPC failed with status ${res.status}`)
    }

    const json = (await res.json()) as { success: boolean; result?: unknown; error?: string }
    if (!json.success) {
      throw new Error(json.error || 'Remote call returned unsuccessful')
    }
    return json.result
  }
}
