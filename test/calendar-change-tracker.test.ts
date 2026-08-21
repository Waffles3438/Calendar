import { describe, expect, it, vi } from "vitest";

import type {
  CalendarEvent,
  CalendarReference,
  TimedEventDateTime,
} from "../src/domain/calendar.js";
import {
  CalendarChangeTracker,
  TrackedCalendarGateway,
} from "../src/google/calendar-change-tracker.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  ListCalendarEventsInput,
} from "../src/google/calendar-api.js";

const calendar: CalendarReference = {
  id: "primary",
  isPrimary: true,
  readOnly: false,
  summary: "Personal",
  timeZone: "America/Toronto",
};
const query: ListCalendarEventsInput = {
  calendarId: calendar.id,
  timeMax: "2026-08-22T04:00:00.000Z",
  timeMin: "2026-08-21T04:00:00.000Z",
};

function timed(dateTime: string): TimedEventDateTime {
  return { dateTime, kind: "timed", timeZone: calendar.timeZone };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: calendar.id,
    end: timed("2026-08-21T16:00:00.000-04:00"),
    etag: "etag-1",
    id: "event-1",
    start: timed("2026-08-21T15:00:00.000-04:00"),
    status: "confirmed",
    summary: "Lunch",
    ...overrides,
  };
}

function gatewayState(): {
  delegate: CalendarGateway;
  setEvents: (next: readonly CalendarEvent[]) => void;
} {
  let events: readonly CalendarEvent[] = [event()];
  const base = event();
  const delegate = {
    createEvent: vi.fn(async (_input: CreateCalendarEventInput) => base),
    deleteEvent: vi.fn(async (_input: DeleteCalendarEventInput) => undefined),
    getEvent: vi.fn(async () => events[0] ?? base),
    listCalendars: vi.fn(async () => [calendar]),
    listEvents: vi.fn(async () => events),
    splitRecurringEvent: vi.fn(async () => base),
    truncateRecurringEvent: vi.fn(async () => undefined),
    updateEvent: vi.fn(async () => base),
  } satisfies CalendarGateway;
  return {
    delegate,
    setEvents: (next) => {
      events = next;
    },
  };
}

describe("CalendarChangeTracker", () => {
  it("does not invalidate for identical Calendar reads", async () => {
    const state = gatewayState();
    const tracker = new CalendarChangeTracker();
    const gateway = new TrackedCalendarGateway(state.delegate, tracker);

    await gateway.listCalendars();
    await gateway.listCalendars();
    await gateway.listEvents(query);
    await gateway.listEvents(query);

    expect(tracker.getGeneration()).toBe(0);
  });

  it("detects changed event ETags and collection membership", async () => {
    const state = gatewayState();
    const tracker = new CalendarChangeTracker();
    const gateway = new TrackedCalendarGateway(state.delegate, tracker);

    await gateway.listEvents(query);
    state.setEvents([event({ etag: "etag-2" })]);
    await gateway.listEvents(query);
    expect(tracker.getGeneration()).toBe(1);

    state.setEvents([event({ id: "event-2", etag: "etag-3" })]);
    await gateway.listEvents(query);
    expect(tracker.getGeneration()).toBe(2);
  });

  it("detects Calendar metadata and individual event changes", async () => {
    const state = gatewayState();
    const tracker = new CalendarChangeTracker();
    const gateway = new TrackedCalendarGateway(state.delegate, tracker);

    await gateway.listCalendars();
    state.delegate.listCalendars = vi.fn(async () => [{ ...calendar, summary: "Work" }]);
    await gateway.listCalendars();
    expect(tracker.getGeneration()).toBe(1);

    state.setEvents([event({ etag: "etag-1" })]);
    await gateway.getEvent({ calendarId: calendar.id, eventId: "event-1" });
    state.setEvents([event({ etag: "etag-2" })]);
    await gateway.getEvent({ calendarId: calendar.id, eventId: "event-1" });
    expect(tracker.getGeneration()).toBe(2);
  });

  it("notifies subscribers and unsubscribes safely", () => {
    const tracker = new CalendarChangeTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    tracker.markChanged();
    expect(tracker.getGeneration()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    tracker.markChanged();
    expect(tracker.getGeneration()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("invalidates after successful mutations but not failed mutations", async () => {
    const state = gatewayState();
    const tracker = new CalendarChangeTracker();
    const gateway = new TrackedCalendarGateway(state.delegate, tracker);
    const createInput: CreateCalendarEventInput = {
      calendarId: calendar.id,
      end: timed("2026-08-21T16:00:00.000-04:00"),
      start: timed("2026-08-21T15:00:00.000-04:00"),
      summary: "Lunch",
    };

    await gateway.createEvent(createInput);
    expect(tracker.getGeneration()).toBe(1);

    state.delegate.deleteEvent = vi.fn(async () => {
      throw new Error("write failed");
    });
    await expect(gateway.deleteEvent({
      calendarId: calendar.id,
      etag: "etag-1",
      eventId: "event-1",
      sendUpdates: "none",
    })).rejects.toThrow("write failed");
    expect(tracker.getGeneration()).toBe(1);
  });
});
