// One-click script to sync local Daymate data (database, settings, resume) to Alibaba Cloud server
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { request } from 'node:http'

const SERVER_URL = process.env.DAYMATE_SERVER_URL || 'http://39.98.44.205:3210'
const SERVER_TOKEN = process.env.DAYMATE_SERVER_TOKEN || 'daymate-token'

const USER_DATA = join(homedir(), 'Library', 'Application Support', 'Daymate')

async function uploadFile(filename) {
  const filePath = join(USER_DATA, filename)
  if (!existsSync(filePath)) {
    console.log(`[skip] ${filename} not found locally, skipping.`)
    return
  }

  const stat = statSync(filePath)
  console.log(`[upload] Uploading ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`)

  const url = new URL('/api/sync-file', SERVER_URL)

  await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'x-daymate-token': SERVER_TOKEN,
        'x-daymate-filename': filename,
        'Content-Length': stat.size
      }
    }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[ok] Successfully synced ${filename}`)
          resolve()
        } else {
          reject(new Error(`Failed to upload ${filename}: ${res.statusCode} ${body}`))
        }
      })
    })

    req.on('error', reject)
    const stream = createReadStream(filePath)
    stream.pipe(req)
  })
}

async function reloadServer() {
  console.log('[reload] Requesting server restart to load new database...')
  const url = new URL('/api/sync-reload', SERVER_URL)
  await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'x-daymate-token': SERVER_TOKEN
      }
    }, (res) => {
      res.on('data', () => {})
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end()
  })
}

async function verifyServer() {
  console.log('[verify] Waiting for server to come back up...')
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const res = await fetch(`${SERVER_URL}/health`)
      if (res.ok) {
        const json = await res.json()
        console.log('[done] Cloud server is ONLINE and healthy! Response:', json)
        return
      }
    } catch {
      // Retrying
    }
  }
  throw new Error('Server did not respond within 10 seconds after reload.')
}

async function main() {
  console.log(`Syncing data to: ${SERVER_URL}`)
  console.log(`Local data dir:  ${USER_DATA}`)

  const files = ['daymate.db', 'settings.json', 'base_resume.html']
  for (const f of files) {
    await uploadFile(f)
  }

  await reloadServer()
  await verifyServer()
  console.log('✅ All local data successfully migrated and loaded into Alibaba Cloud!')
}

main().catch((err) => {
  console.error('❌ Sync failed:', err)
  process.exit(1)
})
