// Hand-rolled 5-field cron next-fire computation (Milestone F). Pure +
// framework-agnostic — importable by both the renderer (Routines page) and the
// main process. Lives in `src/shared` (compiled by both tsconfigs) because the
// Routines page (web) needs it; it is NOT an IPC contract.
//
// We hand-roll instead of adding `cron-parser` (Spec §23 rule 2): a 5-field cron
// next-fire is ~80 lines and the project's culture is hand-rolled (ZIP writer,
// SVG charts, Gmail REST). The dom/dow OR-rule + month-length + leap-year
// arithmetic is where bugs hide, so this is covered by a thorough test suite.
//
// Limitations (documented, honest):
//  - Local time only (matches `new Date()`; node-cron's optional `timezone`
//    field is not honoured — the app's own crons run in local time).
//  - Capped at a ~4-year look-ahead (1461 days) so the common quadrennial
//    Feb-29 cron resolves; the rare 8-year century gap (e.g. 2097→2104, since
//    2100 is NOT a leap year) returns `null` → the renderer falls back to the
//    raw cron. Never claims a precision we don't have.

interface CronField {
  readonly set: Set<number>
  /** `false` when the field was `*` (unrestricted) — needed for the dom/dow
   *  OR-rule (Vixie cron: when BOTH dom and dow are restricted, fire when
   *  EITHER matches; when only one is restricted, that one must match). */
  readonly restricted: boolean
}

/** Parse a single cron field: star, star-slash-N, N, N-M, N-M-slash-S,
 *  N-slash-S, or a comma list of these — into the set of allowed values
 *  within [min, max]. (Spelled out to avoid a star-slash sequence closing
 *  this JSDoc comment early.) */
function parseField(field: string, min: number, max: number): CronField {
  const restricted = field !== '*'
  const set = new Set<number>()
  for (const part of field.split(',')) {
    let step = 1
    let base = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      step = parseInt(part.slice(slash + 1), 10)
      base = part.slice(0, slash)
    }
    let lo: number, hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      lo = parseInt(a, 10)
      hi = parseInt(b, 10)
    } else {
      lo = parseInt(base, 10)
      // `N/step` = start at N, step through to max; `N` alone = just N.
      hi = slash >= 0 ? max : parseInt(base, 10)
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step <= 0) {
      continue
    }
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) set.add(v)
    }
  }
  return { set, restricted }
}

/** Day-of-week: cron 0-7 where 0 and 7 = Sunday; JS getDay() is 0=Sun..6=Sat.
 *  Normalize 7 → 0 so `.has(getDay())` matches. */
function parseDow(field: string): CronField {
  const f = parseField(field, 0, 7)
  if (f.set.has(7)) {
    f.set.add(0)
    f.set.delete(7)
  }
  return f
}

/**
 * Compute the next time a 5-field cron expression fires, strictly after `from`
 * (defaults to now). Returns `null` if the expression is malformed or has no
 * fire within the 366-day look-ahead. `from` defaults to `new Date()`; pass a
 * fixed date for deterministic tests.
 */
export function nextCronFire(expr: string, from: Date = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseField(parts[0], 0, 59)
  const hours = parseField(parts[1], 0, 23)
  const doms = parseField(parts[2], 1, 31)
  const months = parseField(parts[3], 1, 12)
  const dows = parseDow(parts[4])
  if (
    minutes.set.size === 0 ||
    hours.set.size === 0 ||
    doms.set.size === 0 ||
    months.set.size === 0 ||
    dows.set.size === 0
  ) {
    return null
  }

  // Cursor = the minute strictly after `from`.
  const cur = new Date(from.getTime())
  cur.setSeconds(0, 0)
  cur.setMilliseconds(0)
  cur.setMinutes(cur.getMinutes() + 1)

  const limitMs = from.getTime() + 1461 * 24 * 60 * 60 * 1000
  const sortedHours = [...hours.set].sort((a, b) => a - b)
  const sortedMins = [...minutes.set].sort((a, b) => a - b)

  while (cur.getTime() <= limitMs) {
    const M = cur.getMonth() + 1 // 1-12
    if (!months.set.has(M)) {
      // Skip to the 1st of the next month (setDate(1) BEFORE advancing the
      // month avoids Jan 31 → Mar 3 rollover).
      cur.setDate(1)
      cur.setMonth(cur.getMonth() + 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    const dom = cur.getDate()
    const dow = cur.getDay()
    const dayMatch =
      doms.restricted && dows.restricted
        ? doms.set.has(dom) || dows.set.has(dow)
        : doms.set.has(dom) && dows.set.has(dow)
    if (!dayMatch) {
      cur.setDate(dom + 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    // Earliest (h, m) on this day that is >= the cursor's time-of-day.
    const nowMin = cur.getHours() * 60 + cur.getMinutes()
    let foundH = -1
    let foundM = -1
    outer: for (const h of sortedHours) {
      for (const m of sortedMins) {
        if (h * 60 + m >= nowMin) {
          foundH = h
          foundM = m
          break outer
        }
      }
    }
    if (foundH >= 0) {
      cur.setHours(foundH, foundM, 0, 0)
      return new Date(cur.getTime())
    }
    // No matching time today → next day.
    cur.setDate(dom + 1)
    cur.setHours(0, 0, 0, 0)
  }
  return null
}

/** Human-readable "next fire" hint for the Routines page. Returns localized
 *  strings; falls back to `null` (caller shows the raw cron) when the
 *  expression is malformed or has no fire within a year. */
export function nextFireHint(expr: string, from: Date = new Date()): string | null {
  const next = nextCronFire(expr, from)
  if (!next) return null
  return `下次 ≈ ${next.toLocaleString('zh-CN')}`
}
