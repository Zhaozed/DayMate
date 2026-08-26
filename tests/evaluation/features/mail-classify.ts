// 功能测试集：邮件分类（feature: mail-classify）
//
// 这是「单功能测试集」—— 走查第 1 项（2026-08-26）的产物：
//   - 真实形态邮件（实体脱敏，形态取自真实邮件生态：REMOS 研讨会 / MAYA 考官
//     跟进 / 鱼云服务到期 / Maxim AI 试用 / 学术跟进 / 营销）
//   - 顺带补上回归集覆盖矩阵的缺口：meeting×reply、meeting×information、
//     中文 follow_up、中文/英文费用到期、真人一对一、营销促销
//   - 覆盖矩阵见 regression-set-spec.md（v3）
//
// ⚠️ 工作流（regression-set-spec.md「评测工作流」）：
//   开发期用 `EVAL_FEATURE=mail-classify` 跑本功能集（stub 冒烟 → 真模型），
//   走查确认满意后，把 case 合入回归集（tests/evaluation/dataset.ts）+ 三向同步。
//   本文件里的 case 尚未合入回归集 —— 它们是「开发期靶子」，独立于回归集。
//
// 走查已发现并修复（同步进了生产代码，三向一致）：
//   - 英文裸 "offer" 促销/招聘歧义 → ads 检测提前于 recruiting（cls/offer 歧义）
//   - stub 缺中文跟进信号（跟进/催促/尽快回复）→ wantsReply/isFollowUp 补正则
//   - 服务到期未归账单域（到期/expire）→ detectTopic fees 补正则

import type { NormalizedEmail } from '@shared/types'
import { email } from '../dataset'
import type { EmailClassification, EmailTopic } from '../dataset'

export interface FeatureClassifyCase {
  id: string
  feature: 'mail-classify'
  category: 'email_classification'
  input: NormalizedEmail
  expected: { classification: EmailClassification; untrusted: boolean; topic: EmailTopic }
}

export const MAIL_CLASSIFY_CASES: FeatureClassifyCase[] = [
  // meeting × reply —— 会议邀请需确认（RSVP）
  { id: 'mc-01', feature: 'mail-classify', category: 'email_classification', input: email({ subject: '[FSKTM MSE] Invitation: REMOS S2 - Artificial Intelligence', textBody: 'Dear colleague, you are invited to the REMOS S2 session on Artificial Intelligence. Please confirm your attendance by Friday.' }), expected: { classification: 'reply', untrusted: false, topic: 'meeting' } },
  // meeting × information —— 会议议程知会，无回复需求
  { id: 'mc-02', feature: 'mail-classify', category: 'email_classification', input: email({ subject: '[FSKTM MSE] REMOS S2 session agenda', textBody: 'The agenda for the upcoming session is attached for your reference. No reply needed.' }), expected: { classification: 'information', untrusted: false, topic: 'meeting' } },
  // follow_up × 中文 —— 真人催办（MAYA 考官录入）
  { id: 'mc-03', feature: 'mail-classify', category: 'email_classification', input: email({ subject: 'Re: MAYA 考官姓名录入', textBody: '跟进一下：上次邮件还没收到您的确认，麻烦尽快回复。' }), expected: { classification: 'follow_up', untrusted: false, topic: 'general' } },
  // fees_billing × information —— 中文服务到期（鱼云）
  { id: 'mc-04', feature: 'mail-classify', category: 'email_classification', input: email({ subject: '在 SakanaCloud 鱼云 的服务即将到期', textBody: '您的实例将在 3 天后到期，如需续订请及时处理，无需回复。' }), expected: { classification: 'information', untrusted: false, topic: 'fees_billing' } },
  // fees_billing × information —— 英文 SaaS 试用到期（Maxim AI）
  { id: 'mc-05', feature: 'mail-classify', category: 'email_classification', input: email({ subject: 'Maxim AI Trial expiring soon', textBody: 'Your trial expires in 3 days. Renew or switch to the free plan from your dashboard — no reply needed.' }), expected: { classification: 'information', untrusted: false, topic: 'fees_billing' } },
  // follow_up × 真人学术 —— 催论文题目决定
  { id: 'mc-06', feature: 'mail-classify', category: 'email_classification', input: email({ subject: 'Re: Dissertation Title', textBody: 'Following up on my last email — I still need your decision on the dissertation title.' }), expected: { classification: 'follow_up', untrusted: false, topic: 'general' } },
  // ads × ignore —— 营销促销（offer 歧义锚点：ads 先于 recruiting）
  { id: 'mc-07', feature: 'mail-classify', category: 'email_classification', input: email({ subject: 'Flash Sale: GrabFood Deals up to 50% off', textBody: 'Limited time offer — order now. Unsubscribe anytime.' }), expected: { classification: 'ignore', untrusted: false, topic: 'ads' } }
]

export const FEATURE_CASES = [...MAIL_CLASSIFY_CASES]