import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServerSafeStorage } from '../../src/server/crypto'
import { ServerGateway } from '../../src/server/gateway'
import { WebSocket, type RawData } from 'ws'
import type { AppContainer } from '../../src/main/app/container'

describe('ServerSafeStorage', () => {
  it('encrypts and decrypts strings correctly using AES-256-GCM', () => {
    const storage = new ServerSafeStorage('my-test-secret-key-1234567890')
    expect(storage.isEncryptionAvailable()).toBe(true)

    const secret = 'super-secret-gmail-refresh-token'
    const encrypted = storage.encryptString(secret)
    expect(encrypted).toBeInstanceOf(Buffer)
    expect(encrypted.toString('utf8')).not.toBe(secret)

    const decrypted = storage.decryptString(encrypted)
    expect(decrypted).toBe(secret)
  })

  it('fails decryption with wrong key or tampered buffer', () => {
    const storage1 = new ServerSafeStorage('key-one')
    const storage2 = new ServerSafeStorage('key-two')

    const encrypted = storage1.encryptString('hello world')
    expect(() => storage2.decryptString(encrypted)).toThrow()
  })
})

describe('ServerGateway', () => {
  let gateway: ServerGateway
  const port = 32199
  const token = 'test-token-xyz'

  // Minimal mock container for testing gateway RPC and broadcast
  const mockContainer = {
    store: {
      listRoutines: () => [{ id: 'mock_routine', name: 'Mock' }]
    },
    broadcastTasks: () => {}
  } as unknown as AppContainer

  beforeAll(async () => {
    gateway = new ServerGateway({
      port,
      token,
      container: mockContainer
    })
    await gateway.start()
  })

  afterAll(async () => {
    await gateway.stop()
  })

  it('responds to /health check without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe('ok')
  })

  it('rejects /api/rpc without token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      body: JSON.stringify({ channel: 'daymate:routine:list' })
    })
    expect(res.status).toBe(401)
  })

  it('handles /api/rpc with valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Daymate-Token': token
      },
      body: JSON.stringify({ channel: 'daymate:routine:list' })
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; result: unknown }
    expect(json.success).toBe(true)
    expect(json.result).toEqual([{ id: 'mock_routine', name: 'Mock' }])
  })

  it('connects via WebSocket with token and handles RPC + broadcast events', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`)

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })

    const receivedEvents: Array<{ type: string; channel: string; payload?: unknown }> = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; channel: string; payload?: unknown }
      if (msg.type === 'event') {
        receivedEvents.push(msg)
      }
    })

    // Test WebSocket RPC call
    const callPromise = new Promise<{ id: string; success: boolean; result: unknown }>((resolve) => {
      const listener = (data: RawData) => {
        const msg = JSON.parse(data.toString()) as { id: string; success: boolean; result: unknown }
        if (msg.id === 'call_1') {
          ws.removeListener('message', listener)
          resolve(msg)
        }
      }
      ws.on('message', listener)
    })

    ws.send(JSON.stringify({ id: 'call_1', channel: 'daymate:routine:list' }))
    const rpcRes = await callPromise
    expect(rpcRes.success).toBe(true)
    expect(rpcRes.result).toEqual([{ id: 'mock_routine', name: 'Mock' }])

    // Test Gateway event broadcast
    gateway.broadcast('daymate:task:changed', { test: 123 })
    await new Promise((r) => setTimeout(r, 50))

    expect(receivedEvents.length).toBe(1)
    expect(receivedEvents[0].channel).toBe('daymate:task:changed')

    ws.close()
  })
})
