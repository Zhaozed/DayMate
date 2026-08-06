// Calendar Provider abstraction (Spec §10). P0 only requires reading events;
// create/update is P1 and must require approval. Feishu implementation lands in
// M3. Mock implementation in mock-calendar-provider.ts.

import type {
  IntegrationAccount,
  IntegrationStatus,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  DateRange
} from '@shared/types'

export interface CalendarProvider {
  readonly provider: 'feishu'
  readonly accountId: string

  connect(): Promise<IntegrationAccount>
  disconnect(): Promise<void>
  getStatus(): Promise<IntegrationStatus>

  listEvents(range: DateRange): Promise<CalendarEvent[]>
  getEvent(eventId: string): Promise<CalendarEvent>
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>
  updateEvent(eventId: string, input: CalendarEventPatch): Promise<CalendarEvent>
}
