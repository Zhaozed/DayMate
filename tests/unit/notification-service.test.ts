// Milestone D §D2 — NotificationService: toggles, quiet hours, aggregation,
// native injection. The notifier + clock are injected so no Electron is needed.
import { describe, it, expect } from 'vitest'
import { NotificationService } from '../../src/main/services/notification-service'
import type { NotificationPrefs } from '@shared/types'

function makeService(
  prefs: NotificationPrefs,
  opts: { now?: () => Date; notifier?: (t: string, b: string) => void; pushBubble?: (n: { message: string }) => void } = {}
) {
  const bubbles: { message: string; navigateTo?: string }[] = []
  const native: { title: string; body: string }[] = []
  const svc = new NotificationService({
    readPrefs: async () => prefs,
    pushBubble: (n) => {
      bubbles.push({ message: n.message, navigateTo: n.navigateTo })
      opts.pushBubble?.(n)
    },
    notifier: (title, body) => {
      native.push({ title, body })
      opts.notifier?.(title, body)
    },
    now: opts.now
  })
  return { svc, bubbles, native }
}

describe('NotificationService (§D2)', () => {
  it('surfaces the robot bubble + native popup by default', async () => {
    const { svc, bubbles, native } = makeService({})
    await svc.refreshPrefs()
    const ok = svc.notify({ message: '晨报已就绪', category: 'routine', routineId: 'morning_brief' })
    expect(ok).toBe(true)
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].message).toBe('晨报已就绪')
    expect(native).toHaveLength(1)
    expect(native[0]).toEqual({ title: 'Daymate', body: '晨报已就绪' })
  })

  it('per-category toggle fully suppresses both surfaces', async () => {
    const { svc, bubbles, native } = makeService({ categories: { routine: false } })
    await svc.refreshPrefs()
    const ok = svc.notify({ message: 'x', category: 'routine' })
    expect(ok).toBe(false)
    expect(bubbles).toHaveLength(0)
    expect(native).toHaveLength(0)
  })

  it('per-routine override wins over the category default', async () => {
    // category 'routine' muted, but this routine is force-enabled.
    const { svc: onSvc, bubbles: onB, native: onN } = makeService({
      categories: { routine: false },
      routineOverrides: { morning_brief: true }
    })
    await onSvc.refreshPrefs()
    onSvc.notify({ message: 'x', category: 'routine', routineId: 'morning_brief' })
    expect(onB).toHaveLength(1)
    expect(onN).toHaveLength(1)
    // A routine without an override falls back to the (muted) category.
    const { svc: offSvc, bubbles: offB } = makeService({
      categories: { routine: false },
      routineOverrides: { morning_brief: true }
    })
    await offSvc.refreshPrefs()
    offSvc.notify({ message: 'x', category: 'routine', routineId: 'interview_prep' })
    expect(offB).toHaveLength(0)
  })

  it('quiet hours suppress the native popup but keep the robot bubble', async () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 30, 0)
    const { svc, bubbles, native } = makeService(
      { quietHours: { enabled: true, start: '22:00', end: '07:00' } },
      { now: () => at(23) }
    )
    await svc.refreshPrefs()
    expect(svc.inQuietHours()).toBe(true)
    svc.notify({ message: '深夜通知', category: 'info' })
    expect(bubbles).toHaveLength(1) // in-app bubble stays
    expect(native).toHaveLength(0) // native suppressed
  })

  it('quiet hours overnight window (22:00→07:00) covers early morning', async () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 0, 0)
    const { svc } = makeService(
      { quietHours: { enabled: true, start: '22:00', end: '07:00' } },
      { now: () => at(3) }
    )
    await svc.refreshPrefs()
    expect(svc.inQuietHours()).toBe(true)
  })

  it('outside quiet hours the native popup fires', async () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 30, 0)
    const { svc, native } = makeService(
      { quietHours: { enabled: true, start: '22:00', end: '07:00' } },
      { now: () => at(10) }
    )
    await svc.refreshPrefs()
    expect(svc.inQuietHours()).toBe(false)
    svc.notify({ message: '白天通知', category: 'info' })
    expect(native).toHaveLength(1)
  })

  it('native master switch off suppresses native only', async () => {
    const { svc, bubbles, native } = makeService({ nativeEnabled: false })
    await svc.refreshPrefs()
    svc.notify({ message: 'x', category: 'info' })
    expect(bubbles).toHaveLength(1)
    expect(native).toHaveLength(0)
  })

  it('aggregation collapses an identical burst within the window', async () => {
    let t = 1000
    const { svc, bubbles, native } = makeService({}, { now: () => new Date(t) })
    await svc.refreshPrefs()
    svc.notify({ message: '重复', category: 'routine', routineId: 'r' })
    expect(bubbles).toHaveLength(1)
    expect(native).toHaveLength(1)
    t += 5_000 // 5s later — within the 30s window
    svc.notify({ message: '重复', category: 'routine', routineId: 'r' })
    expect(bubbles).toHaveLength(1) // collapsed
    expect(native).toHaveLength(1)
    t += 30_000 // past the window
    svc.notify({ message: '重复', category: 'routine', routineId: 'r' })
    expect(bubbles).toHaveLength(2)
    expect(native).toHaveLength(2)
  })

  it('a different message in the same category is not collapsed', async () => {
    let t = 1000
    const { svc, bubbles } = makeService({}, { now: () => new Date(t) })
    await svc.refreshPrefs()
    svc.notify({ message: 'A', category: 'routine', routineId: 'r' })
    t += 1_000
    svc.notify({ message: 'B', category: 'routine', routineId: 'r' })
    expect(bubbles).toHaveLength(2)
  })

  it('forwards navigateTo to the robot bubble', async () => {
    const { svc, bubbles } = makeService({})
    await svc.refreshPrefs()
    svc.notify({ message: '待审批', category: 'approval', navigateTo: 'Approvals' })
    expect(bubbles[0].navigateTo).toBe('Approvals')
  })

  it('a prefs refresh picks up the new prefs live', async () => {
    let live: NotificationPrefs = {}
    const native: { title: string; body: string }[] = []
    const svc = new NotificationService({
      readPrefs: async () => live,
      pushBubble: () => {},
      notifier: (title, body) => native.push({ title, body })
    })
    await svc.refreshPrefs()
    svc.notify({ message: 'x', category: 'info' })
    expect(native).toHaveLength(1)
    live = { nativeEnabled: false }
    await svc.refreshPrefs()
    svc.notify({ message: 'y', category: 'info' })
    expect(native).toHaveLength(1) // second notify suppressed native
  })

  it('fortune category surfaces by default + respects its own toggle (Milestone E)', async () => {
    const { svc, bubbles, native } = makeService({})
    await svc.refreshPrefs()
    const ok = svc.notify({ message: '今日运势 · 属龙｜势头向好', category: 'fortune' })
    expect(ok).toBe(true)
    expect(bubbles).toHaveLength(1)
    expect(native).toHaveLength(1)

    // Muting the fortune category fully suppresses both surfaces.
    const { svc: off, bubbles: offB, native: offN } = makeService({
      categories: { fortune: false }
    })
    await off.refreshPrefs()
    const ok2 = off.notify({ message: 'x', category: 'fortune' })
    expect(ok2).toBe(false)
    expect(offB).toHaveLength(0)
    expect(offN).toHaveLength(0)
  })
})
