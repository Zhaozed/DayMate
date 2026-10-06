import { describe, it, expect } from 'vitest'
import { extractTextFromPdf } from '../../src/main/util/pdf'

describe('extractTextFromPdf', () => {
  it('returns empty string for empty buffer', async () => {
    const text = await extractTextFromPdf(Buffer.alloc(0))
    expect(text).toBe('')
  })

  it('handles invalid buffer gracefully without throwing', async () => {
    const text = await extractTextFromPdf(Buffer.from('not a pdf'))
    expect(text).toBe('')
  })
})
