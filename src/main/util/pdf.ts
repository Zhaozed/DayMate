// PDF parsing utility for Daymate resume processing.
// Uses pdf-parse to extract plain text from user-uploaded PDF resumes.

/**
 * Extract plain text from a PDF Buffer.
 * Supports both CommonJS and ES Module layouts of pdf-parse v1 and v2.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  if (!buffer || buffer.length === 0) return ''
  try {
    const mod = (await import('pdf-parse')) as unknown as Record<string, unknown>
    // pdf-parse v2 class layout: { PDFParse: class ... }
    if (typeof mod.PDFParse === 'function') {
      const PDFParseClass = mod.PDFParse as new (opts: { data: Buffer }) => {
        getText: () => Promise<unknown>
        destroy: () => Promise<void>
      }
      const parser = new PDFParseClass({ data: buffer })
      const res = await parser.getText()
      await parser.destroy()
      if (typeof res === 'string') return res.trim()
      if (res && typeof (res as { text?: unknown }).text === 'string') {
        return (res as { text: string }).text.trim()
      }
    }
    // pdf-parse v1 function layout: default export or module export
    const fn = typeof mod.default === 'function' ? mod.default : mod
    if (typeof fn === 'function') {
      const data = await (fn as (b: Buffer) => Promise<{ text?: string }>)(buffer)
      return (data?.text || '').trim()
    }
  } catch (err) {
    console.error('[pdf] Failed to parse PDF text:', err)
  }
  return ''
}
