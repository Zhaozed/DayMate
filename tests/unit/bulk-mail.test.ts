import { describe, it, expect } from 'vitest'
import {
  detectBulkFromHeaders,
  isBulkMail,
  ADS_KEYWORD_RE,
  IMPORTANT_BULK_KEYWORD_RE,
  VERIFICATION_CODE_RE,
  SECURITY_ALERT_RE,
  shouldSkipBriefing,
  shouldSkipFunnel,
  isRecruitingVip
} from '../../src/main/util/bulk-mail'
import { extractPositionFromText, extractJobCodeFromText } from '../../src/main/services/application-service'
import type { NormalizedEmail } from '@shared/types'

function email(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: 'gmail',
    accountId: 'a',
    messageId: 'm1',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: [],
    subject: '',
    textBody: '',
    receivedAt: new Date().toISOString(),
    unread: true,
    labels: ['INBOX'],
    sourceUrl: '',
    ...overrides
  }
}

describe('detectBulkFromHeaders', () => {
  const none = () => ''
  it('returns false when no bulk headers', () => {
    expect(detectBulkFromHeaders(none)).toBe(false)
  })
  it('detects Precedence: bulk / list / junk', () => {
    expect(detectBulkFromHeaders((n) => (n === 'precedence' ? 'bulk' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'precedence' ? 'list' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'precedence' ? 'Junk' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'precedence' ? 'first-class' : ''))).toBe(false)
  })
  it('detects List-Id presence', () => {
    expect(detectBulkFromHeaders((n) => (n === 'list-id' ? '<x.y>' : ''))).toBe(true)
  })
  it('detects Auto-Submitted: auto-generated / auto-replied', () => {
    expect(detectBulkFromHeaders((n) => (n === 'auto-submitted' ? 'auto-generated' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'auto-submitted' ? 'auto-replied' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'auto-submitted' ? 'no' : ''))).toBe(false)
  })
  it('detects List-Unsubscribe + X-Mailing-List', () => {
    expect(detectBulkFromHeaders((n) => (n === 'list-unsubscribe' ? '<mailto:x>' : ''))).toBe(true)
    expect(detectBulkFromHeaders((n) => (n === 'x-mailing-list' ? 'list' : ''))).toBe(true)
  })
})

describe('isBulkMail', () => {
  it('true when provider bulk flag set', () => {
    expect(isBulkMail(email({ bulk: true }))).toBe(true)
  })
  it('true for noreply / notice / admin sender', () => {
    expect(isBulkMail(email({ from: { name: 'X', address: 'noreply@x.com' } }))).toBe(true)
    expect(isBulkMail(email({ from: { name: 'X', address: 'notice@school.edu.cn' } }))).toBe(true)
    expect(isBulkMail(email({ from: { name: 'X', address: 'do-not-reply@x.com' } }))).toBe(true)
  })
  it('true when a recipient is a school list alias', () => {
    expect(
      isBulkMail(
        email({ from: { name: 'X', address: 'office@school.edu.cn' }, to: [{ name: 'All', address: 'all-students@school.edu.cn' }] })
      )
    ).toBe(true)
    expect(
      isBulkMail(email({ to: [{ name: 'All', address: 'undergraduates@school.edu.cn' }] }))
    ).toBe(true)
  })
  it('false for a real-person sender to you directly', () => {
    expect(isBulkMail(email())).toBe(false)
    expect(isBulkMail(email({ from: { name: '导师', address: 'prof@school.edu.cn' } }))).toBe(false)
  })
})

describe('keyword regexes', () => {
  it('ADS_KEYWORD_RE matches marketing markers', () => {
    expect(ADS_KEYWORD_RE.test('如不想收到请退订')).toBe(true)
    expect(ADS_KEYWORD_RE.test('unsubscribe here')).toBe(true)
    expect(ADS_KEYWORD_RE.test('限时优惠')).toBe(true)
    expect(ADS_KEYWORD_RE.test('今日待办')).toBe(false)
  })
  it('IMPORTANT_BULK_KEYWORD_RE matches graduation/fee/urgent', () => {
    expect(IMPORTANT_BULK_KEYWORD_RE.test('毕业手续办理通知')).toBe(true)
    expect(IMPORTANT_BULK_KEYWORD_RE.test('请于截止日前缴费')).toBe(true)
    expect(IMPORTANT_BULK_KEYWORD_RE.test('食堂今日菜谱')).toBe(false)
  })
  it('VERIFICATION_CODE_RE matches OTP / 验证码 markers', () => {
    expect(VERIFICATION_CODE_RE.test('您的验证码是 123456')).toBe(true)
    expect(VERIFICATION_CODE_RE.test('Your verification code: 987654')).toBe(true)
    expect(VERIFICATION_CODE_RE.test('动态码 30 分钟内有效')).toBe(true)
    expect(VERIFICATION_CODE_RE.test('登录成功')).toBe(false)
  })
  it('SECURITY_ALERT_RE matches login / 异常登录 alerts', () => {
    expect(SECURITY_ALERT_RE.test('检测到异地登录，请确认是否本人操作')).toBe(true)
    expect(SECURITY_ALERT_RE.test('We noticed a new login from your account')).toBe(true)
    expect(SECURITY_ALERT_RE.test('安全提醒：请核实身份')).toBe(true)
    expect(SECURITY_ALERT_RE.test('面试通知')).toBe(false)
  })
})

describe('shouldSkipBriefing (必读 path — ADR 0029 relaxed)', () => {
  // ADR 0029 relaxed the 必读 filter: pure ads, verification codes, security
  // alerts, and school-spam are dropped pre-LLM; operation-triggered bulk
  // (投递确认 / 面试通知 / 报名成功 / 收据 / 发送回执) is KEPT and flows on to
  // classify_inbox + surfaces as `information` (priority medium). Real-person
  // (non-bulk) mail flows on unchanged.
  it('drops pure-marketing bulk (ads keywords)', () => {
    expect(shouldSkipBriefing(email({ bulk: true, subject: '热门职位推荐 限时优惠', textBody: '如不想收到请退订' }))).toBe(true)
  })
  it('drops verification-code bulk', () => {
    expect(shouldSkipBriefing(email({ bulk: true, from: { name: 'X', address: 'noreply@x.com' }, subject: '验证码', textBody: '您的验证码是 123456' }))).toBe(true)
  })
  it('drops security-alert bulk', () => {
    expect(shouldSkipBriefing(email({ bulk: true, from: { name: 'X', address: 'alert@x.com' }, subject: '安全提醒', textBody: '检测到异地登录' }))).toBe(true)
  })
  it('KEEPS operation-triggered bulk (投递确认 — bulk but not ads/codes/alerts)', () => {
    expect(
      shouldSkipBriefing(email({ bulk: true, from: { name: 'X', address: 'noreply@zhipuai.com' }, subject: '投递成功 — 后端工程师', textBody: '已收到您的简历' }))
    ).toBe(false)
  })
  it('KEEPS a bulk school notice (毕业/缴费 — not ads/codes/alerts)', () => {
    // Operation-triggered-ish bulk the user wants surfaced; the LLM then
    // classifies it. The old "drop ALL bulk" bar (ADR 0027/0028) is lifted.
    expect(shouldSkipBriefing(email({ bulk: true, subject: '毕业手续办理', textBody: '请于截止日前办理' }))).toBe(false)
  })
  it('keeps all non-bulk mail (real person)', () => {
    expect(shouldSkipBriefing(email({ subject: 'anything', textBody: '普通真人邮件' }))).toBe(false)
  })
  it('skips school-wide broadcast spam ([student_ips])', () => {
    expect(shouldSkipBriefing(email({ subject: '[student_ips] 关于选课', textBody: '请同学们尽快' }))).toBe(true)
  })
})

describe('shouldSkipFunnel (投递漏斗 path)', () => {
  it('skips pure-marketing bulk (ads keywords)', () => {
    expect(shouldSkipFunnel(email({ bulk: true, subject: '热门职位推荐 限时优惠', textBody: '退订' }))).toBe(true)
  })
  it('KEEPS bulk application-confirmation (bulk but not ads)', () => {
    expect(
      shouldSkipFunnel(email({ bulk: true, from: { name: 'X', address: 'noreply@zhipuai.com' }, subject: '投递成功 — 后端工程师', textBody: '已收到您的简历' }))
    ).toBe(false)
  })
  it('keeps recruiting portal verification codes in job funnel', () => {
    expect(
      shouldSkipFunnel(
        email({
          from: { name: '深信服科技', address: 'zhaopin@sangfor.com.cn' },
          subject: '【深信服科技】招聘官网验证码获取',
          textBody: '您的验证码是 829103，有效期 5 分钟。'
        })
      )
    ).toBe(false)
  })

  it('skips generic verification codes from job funnel', () => {
    expect(
      shouldSkipFunnel(
        email({
          from: { name: 'Service', address: 'noreply@service.com' },
          subject: '验证码通知',
          textBody: '您的验证码是 829103，有效期 5 分钟。'
        })
      )
    ).toBe(true)
  })

  it('skips CI / GitHub notifications from job funnel', () => {
    expect(
      shouldSkipFunnel(
        email({
          from: { name: 'GitHub', address: 'notifications@github.com' },
          subject: '[Zhaozed/zzyCv_web] Run failed: ci - main (a1663c5)',
          textBody: 'Workflow ci failed on main'
        })
      )
    ).toBe(true)
  })

  it('skips Cloudflare domain notices from job funnel', () => {
    expect(
      shouldSkipFunnel(
        email({
          from: { name: 'Cloudflare', address: 'noreply@notify.cloudflare.com' },
          subject: '[Confirmation] zhaozeyu-cv.top is active (Free plan)',
          textBody: 'Your domain is now active on Cloudflare free plan.'
        })
      )
    ).toBe(true)
  })

  it('skips Instagram / social recommendations and newsletters from job funnel', () => {
    expect(
      shouldSkipFunnel(
        email({
          from: { name: 'Instagram', address: 'follow-suggestions@mail.instagram.com' },
          subject: '在动态中查看 hudsonfan 、xuezhiqian 和更多账户',
          textBody: '根据你的兴趣为你推荐...'
        })
      )
    ).toBe(true)
    expect(
      shouldSkipFunnel(
        email({
          from: { name: 'Font Awesome', address: 'hello@m.fontawesome.com' },
          subject: 'Awesome News: Vellum Icons, Epic Flops & a Puzzle',
          textBody: 'Check out the latest icons...'
        })
      )
    ).toBe(true)
  })
})

describe('extractPositionFromText (ATS position extraction)', () => {
  it('extracts 产品经理 from 优必选 ATS confirmation body', () => {
    const text = '尊敬的候选人：您好！感谢您应聘深圳市优必选科技股份有限公司的产品经理岗位，您的简历已收到。'
    expect(extractPositionFromText(text)).toBe('产品经理')
  })

  it('extracts position from 职位名称 or 应聘职位 pattern', () => {
    expect(extractPositionFromText('感谢投递，职位名称：海外市场运营')).toBe('海外市场运营')
    expect(extractPositionFromText('您申请的【Java后端开发工程师】已进入初筛')).toBe('Java后端开发工程师')
  })
})

describe('extractJobCodeFromText (ATS job/position code extraction)', () => {
  it('extracts job code from 职位编号 / 岗位编号 pattern', () => {
    expect(extractJobCodeFromText('尊敬的候选人：您好！职位编号：P102938，岗位名称：产品经理')).toBe('P102938')
    expect(extractJobCodeFromText('感谢您投递我司，岗位编号: 20240901-RD')).toBe('20240901-RD')
  })

  it('extracts job code from Job ID / Req ID / 需求编号 pattern', () => {
    expect(extractJobCodeFromText('【美团招聘】您申请的职位（Job ID: MT-98721）已进入初筛')).toBe('MT-98721')
    expect(extractJobCodeFromText('您的应聘信息已收到，Req ID: REQ_2026_001')).toBe('REQ_2026_001')
    expect(extractJobCodeFromText('投递成功：需求编号: BZ-2024')).toBe('BZ-2024')
    expect(extractJobCodeFromText('【职位编号: ABC-123】面试通知')).toBe('ABC-123')
  })

  it('returns undefined when no job code is present', () => {
    expect(extractJobCodeFromText('感谢您的投递，请静候通知。')).toBeUndefined()
  })
})

describe('isRecruitingVip (Recruiting VIP and Resume Update signals)', () => {
  it('recognizes resume update and profile supplement emails as VIP', () => {
    expect(
      isRecruitingVip(
        email({
          subject: '【优必选】请完善您的个人简历与应聘信息',
          textBody: '感谢您投递我司产品经理岗位，请在3日内完善简历附件。'
        })
      )
    ).toBe(true)

    expect(
      isRecruitingVip(
        email({
          subject: '简历更新提醒',
          textBody: '您的简历需要更新补充个人资料。'
        })
      )
    ).toBe(true)

    expect(
      isRecruitingVip(
        email({
          subject: '应聘信息补充通知',
          textBody: '请登录招聘系统补充您的个人信息与简历。'
        })
      )
    ).toBe(true)
  })

  it('never skips recruiting VIP emails even if bulk or noreply', () => {
    const updateMail = email({
      from: { name: 'noreply-ats', address: 'noreply@beisen.com' },
      bulk: true,
      subject: '【腾讯】请完善您的应聘信息与简历',
      textBody: '感谢关注腾讯招聘，请点击链接补充应聘信息。'
    })
    expect(shouldSkipBriefing(updateMail)).toBe(false)
    expect(shouldSkipFunnel(updateMail)).toBe(false)
  })
})


