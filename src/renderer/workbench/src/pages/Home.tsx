import type { ReactElement } from 'react'
import { NeedToKnowPage } from './NeedToKnow'

// 首页 (Home): 邮件智能聚合与核心动态
// 直接呈现聚合后的邮件动态流（Gmail & 163），支持按线程聚合、重要星标、
// 4 分类（学校/求职/日常/其他）、内联修改摘要与原文深链跳转。
// 今日天气与今日晨报卡片已彻底移除。
export function HomePage(): ReactElement {
  return (
    <NeedToKnowPage
      title="首页"
      subtitle="邮件智能聚合与核心动态（Gmail & 163）。按线程聚合 · 学校 / 求职 / 日常"
    />
  )
}
