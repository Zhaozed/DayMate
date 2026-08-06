// Template resolution for Routine steps. Step fields may reference outputs of
// earlier steps using `{{outputKey}}` or `{{outputKey.path.to.value}}` tokens.
//
// - If a string field is EXACTLY one token (`{{x}}`), the referenced raw value
//   (object/array/number/...) is returned, preserving type.
// - If a string has tokens mixed with other text, the tokens are stringified in
//   place and a string is returned.
// - Objects/arrays are walked recursively.
//
// This keeps Routine JSON declarative: the agent step reads `{{emails}}`, the
// need_to_know step reads `{{brief.sourceRefs}}`, etc.

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
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

export function resolveTemplate(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.trim().match(/^{{\s*([\w.]+)\s*}}$/)
    if (exact) {
      return getPath(outputs, exact[1])
    }
    // Mixed interpolation.
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
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
