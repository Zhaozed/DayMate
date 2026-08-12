import { describe, it, expect } from 'vitest'
import { createToolRegistry, extractSnippets } from '../../src/main/agent/tool-registry'
import type { ToolContext, WebFetch } from '../../src/main/agent/tool-registry'

// §17: the `web.fetch_jd` tool surfaces UNTRUSTED public web content. The tool
// must return PLAIN TEXT (tags stripped) so the stored value is inert even
// before the renderer's sandboxed iframe defense. These tests anchor that the
// snippet extraction never carries executable HTML through.

function makeCtx(webFetch?: WebFetch): ToolContext {
  return {
    emailProviders: [],
    calendarProvider: { listEvents: async () => [], getEvent: async () => undefined } as never,
    bossProvider: {} as never,
    taskService: {} as never,
    needToKnowService: {} as never,
    activityService: { record: () => {} } as never,
    memoryService: {} as never,
    applicationService: {} as never,
    webFetch
  } as unknown as ToolContext
}

describe('extractSnippets (§17 — plain text only)', () => {
  it('pulls text from DDG result__snippet anchors and strips nested tags', () => {
    const html = `
      <html><body>
        <a class="result__snippet" href="/1">字节跳动 <b>后端工程师</b>，负责服务端</a>
        <a class="result__snippet" href="/2">蚂蚁集团 Java 研发</a>
        <a class="result__snippet" href="/3">美团 到店事业群 Go</a>
      </body></html>`
    const out = extractSnippets(html, 5)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('字节跳动 后端工程师，负责服务端')
    expect(out[1]).toBe('蚂蚁集团 Java 研发')
    // No angle brackets survive → no executable HTML carried through (§17).
    expect(out.every((s) => !s.includes('<') && !s.includes('>'))).toBe(true)
  })

  it('caps at the requested maximum', () => {
    const html = Array.from(
      { length: 8 },
      (_, i) => `<a class="result__snippet">snippet ${i}</a>`
    ).join('')
    expect(extractSnippets(html, 5)).toHaveLength(5)
  })

  it('falls back to <p>/<li> text when DDG markup is absent', () => {
    const html = `<p>first paragraph of JD</p><li>second line</li>`
    const out = extractSnippets(html, 5)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toBe('first paragraph of JD')
  })

  it('returns [] when no recognisable text blocks exist', () => {
    expect(extractSnippets('<html><script>alert(1)</script></html>', 5)).toEqual([])
  })

  it('decodes the common HTML entities', () => {
    const html = `<a class="result__snippet">A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s</a>`
    expect(extractSnippets(html, 5)[0]).toBe(`A & B <tag> "q" 's`)
  })
})

describe('web.fetch_jd tool', () => {
  const registry = createToolRegistry()

  it('builds a DDG query from company+position and returns plain-text snippets', async () => {
    let capturedUrl = ''
    const webFetch: WebFetch = async (input) => {
      capturedUrl = input
      return `<a class="result__snippet">岗位描述：负责后端服务</a>`
    }
    const res = await registry.execute(
      'web.fetch_jd',
      { company: '字节跳动', position: '后端工程师' },
      makeCtx(webFetch)
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') throw new Error('unreachable')
    const data = res.data as { text: string }
    expect(data.text).toBe('岗位描述：负责后端服务')
    // DDG HTML endpoint, query encodes company+position+招聘+岗位描述.
    expect(capturedUrl).toContain('duckduckgo.com/html/')
    expect(capturedUrl).toContain(encodeURIComponent('字节跳动'))
    expect(capturedUrl).toContain(encodeURIComponent('后端工程师'))
  })

  it('works with company only (no position)', async () => {
    const webFetch: WebFetch = async () =>
      `<a class="result__snippet">公司简介片段</a>`
    const res = await registry.execute(
      'web.fetch_jd',
      { company: '美团' },
      makeCtx(webFetch)
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') throw new Error('unreachable')
    expect((res.data as { text: string }).text).toBe('公司简介片段')
  })

  it('returns an error when webFetch is not wired (tests / offline)', async () => {
    const res = await registry.execute(
      'web.fetch_jd',
      { company: '美团' },
      makeCtx(undefined)
    )
    expect(res.status).toBe('error')
  })

  it('returns an error when the fetch throws', async () => {
    const webFetch: WebFetch = async () => {
      throw new Error('network down')
    }
    const res = await registry.execute(
      'web.fetch_jd',
      { company: '美团' },
      makeCtx(webFetch)
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') throw new Error('unreachable')
    expect(res.error).toContain('web 抓取失败')
  })

  it('returns ok with empty text + note when DDG yields no snippets', async () => {
    const webFetch: WebFetch = async () => '<html><body>no results</body></html>'
    const res = await registry.execute(
      'web.fetch_jd',
      { company: '不存在公司' },
      makeCtx(webFetch)
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') throw new Error('unreachable')
    const data = res.data as { text: string; note?: string }
    expect(data.text).toBe('')
    expect(data.note).toBeTruthy()
  })

  it('never carries executable HTML through (§17)', async () => {
    const webFetch: WebFetch = async () =>
      `<a class="result__snippet"><script>alert(1)</script>real text</a>`
    const res = await registry.execute(
      'web.fetch_jd',
      { company: 'x' },
      makeCtx(webFetch)
    )
    if (res.status !== 'ok') throw new Error('unreachable')
    const text = (res.data as { text: string }).text
    expect(text).not.toContain('<script>')
    expect(text).not.toContain('<')
  })
})
