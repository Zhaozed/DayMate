// Mock Calendar Provider — canned Feishu-style events so the Routine Engine
// and Tool Registry run end-to-end without real Feishu (Spec rule 9).

import type {
  IntegrationAccount,
  IntegrationStatus,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  DateRange
} from '@shared/types'
import type { CalendarProvider } from './calendar-provider'
import { newId, nowIso } from '../../util/ids'

const ACCOUNT_ID = 'mock-feishu-001'

const today = (h: number): string => {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.toISOString()
}

const FIXTURES: CalendarEvent[] = [
  {
    provider: 'feishu',
    accountId: ACCOUNT_ID,
    eventId: 'mock-evt-001',
    title: 'Q3 roadmap review',
    start: today(10),
    end: today(11),
    location: 'Meeting Room A',
    attendees: [
      { name: 'Alice Chen', address: 'alice@example.com' },
      { name: 'Bob Liu', address: 'bob@example.com' }
    ],
    description: 'Decision on agent-runtime scope.',
    sourceUrl: 'https://feishu.example.com/calendar/mock-evt-001'
  },
  {
    provider: 'feishu',
    accountId: ACCOUNT_ID,
    eventId: 'mock-evt-002',
    title: '1:1 with manager',
    start: today(15),
    end: today(15),
    location: '',
    attendees: [{ name: 'Manager', address: 'manager@example.com' }],
    description: 'Weekly sync.',
    sourceUrl: 'https://feishu.example.com/calendar/mock-evt-002'
  }
]

export class MockCalendarProvider implements CalendarProvider {
  readonly provider = 'feishu' as const
  readonly accountId = ACCOUNT_ID
  private status: IntegrationStatus = 'connected'
  /** ADR 0028 — when a real EMAIL provider is connected (the user is real,
   *  not a fresh dev install), the mock calendar must NOT feed its canned
   *  "Q3 roadmap review" / "1:1 with manager" fixtures into the morning_brief
   *  routine — that generated fake morning-brief NTKs + a routine-extracted
   *  ToDo ("Decide: Approval Center in P0 or defer for Q3 roadmap") the user
   *  never asked about. In real mode listEvents returns [] so the calendar
   *  step is honest (no calendar connected) rather than fake. */
  private realMode = false

  setRealMode(on: boolean): void {
    this.realMode = on
  }

  async connect(): Promise<IntegrationAccount> {
    this.status = 'connected'
    return {
      id: ACCOUNT_ID,
      provider: 'feishu',
      displayName: 'Mock Feishu Calendar',
      status: 'connected',
      scopes: ['calendar:read', 'calendar:write'],
      lastSyncAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected'
  }

  async getStatus(): Promise<IntegrationStatus> {
    return this.status
  }

  async listEvents(range: DateRange): Promise<CalendarEvent[]> {
    // Real mode: no canned fixtures (see setRealMode). A real user with no
    // connected Feishu gets an empty calendar, not fake Q3-roadmap events.
    if (this.realMode) return []
    const startMs = new Date(range.start).getTime()
    const endMs = new Date(range.end).getTime()
    return FIXTURES.filter((e) => {
      const es = new Date(e.start).getTime()
      return es >= startMs && es <= endMs
    })
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const evt = FIXTURES.find((e) => e.eventId === eventId)
    if (!evt) throw new Error(`未找到事件：${eventId}`)
    return evt
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    // P1 capability; must require approval before reaching here (Spec §10).
    const evt: CalendarEvent = {
      provider: 'feishu',
      accountId: ACCOUNT_ID,
      eventId: newId('evt'),
      title: input.title,
      start: input.start,
      end: input.end,
      location: input.location ?? '',
      attendees: input.attendees ?? [],
      description: input.description ?? '',
      sourceUrl: `https://feishu.example.com/calendar/${newId('evt')}`
    }
    return evt
  }

  async updateEvent(eventId: string, input: CalendarEventPatch): Promise<CalendarEvent> {
    const existing = await this.getEvent(eventId)
    return { ...existing, ...input }
  }
}
