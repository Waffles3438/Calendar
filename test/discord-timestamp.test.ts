import { describe, expect, it } from "vitest";

import { formatEventStart } from "../src/calendar/event-time.js";
import type { CalendarEvent } from "../src/domain/calendar.js";
import { formatDiscordDate, formatDiscordTimestamp } from "../src/discord/discord-timestamp.js";

const timeZone = "America/Toronto";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2026-08-18T10:00:00.000-04:00", kind: "timed", timeZone },
    etag: "etag-1",
    id: "event-1",
    start: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Focus time",
    ...overrides,
  };
}

describe("Discord timestamp formatting", () => {
  it("formats timed instants with Discord's full timestamp style", () => {
    const instant = new Date("2026-08-18T13:00:00.000Z");

    expect(formatDiscordTimestamp(instant)).toBe("<t:1787058000:F>");
    expect(formatEventStart(event(), timeZone)).toBe("<t:1787058000:F>");
  });

  it("formats all-day values as Discord dates without inventing a midnight time", () => {
    const allDay = event({
      end: { date: "2026-08-19", kind: "all_day", timeZone },
      start: { date: "2026-08-18", kind: "all_day", timeZone },
    });

    expect(formatDiscordDate("2026-08-18", timeZone)).toBe("<t:1787068800:D>");
    expect(formatEventStart(allDay, timeZone)).toBe("<t:1787068800:D> (all day)");
  });
});
