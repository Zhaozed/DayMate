// 临时工具：从 Langfuse 拉真实 classify traces，提取邮件样本（subject/body/from），
// 供「真实形态回归集 case」构造。输出到项目 scripts/tmp-real-emails.json（不提交）。
//
// 用法：source ~/.zshrc && node scripts/extract-real-emails.mjs [limit]
import { Langfuse } from 'langfuse'

const baseUrl = process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com'
const limit = Number(process.argv[2]) || 200
const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl
})

const seen = new Map() // provider:accountId:messageId -> email
let traceCount = 0
let batch = 0
let pageToken

do {
  const page = await langfuse.fetchTraces({ limit: 100, page: pageToken })
  const traces = page?.traces ?? page ?? []
  if (!Array.isArray(traces) || traces.length === 0) break
  traceCount += traces.length
  for (const t of traces) {
    const input = t?.input ?? {}
    const lists = [input.gmailEmails, input.mail163Emails, input.emails].filter(Array.isArray)
    for (const list of lists) {
      for (const e of list ?? []) {
        if (!e || typeof e.subject !== 'string') continue
        const key = `${e.provider ?? '?'}:${e.accountId ?? '?'}:${e.messageId ?? '?'}`
        if (!seen.has(key)) seen.set(key, {
          provider: e.provider, accountId: e.accountId, messageId: e.messageId,
          from: e.from ?? null, subject: e.subject, textBody: e.textBody ?? '',
          labels: e.labels ?? [], unread: e.unread ?? null, receivedAt: e.receivedAt ?? null
        })
      }
    }
  }
  pageToken = page?.meta?.nextPageToken ?? (page?.nextPageToken)
  batch += 1
} while (pageToken && batch < 10)

const emails = [...seen.values()]
const fs = await import('node:fs')
fs.writeFileSync(new URL('./tmp-real-emails.json', import.meta.url), JSON.stringify(emails, null, 2), 'utf8')
console.log(`traces=${traceCount} 唯一邮件=${emails.length}`)
const providers = {}
for (const e of emails) providers[e.provider] = (providers[e.provider] ?? 0) + 1
console.log('providers:', JSON.stringify(providers))
// 打印 12 条样本（subject + from + body 前 60 字），看形态
for (const e of emails.slice(0, 12)) {
  console.log(`\n── [${e.provider}] ${e.subject}`)
  console.log(`    from: ${e.from?.name ?? ''} <${e.from?.address ?? ''}> labels=${e.labels.join(',')}`)
  console.log(`    body: ${e.textBody.slice(0, 80).replace(/\n/g, ' ')}`)
}