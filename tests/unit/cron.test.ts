// Milestone F — hand-rolled 5-field cron next-fire computation (§23 rule 2:
// no `cron-parser` dep). Covers the app's real cron expressions + the edge
// cases where a hand-rolled parser tends to break (Feb 29, weekday-only, dom/
// dow OR-rule, step ranges, comma lists, Sunday-as-0-or-7).
import { describe, it, expect } from 'vitest'
import { nextCronFire, nextFireHint } from '@shared/cron'

// Fixed reference time so assertions are deterministic. Tuesday 2026-08-11
// 10:30 local — a weekday mid-morning, safely inside all the app windows.
const FROM = new Date(2026, 7, 11, 10, 30, 0) // Aug 11 2026 10:30 (Tue)

describe('nextCronFire — app cron expressions', () => {
  it('0 18 * * 1-5 → next weekday 18:00 (same day, later)', () => {
    const next = nextCronFire('0 18 * * 1-5', FROM)!
    // Aug 11 is Tuesday → same day at 18:00.
    expect(next.getDay()).toBe(2) // Tuesday
    expect(next.getHours()).toBe(18)
    expect(next.getMinutes()).toBe(0)
  })

  it('0 9 * * 1-5 → next weekday 09:00 (next day, since 09:00 already passed)', () => {
    const next = nextCronFire('0 9 * * 1-5', FROM)!
    // 09:00 today already passed → tomorrow (Wed Aug 12) 09:00.
    expect(next.getDate()).toBe(12)
    expect(next.getDay()).toBe(3) // Wednesday
    expect(next.getHours()).toBe(9)
  })

  it('3 8 * * * → tomorrow 08:03 (daily)', () => {
    const next = nextCronFire('3 8 * * *', FROM)!
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBe(3)
  })

  it('17 8 * * * → tomorrow 08:17 (daily fortune cron)', () => {
    const next = nextCronFire('17 8 * * *', FROM)!
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBe(17)
  })

  it('0 3 * * * → tomorrow 03:00 (daily maintenance cron)', () => {
    const next = nextCronFire('0 3 * * *', FROM)!
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(3)
  })

  it('*/5 * * * * → next 5-minute boundary', () => {
    const next = nextCronFire('*/5 * * * *', FROM)!
    // 10:30 → 10:35.
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(35)
  })
})

describe('nextCronFire — field grammar', () => {
  it('comma list in minutes', () => {
    // 10:30 from → next minute in {15,30,45} that is > 10:30 → 10:45.
    const next = nextCronFire('15,30,45 * * * *', FROM)!
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(45)
  })

  it('range with step', () => {
    // hours 0,3,6,9,12,15,18,21 — next after 10:30 is 12:00.
    const next = nextCronFire('0 0-23/3 * * *', FROM)!
    expect(next.getHours()).toBe(12)
    expect(next.getMinutes()).toBe(0)
  })

  it('single value list', () => {
    // only at 09:00 and 17:00 weekdays — next is 17:00 today (Tue).
    const next = nextCronFire('0 9,17 * * 1-5', FROM)!
    expect(next.getHours()).toBe(17)
    expect(next.getDay()).toBe(2)
  })

  it('Sunday as 0 and as 7 both match', () => {
    // FROM = Tuesday. Next Sunday (Aug 16) at 10:00 with dow=0.
    const sun0 = nextCronFire('0 10 * * 0', FROM)!
    expect(sun0.getDay()).toBe(0) // Sunday
    expect(sun0.getDate()).toBe(16)
    // dow=7 must normalize to 0 → same result.
    const sun7 = nextCronFire('0 10 * * 7', FROM)!
    expect(sun7.getTime()).toBe(sun0.getTime())
  })
})

describe('nextCronFire — dom/dow OR-rule (Vixie cron)', () => {
  it('both restricted → fires when EITHER matches (OR)', () => {
    // FROM = Tue Aug 11. `0 10 13 * 1` = 13th of month OR Monday at 10:00.
    // Aug 13 is Thursday (not 13th-on-Monday), but the dom=13 branch fires on
    // Aug 13 regardless of weekday. Aug 12-16 are Tue..Sat. The nearest Monday
    // is Aug 17. The 13th (Thu) is sooner → OR picks Aug 13.
    const next = nextCronFire('0 10 13 * 1', FROM)!
    expect(next.getDate()).toBe(13)
    expect(next.getHours()).toBe(10)
  })

  it('only dom restricted (dow *) → must match dom', () => {
    // Aug 11 → next 15th-of-month at 10:00. Aug has a 15th (Sat).
    const next = nextCronFire('0 10 15 * *', FROM)!
    expect(next.getDate()).toBe(15)
    expect(next.getHours()).toBe(10)
  })

  it('only dow restricted (dom *) → must match dow', () => {
    // Monday-only at 09:00. Next Monday from Tue Aug 11 is Aug 17.
    const next = nextCronFire('0 9 * * 1', FROM)!
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getDate()).toBe(17)
  })

  it('neither restricted (both *) → every day', () => {
    const next = nextCronFire('0 0 * * *', FROM)!
    // Midnight tomorrow.
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(0)
  })
})

describe('nextCronFire — month + leap year', () => {
  it('Feb 29 fires in a leap year', () => {
    // From Aug 2026 → next Feb 29 is 2028 (2028 is a leap year; 2027 is not).
    const next = nextCronFire('0 0 29 2 *', FROM)!
    expect(next.getMonth()).toBe(1) // Feb (0-indexed)
    expect(next.getDate()).toBe(29)
    expect(next.getFullYear()).toBe(2028)
  })

  it('Feb 30 is impossible → skips to a valid Feb day only if listed, else null-ish', () => {
    // Feb never has 30 → the dom field {30} never matches in Feb, and month
    // is restricted to Feb (month=2), so NO day ever matches → null (no fire
    // within the 366-day window).
    const next = nextCronFire('0 0 30 2 *', FROM)
    expect(next).toBeNull()
  })

  it('month list skips months not in the set', () => {
    // Only Jan + Jul at 10:00. From Aug → next is Jan 2027.
    const next = nextCronFire('0 10 * 1,7 *', FROM)!
    expect(next.getMonth()).toBe(0) // Jan
    expect(next.getFullYear()).toBe(2027)
  })
})

describe('nextCronFire — strictly after `from`', () => {
  it('never returns a time at or before `from`', () => {
    // Every minute — from 10:30:00 → 10:31:00 (strictly after).
    const from = new Date(2026, 7, 11, 10, 30, 0)
    const next = nextCronFire('* * * * *', from)!
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getMinutes()).toBe(31)
  })
})

describe('nextCronFire — malformed input', () => {
  it('wrong field count → null', () => {
    expect(nextCronFire('0 9 * * 1-5 extra', FROM)).toBeNull()
    expect(nextCronFire('0 9 *', FROM)).toBeNull()
  })

  it('out-of-range values → null (no matching minute/hour)', () => {
    // minute 60 is invalid → empty minute set → null.
    expect(nextCronFire('60 9 * * *', FROM)).toBeNull()
    // hour 24 invalid.
    expect(nextCronFire('0 24 * * *', FROM)).toBeNull()
  })

  it('empty expression → null', () => {
    expect(nextCronFire('', FROM)).toBeNull()
    expect(nextCronFire('   ', FROM)).toBeNull()
  })
})

describe('nextFireHint', () => {
  it('returns a localized "下次 ≈ …" string for a valid cron', () => {
    const hint = nextFireHint('3 8 * * *', FROM)
    expect(hint).not.toBeNull()
    expect(hint).toContain('下次 ≈')
  })

  it('returns null for a malformed cron', () => {
    expect(nextFireHint('not a cron', FROM)).toBeNull()
  })
})
