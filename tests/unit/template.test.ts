import { describe, it, expect } from 'vitest'
import { resolveTemplate } from '../../src/main/routines/template'

describe('resolveTemplate', () => {
  const outputs = {
    brief: { title: 'Morning Brief', sourceRefs: [{ id: 'e1', type: 'email' }] },
    gmailEmails: [
      {
        accountId: 'mock-gmail-001',
        threadId: 'mock-thread-001',
        from: { name: 'Alice Chen', address: 'alice@example.com' },
        subject: 'Q3 roadmap review'
      },
      {
        accountId: 'mock-gmail-001',
        threadId: 'mock-thread-002',
        from: { name: 'Bob', address: 'bob@example.com' },
        subject: 'Standup'
      }
    ]
  }

  it('returns the raw value for an exact token (preserves type)', () => {
    const out = resolveTemplate('{{brief}}', outputs) as { title: string }
    expect(out).toEqual(outputs.brief)
  })

  it('walks dotted paths for an exact token', () => {
    expect(resolveTemplate('{{brief.title}}', outputs)).toBe('Morning Brief')
  })

  it('interpolates mixed tokens into a string', () => {
    expect(resolveTemplate('Re: {{brief.title}}', outputs)).toBe('Re: Morning Brief')
  })

  it('resolves array-index tokens like {{arr[0].field}} (M4)', () => {
    expect(resolveTemplate('{{gmailEmails[0].from.address}}', outputs)).toBe('alice@example.com')
    expect(resolveTemplate('{{gmailEmails[1].from.name}}', outputs)).toBe('Bob')
  })

  it('resolves array-index tokens with a leading index segment', () => {
    expect(resolveTemplate('{{gmailEmails[0].subject}}', outputs)).toBe('Q3 roadmap review')
  })

  it('interpolates array-index tokens in mixed strings', () => {
    expect(resolveTemplate('Re: {{gmailEmails[0].subject}}', outputs)).toBe('Re: Q3 roadmap review')
  })

  it('walks objects/arrays recursively, resolving nested tokens', () => {
    const args = {
      accountId: '{{gmailEmails[0].accountId}}',
      threadId: '{{gmailEmails[0].threadId}}',
      to: [{ address: '{{gmailEmails[0].from.address}}', name: '{{gmailEmails[0].from.name}}' }],
      subject: 'Re: {{gmailEmails[0].subject}}',
      body: 'canned'
    }
    expect(resolveTemplate(args, outputs)).toEqual({
      accountId: 'mock-gmail-001',
      threadId: 'mock-thread-001',
      to: [{ address: 'alice@example.com', name: 'Alice Chen' }],
      subject: 'Re: Q3 roadmap review',
      body: 'canned'
    })
  })

  it('returns undefined for a missing exact path (no token expansion)', () => {
    expect(resolveTemplate('{{missing.path}}', outputs)).toBeUndefined()
  })

  it('renders an empty string for a missing path in mixed interpolation', () => {
    expect(resolveTemplate('Hello {{missing}}', outputs)).toBe('Hello ')
  })
})
