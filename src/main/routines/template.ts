// Template resolution for Routine steps. Step fields may reference outputs of
// earlier steps using `{{outputKey}}`, `{{outputKey.path.to.value}}`, or
// `{{arr[0].field}}` tokens.
//
// - If a string field is EXACTLY one token (`{{x}}`), the referenced raw value
//   (object/array/number/...) is returned, preserving type.
// - If a string has tokens mixed with other text, the tokens are stringified in
//   place and a string is returned.
// - Objects/arrays are walked recursively.
// - Array index access (`[N]`) is supported inside paths (M4 — the Draft Review
//   routine references the first unread email via `{{gmailEmails[0].from}}`).
//
// This keeps Routine JSON declarative: the agent step reads `{{emails}}`, the
// need_to_know step reads `{{brief.sourceRefs}}`, etc.

/** Tokenize a path with optional `[N]` index segments into dotted parts. */
function tokenizePath(path: string): string[] {
  // `gmailEmails[0].from` → `gmailEmails.0.from` → split on '.'.
  return path.replace(/\[/g, '.').replace(/\]/g, '').split('.')
}

function getPath(obj: unknown, path: string): unknown {
  const parts = tokenizePath(path)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(p)
      cur = Number.isNaN(idx) ? undefined : cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

// Token path: word chars, dots, and bracket index segments.
const TOKEN_PATH = /[\w.]+(?:\[\d+\][\w.]*)*/
const EXACT_RE = new RegExp(`^{{\\s*(${TOKEN_PATH.source})\\s*}}$`)
const MIXED_RE = new RegExp(`(\\{{\\s*(${TOKEN_PATH.source})\\s*\\}\\})`, 'g')

export function resolveTemplate(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.trim().match(EXACT_RE)
    if (exact) {
      return getPath(outputs, exact[1])
    }
    // Mixed interpolation.
    return value.replace(MIXED_RE, (_, _full: string, path: string) => {
      const v = getPath(outputs, path)
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    })
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplate(v, outputs))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplate(v, outputs)
    }
    return out
  }
  return value
}
