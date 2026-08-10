// Swappable calendar delegate (Spec §10). The engine + scheduler hold ONE
// `calendarProvider` reference for the app's lifetime. By default it points at
// the mock (credential-free path); when the user Connects real Feishu, the
// delegate's `current` swaps to the real FeishuCalendarProvider, and back to
// the mock on disconnect. Same mutable-reference pattern as `emailProviders`.
//
// The delegate's own `provider`/`accountId` are nominal; the active provider's
// values surface through `listEvents`/`getEvent` results (which carry their own
// `accountId`).

import type {
  IntegrationAccount,
  IntegrationStatus,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  DateRange
} from '@shared/types'
import type { CalendarProvider } from './calendar-provider'

export class SwappableCalendarProvider implements CalendarProvider {
  readonly provider = 'feishu' as const
  readonly accountId = 'feishu-real'
  private current: CalendarProvider

  constructor(private readonly fallback: CalendarProvider) {
    this.current = fallback
  }

  /** Swap to `real` when `on`, back to the fallback when off. */
  swap(real: CalendarProvider, on: boolean): void {
    this.current = on ? real : this.fallback
  }

  get active(): CalendarProvider {
    return this.current
  }

  async connect(): Promise<IntegrationAccount> {
    return this.current.connect()
  }
  async disconnect(): Promise<void> {
    return this.current.disconnect()
  }
  async getStatus(): Promise<IntegrationStatus> {
    return this.current.getStatus()
  }
  async listEvents(range: DateRange): Promise<CalendarEvent[]> {
    return this.current.listEvents(range)
  }
  async getEvent(eventId: string): Promise<CalendarEvent> {
    return this.current.getEvent(eventId)
  }
  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    return this.current.createEvent(input)
  }
  async updateEvent(eventId: string, input: CalendarEventPatch): Promise<CalendarEvent> {
    return this.current.updateEvent(eventId, input)
  }
}
