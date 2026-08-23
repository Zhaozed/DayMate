// One-time purge of legacy email-origin ToDos + mock/demo application rows
// (ADR 0027 — ToDo 重构). The pre-overhaul stub built unreadable ToDo titles
// from the raw email subject (`跟进：<subject>`), and mock-provider fixtures +
// `seedDemoData` demo rows polluted the funnel. Purging ALL email-origin tasks
// once (gated by `settings.todo.purgeDone`) lets the 60-day cold-start backfill
// regenerate readable ToDos from the same `sourceId` (idempotent create). Manual
// ToDos (`sourceType='assistant'`/`'routine'`) are never touched.
//
// Mirror pattern: `ApplicationService.seedDemoData`'s wipe loop at
// application-service.ts:243 + the one-time `deleteByTitle` cleanup at
// container.ts:417-418.

import type { TaskService } from './task-service'
import type { ApplicationService } from './application-service'
import type { NeedToKnowService } from './need-to-know-service'
import type { NeedToKnow } from '@shared/types'

/** Purge all email-origin ToDos + email-inferred 投递 + email-origin 必读 NTKs
 *  (ADR 0027 — ToDo/必读/投递 rebuild). The pre-overhaul paths produced junk:
 *  unreadable ToDo titles from raw subjects, fake 投递 rows from low-confidence
 *  recruiting-outreach mail the user never applied to, and 必读 items for
 *  LinkedIn ads / [student_ips] school spam / Railway auto-notifications that
 *  the (now-fixed) surface logic let through. Purging ALL email-origin items
 *  once (gated by `settings.todo.purgeVersion < PURGE_VERSION`) lets the
 *  cold-start re-backfill + incremental sync regenerate a clean set with the
 *  fixed filters. Manual ToDos (`assistant`/`routine`), manual/boss 投递,
 *  and morning-brief NTKs are never touched.
 *
 *  Mirror pattern: `ApplicationService.seedDemoData`'s wipe loop +
 *  the one-time `deleteByTitle` cleanup at container.ts. */
export function purgeEmailOriginTasks(
  taskService: TaskService,
  applicationService: ApplicationService,
  needToKnowService?: NeedToKnowService
): { tasks: number; applications: number; ntk: number } {
  // 1. Drop every email-origin ToDo (mock + unreadable-stub + real) AND any
  //    routine-extracted ToDo whose sourceId is a mock fixture (the
  //    morning_brief routine ran on mock emails/calendar before real providers
  //    connected, producing e.g. "Decide: Approval Center in P0 or defer for
  //    Q3 roadmap" from mock-msg-001). Manual ToDos (assistant/routine with a
  //    real sourceId) are left alone. The cold-start backfill + incremental
  //    sync rebuild the readable set idempotently.
  let tasks = 0
  for (const t of taskService.list()) {
    const mockSourced = t.sourceType === 'routine' && (t.sourceId ?? '').startsWith('mock-')
    if (t.sourceType === 'email' || mockSourced) {
      taskService.delete(t.id)
      tasks++
    }
  }

  // 2. Drop EVERY email-inferred application row across active + deleted +
  //    archived (source='email' — covers mock fixtures, seedDemoData demo
  //    rows, AND the fake low-confidence recruiting-outlook 投递 the old
  //    "create even at low confidence" built). Manual (`source='manual'`) +
  //    boss (`source='boss'`) apps are kept. The funnel is incremental
  //    (cursor-gated) so purged rows are NOT re-created; new real progress
  //    events arrive via the now-strict (high/medium only) funnel.
  const lists = [
    applicationService.list(),
    applicationService.listDeleted(),
    applicationService.listArchived()
  ]
  const seen = new Set<string>()
  let applications = 0
  for (const view of lists.flat()) {
    const app = view.application
    if (!app || seen.has(app.id)) continue
    if (app.source === 'email') {
      seen.add(app.id)
      applicationService.purgeApplication(app.id)
      applications++
    }
  }

  // 3. Drop every email-origin 必读 NTK (sourceRefs include type='email')
  //    AND any mock-sourced morning_brief NTK. Stale LinkedIn-ad /
  //    [student_ips] / Railway-auto-notification items from the buggy surface
  //    logic live here; clearing them + resetting coldStartDone lets the
  //    re-backfill rebuild a clean 必读 with the fixed filters (ignore verdict
  //    respected, bulk + school-spam pre-filtered). morning_brief NTKs are
  //    normally left for the Home 晨报 carousel, BUT ones generated from mock
  //    calendar/email fixtures (before real providers connected) — e.g. the
  //    "Q3 roadmap review" mock-calendar event producing a fake brief + the
  //    "Decide: Approval Center" ToDo — are junk a real user never asked for
  //    (ADR 0028). The mock calendar now returns [] in real mode so they
  //    won't regenerate; this one-time clear removes the stragglers.
  let ntk = 0
  if (needToKnowService) {
    for (const n of needToKnowService.list()) {
      if (n.sourceRefs.some((s) => s.type === 'email')) {
        needToKnowService.deleteById(n.id)
        ntk++
      }
    }
    // Mock-sourced NTKs (incl. DISMISSED ones — `list()` excludes dismissed,
    // and morning_brief ones are only reachable via listMorningBriefs; scan the
    // full table instead so a user-dismissed "Q3 roadmap" mock-calendar brief
    // a user dismissed before real providers connected is also cleared).
    // Fixture markers: the mock calendar "Q3 roadmap review" event, the mock
    // "Q3 roadmap" email thread, or any mock id in a sourceRef.
    for (const n of needToKnowService.listAll()) {
      if (isMockNtk(n)) {
        needToKnowService.deleteById(n.id)
        ntk++
      }
    }
  }

  return { tasks, applications, ntk }
}

/** An NTK is mock-sourced if its title/summary or any sourceRef references a
 *  known mock fixture (the "Q3 roadmap review" mock-calendar event, the mock
 *  "Q3 roadmap" email thread, or any mock id). One-time purge predicate. */
function isMockNtk(n: NeedToKnow): boolean {
  const text = `${n.title ?? ''} ${n.summary ?? ''}`
  const mockMarkers = ['Q3 roadmap', 'Q3路线图', 'Approval Center', '审批中心', 'roadmap review']
  if (mockMarkers.some((m) => text.includes(m))) return true
  return n.sourceRefs.some((s) => {
    const id = s.id ?? ''
    const label = s.label ?? ''
    return id.startsWith('mock') || label.includes('Q3 roadmap') || label.includes('Approval Center')
  })
}
