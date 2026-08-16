export type CalendarOperation =
  | "create"
  | "delete"
  | "list"
  | "manage_attendees"
  | "set_reminder"
  | "update";

export type CalendarSendUpdates = "all" | "none";
export type RecurrenceScope = "all_future" | "series" | "this_instance";

export interface CalendarReference {
  readonly id: string;
  readonly isPrimary: boolean;
  readonly readOnly: boolean;
  readonly summary: string;
  readonly timeZone: string;
}

export interface TimedEventDateTime {
  readonly dateTime: string;
  readonly kind: "timed";
  readonly timeZone: string;
}

export interface AllDayEventDateTime {
  readonly date: string;
  readonly kind: "all_day";
  readonly timeZone: string;
}

export type CalendarEventDateTime = AllDayEventDateTime | TimedEventDateTime;

export interface CalendarEventAttendee {
  readonly email: string;
  readonly optional?: boolean;
  readonly responseStatus?: "accepted" | "declined" | "needsAction" | "tentative";
  readonly self?: boolean;
}

export interface CalendarEvent {
  readonly attendees: readonly CalendarEventAttendee[];
  readonly calendarId: string;
  readonly description?: string;
  readonly end: CalendarEventDateTime;
  readonly etag: string;
  readonly id: string;
  readonly originalStart?: CalendarEventDateTime;
  readonly recurrence?: readonly string[];
  readonly recurringEventId?: string;
  readonly start: CalendarEventDateTime;
  readonly status: "cancelled" | "confirmed" | "tentative";
  readonly summary: string;
}

export interface CalendarEventPatch {
  readonly attendees?: readonly CalendarEventAttendee[];
  readonly description?: string;
  readonly end?: CalendarEventDateTime;
  readonly recurrence?: readonly string[];
  readonly start?: CalendarEventDateTime;
  readonly summary?: string;
}

export interface EventSelector {
  readonly calendarId?: string;
  readonly calendarName?: string;
  readonly date?: string;
  readonly summary?: string;
  readonly time?: string;
}

export interface CalendarActionPlan {
  readonly confidence: number;
  readonly operation: CalendarOperation;
  readonly recurrenceScope?: RecurrenceScope;
  readonly selector?: EventSelector;
}

export function hasExternalGuests(event: CalendarEvent): boolean {
  return event.attendees.some((attendee) => !attendee.self);
}

export function isRecurringEvent(event: CalendarEvent): boolean {
  return Boolean(event.recurringEventId || event.recurrence?.length);
}
