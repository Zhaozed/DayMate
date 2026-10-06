import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { Container } from '../main/app/container'
import { dispatchBusinessAction } from './actions'
import { nowIso } from '../main/util/ids'

export interface ServerGatewayOptions {
  port: number
  host?: string
  token: string
  dataDir?: string
  container: Container
}

export class ServerGateway {
  private server: Server
  private wss: WebSocketServer
  private authenticatedClients = new Set<WebSocket>()

  constructor(private readonly options: ServerGatewayOptions) {
    this.server = createServer((req, res) => this.handleHttp(req, res))
    this.server.on('connection', (socket) => {
      console.log(`[gateway] Connection from ${socket.remoteAddress}:${socket.remotePort}`)
    })
    this.server.on('clientError', (err, socket) => {
      console.error('[gateway] clientError:', err)
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    this.wss = new WebSocketServer({ noServer: true })

    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host || 'localhost'}`)
      const token = url.searchParams.get('token') || request.headers['x-daymate-token']

      if (this.options.token && token !== this.options.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (ws: WebSocket) => {
      this.authenticatedClients.add(ws)
      console.log(`[gateway] Desktop client connected (total: ${this.authenticatedClients.size})`)

      ws.on('message', async (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString())
          const { id, channel, args } = msg

          if (!channel) {
            ws.send(JSON.stringify({ id, success: false, error: 'Missing channel' }))
            return
          }

          const result = await dispatchBusinessAction(this.options.container, channel, args ?? [])
          ws.send(JSON.stringify({ id, success: true, result }))
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ success: false, error: errorMsg }))
        }
      })

      ws.on('close', () => {
        this.authenticatedClients.delete(ws)
        console.log(`[gateway] Desktop client disconnected (total: ${this.authenticatedClients.size})`)
      })

      ws.on('error', (err) => {
        console.error('[gateway] WebSocket error:', err)
        this.authenticatedClients.delete(ws)
      })
    })
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    console.log(`[gateway] HTTP ${req.method} ${req.url} (Host: ${req.headers.host})`)
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)

    // CORS headers for local/cross-origin desktop calls
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Daymate-Token, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', time: nowIso(), clients: this.authenticatedClients.size }))
      return
    }

    // Token authentication
    const authHeader = req.headers['authorization']
    const tokenHeader = req.headers['x-daymate-token']
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
    const token = tokenHeader || bearer || url.searchParams.get('token')

    if (this.options.token && token !== this.options.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized: invalid token' }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        try {
          const { channel, args } = JSON.parse(body)
          const result = await dispatchBusinessAction(this.options.container, channel, args ?? [])
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, result }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/sync-file') {
      const filename = req.headers['x-daymate-filename'] as string
      if (!filename || (filename !== 'daymate.db' && filename !== 'settings.json' && filename !== 'base_resume.html' && filename !== 'secrets.json')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid or forbidden filename' }))
        return
      }

      const targetDir = this.options.dataDir || './data'
      const targetPath = resolve(targetDir, filename)
      const tmpPath = `${targetPath}.tmp`
      const ws = createWriteStream(tmpPath)
      req.pipe(ws)

      ws.on('finish', async () => {
        try {
          const { rename } = await import('node:fs/promises')
          await rename(tmpPath, targetPath)
          console.log(`[sync] Successfully received and saved: ${filename}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, filename }))
        } catch (err) {
          console.error('[sync] Error renaming file:', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      ws.on('error', (err) => {
        console.error('[sync] Stream write error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/sync-reload') {
      console.log('[sync] Server reload requested after data migration. Exiting to allow PM2 restart...')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: 'Server is restarting with new database' }))
      setTimeout(() => {
        process.exit(1)
      }, 300)
      return
    }

    if (url.pathname === '/api/debug') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs')
      const targetDir = this.options.dataDir || './data'
      const dbPath = resolve(targetDir, 'daymate.db')
      const size = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0
      const apps = this.options.container.store.listApplications()
      const tasks = this.options.container.store.listTasks()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        targetDir,
        dbPath,
        dbSize: size,
        appsCount: apps.length,
        tasksCount: tasks.length,
        pid: process.pid,
        uptime: process.uptime()
      }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  /**
   * Broadcast an event to all connected desktop clients
   */
  broadcast(channel: string, ...args: unknown[]): void {
    const payload = JSON.stringify({ type: 'event', channel, args })
    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host || '0.0.0.0', () => {
        console.log(`[gateway] Daymate server listening on ${this.options.host || '0.0.0.0'}:${this.options.port}`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.authenticatedClients) {
        client.terminate()
      }
      this.wss.close(() => {
        this.server.close(() => resolve())
      })
    })
  }
}
