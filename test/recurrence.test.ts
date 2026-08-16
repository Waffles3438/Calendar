import { describe, expect, it } from "vitest";

import { RecurrenceSplitError, splitRecurrenceAt } from "../src/calendar/recurrence.js";
import type { CalendarEvent } from "../src/domain/calendar.js";

const timeZone = "America/New_York";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2025-01-03T16:00:00.000-05:00", kind: "timed", timeZone },
    etag: "etag",
    id: "series-1",
    recurrence: ["RRULE:FREQ=WEEKLY"],
    start: { dateTime: "2025-01-03T15:00:00.000-05:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Team meeting",
    ...overrides,
  };
}

describe("splitRecurrenceAt", () => {
  it("cuts a simple series immediately before the selected occurrence and preserves the future rule", () => {
    const master = event();
    const occurrence = event({
      end: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
      id: "occurrence-1",
      originalStart: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
      recurringEventId: "series-1",
      start: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
    });

    expect(splitRecurrenceAt(master, occurrence, timeZone)).toEqual({
      futureRecurrence: ["RRULE:FREQ=WEEKLY"],
      precedingRecurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20250110T195959Z"],
    });
  });

  it("fails closed for counted recurrence rules that cannot be safely split", () => {
    const master = event({ recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"] });
    const occurrence = event({
      id: "occurrence-1",
      originalStart: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
      recurringEventId: "series-1",
      start: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
    });

    expect(() => splitRecurrenceAt(master, occurrence, timeZone)).toThrow(RecurrenceSplitError);
  });
});
