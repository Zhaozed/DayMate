import { describe, it, expect } from 'vitest'
import { isSchoolSpam, DEFAULT_SKIP_TOKENS } from '../../src/main/util/bulk-mail'
import type { NormalizedEmail } from '@shared/types'

function email(subject: string): NormalizedEmail {
  return {
    provider: 'gmail',
    accountId: 'a',
    messageId: 'm1',
    from: { name: 'X', address: 'x@y.com' },
    to: [{ address: 'me@y.com' }],
    cc: [],
    subject,
    textBody: '',
    receivedAt: new Date().toISOString(),
    unread: true,
    labels: [],
    sourceUrl: ''
  }
}

describe('isSchoolSpam (ADR 0027 — subject-substring skip filter)', () => {
  it('flags a subject containing the default [student_ips] token', () => {
    expect(isSchoolSpam(email('[student_ips] 学院通知'))).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSchoolSpam(email('[Student_IPS] weekly digest'))).toBe(true)
    expect(isSchoolSpam(email('[STUDENT_ips] vol-42'))).toBe(true)
  })

  it('leaves real department / personal mail alone', () => {
    expect(isSchoolSpam(email('关于本学期选课安排'))).toBe(false)
    expect(isSchoolSpam(email('计算机专业实习通知'))).toBe(false)
    expect(isSchoolSpam(email('Re: 论文修改意见'))).toBe(false)
  })

  it('returns false for an empty subject', () => {
    expect(isSchoolSpam(email(''))).toBe(false)
  })

  it('respects a custom token list', () => {
    expect(isSchoolSpam(email('[cs-announce] seminar'), ['[cs-announce]'])).toBe(true)
    expect(isSchoolSpam(email('[student_ips] 通知'), ['[cs-announce]'])).toBe(false)
  })

  it('returns false when tokens list is empty (no filter applied)', () => {
    expect(isSchoolSpam(email('[student_ips] 通知'), [])).toBe(false)
  })

  it('default token list is [student_ips]', () => {
    expect(DEFAULT_SKIP_TOKENS).toEqual(['[student_ips]'])
  })
})
