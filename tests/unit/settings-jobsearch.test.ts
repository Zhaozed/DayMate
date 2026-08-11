import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '../../src/main/db/in-memory-store'
import { ActivityService } from '../../src/main/services/activity-service'
import { ApplicationService } from '../../src/main/services/application-service'
import { MockBossProvider } from '../../src/main/providers/boss/mock-boss-provider'
import { Settings } from '../../src/main/util/settings'
import { createDeterministicAgentRuntime } from '../../src/main/agent/agent-runtime'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeService(): { svc: ApplicationService; store: InMemoryStore } {
  const store = new InMemoryStore()
  const activity = new ActivityService(store)
  const svc = new ApplicationService(store, new MockBossProvider(), activity)
  return { svc, store }
}

describe('settings — jobSearch config (§G)', () => {
  it('reads/writes jobSearch paths (non-secret, persisted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-settings-'))
    const settings = new Settings(join(dir, 'settings.json'))
    // Default: no jobSearch block.
    expect(await settings.readJobSearch()).toEqual({})
    const written = await settings.writeJobSearch({
      baseResumePath: '/Users/me/resume.html',
      transcriptTemplatePath: '/Users/me/template.html'
    })
    expect(written.baseResumePath).toBe('/Users/me/resume.html')
    // A fresh Settings (cache cleared) reads the persisted block back.
    const fresh = new Settings(join(dir, 'settings.json'))
    const read = await fresh.readJobSearch()
    expect(read.baseResumePath).toBe('/Users/me/resume.html')
    expect(read.transcriptTemplatePath).toBe('/Users/me/template.html')
    rmSync(dir, { recursive: true, force: true })
  })

  it('readBaseResumeContent reads the file at the configured path (trusted §17)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-resume-'))
    const resumePath = join(dir, 'resume.html')
    writeFileSync(resumePath, '<b>我的基础简历</b>', 'utf8')
    const settings = new Settings(join(dir, 'settings.json'))
    await settings.writeJobSearch({ baseResumePath: resumePath })
    const content = await settings.readBaseResumeContent()
    expect(content).toBe('<b>我的基础简历</b>')
    rmSync(dir, { recursive: true, force: true })
  })

  it('readBaseResumeContent returns undefined when no path is set or the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-nopath-'))
    const settings = new Settings(join(dir, 'settings.json'))
    expect(await settings.readBaseResumeContent()).toBeUndefined()
    await settings.writeJobSearch({ baseResumePath: join(dir, 'missing.html') })
    expect(await settings.readBaseResumeContent()).toBeUndefined() // soft degrade
    rmSync(dir, { recursive: true, force: true })
  })

  it('a partial/garbage jobSearch block is normalized away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymate-garbage-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ llm: { provider: 'anthropic', modelId: 'x' }, jobSearch: { baseResumePath: 123 } }), 'utf8')
    const settings = new Settings(file)
    const js = await settings.readJobSearch()
    expect(js).toEqual({}) // non-string path dropped → empty
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('applicationService — manual AI generation (§4.2/§4.3)', () => {
  it('generateResume runs the agent + saves a versioned resume with a promptHash', async () => {
    const { svc } = makeService()
    const app = svc.create({ company: '腾讯', position: '后端', jdText: 'Go 微服务' })
    const runtime = createDeterministicAgentRuntime()
    const v1 = await svc.generateResume(app.application.id, runtime, '<b>我的简历</b>')
    expect(v1.version).toBe(1)
    expect(v1.html).toBeTruthy()
    expect(v1.promptHash).toBeTruthy()
    // A second generate → version 2.
    const v2 = await svc.generateResume(app.application.id, runtime, '<b>我的简历</b>')
    expect(v2.version).toBe(2)
  })

  it('generatePrepMaterial pulls the latest resume + notes + saves a prep version', async () => {
    const { svc } = makeService()
    const app = svc.create({ company: '字节跳动', position: '后端', jdText: 'Kubernetes' })
    svc.saveResume(app.application.id, '<b>简历</b>')
    svc.createInterviewNote({
      company: '字节跳动',
      position: '后端',
      tags: ['项目'],
      content: '分布式锁'
    })
    const runtime = createDeterministicAgentRuntime()
    const m1 = await svc.generatePrepMaterial(app.application.id, runtime)
    expect(m1.version).toBe(1)
    expect(m1.html).toContain('面试准备逐字稿')
    expect(m1.html).toContain('字节跳动')
  })

  it('generate throws when the application does not exist', async () => {
    const { svc } = makeService()
    const runtime = createDeterministicAgentRuntime()
    await expect(svc.generateResume('nope', runtime)).rejects.toThrow(/未找到投递记录/)
  })
})
