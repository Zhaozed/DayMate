// Deterministic bulk-mail (mass / list / system) detection — runs BEFORE any
// LLM call so school list-notices / platform edm never burn a classify pass.
// Pure functions, zero LLM, fully unit-testable (the user's "尽可能稳定" ask).
//
// Two-layer:
//  1. `detectBulkFromHeaders` — reads RFC822 routing headers the sender itself
//     declares (Precedence: bulk / List-Id / Auto-Submitted / List-Unsubscribe
//     / X-Mailing-List). Called by each provider at normalize time; the raw
//     headers stay provider-local (never persisted on NormalizedEmail — §17:
//     a malicious header value must not ride into an LLM prompt). Only the
//     resulting boolean is stored as `NormalizedEmail.bulk`.
//  2. `isBulkMail` — the path-facing predicate: the header-derived `bulk`
//     flag OR a bulk sender pattern OR a school mailing-list alias in To.
//
// Path filters (also here, deterministic):
//  - `shouldSkipBriefing`: bulk AND no important keyword → skip 必读 LLM
//    (毕业/缴费/答辩 etc. are a safety net so a mass mail that matters still
//    surfaces). Reply-needed important mail still drafts (only the classify
//    pass is skipped for non-important bulk; important bulk keeps going).
//  - `shouldSkipFunnel`: bulk AND ads keywords → skip the 投递 funnel LLM.
//    投递确认/面试通知 are bulk but NOT ads → kept (they ARE the funnel's
//    feed, ADR 0019). Pure marketing edm only.

import type { NormalizedEmail } from '@shared/types'

/** A mail is bulk if ANY standard routing header declares it. */
export function detectBulkFromHeaders(get: (name: string) => string): boolean {
  const precedence = get('precedence').toLowerCase().trim()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true
  if (get('list-id').trim()) return true
  const autoSubmitted = get('auto-submitted').toLowerCase().trim()
  if (autoSubmitted === 'auto-generated' || autoSubmitted === 'auto-replied') return true
  if (get('list-unsubscribe').trim()) return true
  if (get('x-mailing-list').trim()) return true
  return false
}

/** Reply-blocking / automated sender tokens. Matched ANYWHERE in the
 *  local-part (not start-anchored) so compound addresses like
 *  `jobs-noreply@linkedin.com` or `railway-noreply@railway.app` are caught —
 *  the old `^noreply@` anchor missed those, letting LinkedIn marketing +
 *  Railway auto-notifications through to the LLM. Case-insensitive. */
const BULK_SENDER_CONTAINS_RE =
  /(noreply|no-reply|donotreply|do-not-reply|do-not-respond|noresponse|mailer-?daemon|postmaster|automated|auto-?reply|auto-?generated)/i

/** Automated-sender local-part PREFIXES (CI / monitoring / deploy / alert
 *  bots — Railway deployment notifications, GitHub Actions, Sentry, etc.).
 *  These almost never carry a human-actionable reply; surfacing them as 必读
 *  or ToDo (the old bug: "重启 Railway 部署") is wrong. Start-anchored to
 *  avoid clobbering a real person whose name happens to contain "bot". */
const BULK_SENDER_PREFIX_RE =
  /^(notice|notification|notifications|alert|alerts|monitor|monitoring|deploy|deployment|ci|bot|system|admin|administrator|reply-required|auto|status|no-?reply)@/i

/** School mailing-list alias local-parts (To a list address, not you). */
const SCHOOL_LIST_ALIAS_RE =
  /^(all[-_]?students|undergraduates?|graduates?|postdocs?|students[-_]?all|all-staff|all-faculty|everyone|members|class-of-\d{4})@/i

/** A normalized email is bulk if the provider flagged it (headers) OR the
 *  sender is a system/automated address OR a recipient is a school list
 *  alias. */
export function isBulkMail(email: NormalizedEmail): boolean {
  if (email.bulk) return true
  const from = email.from.address ?? ''
  if (BULK_SENDER_CONTAINS_RE.test(from) || BULK_SENDER_PREFIX_RE.test(from)) return true
  if (email.to.some((t) => SCHOOL_LIST_ALIAS_RE.test(t.address ?? ''))) return true
  return false
}

// Shared keyword regexes (DRY — `detectTopic` reuses ADS_KEYWORD_RE).

/** Marketing / promotional markers (mirrors the former inline ads regex). */
export const ADS_KEYWORD_RE =
  /退订|unsubscribe|广告|promotion|优惠|促销|限时|折扣|discount|coupon|营销|推广|edm/i

/** Verification-code / OTP markers — operation-triggered but NOT 必读-worthy
 *  (the user explicitly excludes codes from the relaxed 必读 filter, ADR
 *  0029). Deterministic drop before any LLM call. */
export const VERIFICATION_CODE_RE =
  /验证码|验证代码|verify code|verification code|auth code|otp|one[- ]?time password|动态码|安全码|确认码|confirmation code|校验码/i

/** Security-alert markers — operation-triggered but NOT 必读-worthy (the user
 *  explicitly excludes security alerts, ADR 0029). Login alerts, 异常登录,
 *  suspicious-activity warnings. Deterministic drop. */
export const SECURITY_ALERT_RE =
  /安全提醒|安全提示|异常登录|异地登录|登录提醒|登录尝试|new login|suspicious|security alert|account alert|account notification|we noticed a new login|verify it'?s you/i

/** Safety net: even a bulk mail matching these still surfaces in 必读. */
export const IMPORTANT_BULK_KEYWORD_RE =
  /毕业|学位|答辩|选课|缴费|签证|紧急|截止|offer|面试|录取|报到|注册|学费|挂科|学分|离校|手续/i

/** Recruiting signal — used to keep bulk recruiting-confirmation mail in the
 *  funnel (it's bulk but not ads → already kept; this is for future
 *  school-domain heuristics, kept here for DRY). */
export const RECRUITING_KEYWORD_RE = /投递|简历|面试|offer|职位|网申|笔试|录用|内推|秋招|春招|投递成功|已收到您的/i

function textOf(email: NormalizedEmail): string {
  return `${email.subject ?? ''} ${email.textBody ?? ''}`
}

/** 必读 path skip tokens — school-wide broadcast spam subjects (ADR 0027). */
export function shouldSkipBriefing(
  email: NormalizedEmail,
  skipTokens: string[] = DEFAULT_SKIP_TOKENS
): boolean {
  if (isSchoolSpam(email, skipTokens)) return true
  if (!isBulkMail(email)) return false // real-person mail → classify
  // Bulk mail: split pure ads / verification codes / security alerts (drop)
  // from operation-triggered auto-mail (投递确认 / 面试通知 / 报名成功 / 收据 /
  // 发送回执 / opted-in deploy-status) which the user wants KEPT in 必读
  // (ADR 0029). The LLM prompt then surfaces operation-triggered as
  // `information`; unsolicited marketing still `ignore`'d by the LLM.
  const text = textOf(email)
  if (ADS_KEYWORD_RE.test(text)) return true // pure marketing/edm/promo
  if (VERIFICATION_CODE_RE.test(text)) return true
  if (SECURITY_ALERT_RE.test(text)) return true
  return false // operation-triggered bulk → keep, classify
}

/** 投递漏斗 path: skip only pure-marketing bulk (ads keywords). 投递确认 /
 *  面试通知 are bulk but not ads → kept (they are the funnel's feed). */
export function shouldSkipFunnel(email: NormalizedEmail): boolean {
  return isBulkMail(email) && ADS_KEYWORD_RE.test(textOf(email))
}

// ── School-wide broadcast spam (ADR 0027) ───────────────────────────────────
// The user's school mailbox gets a lot of mailing-list broadcast spam whose
// subjects carry a list prefix like "[student_ips]". Such mail must NEVER
// reach an LLM (zero cost) and NEVER produce a ToDo — only 学院/专业/私人
// (department / major / personal) mail is worth surfacing. The skip-token list
// is user-configurable (集成与设置); default `[student_ips]`. A token matches
// case-insensitively as a substring of the subject. Pure function, zero LLM.

/** Default subject-substring tokens treated as school-wide broadcast spam. */
export const DEFAULT_SKIP_TOKENS = ['[student_ips]']

/** True if the email's subject contains a configured school-spam token. */
export function isSchoolSpam(
  email: NormalizedEmail,
  tokens: string[] = DEFAULT_SKIP_TOKENS
): boolean {
  const subj = (email.subject ?? '').toLowerCase()
  if (!subj || tokens.length === 0) return false
  return tokens.some((t) => t && subj.includes(t.toLowerCase()))
}

