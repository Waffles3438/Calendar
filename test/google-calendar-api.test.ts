import { describe, expect, it } from "vitest";

import {
  buildIfMatchOptions,
  GoogleCalendarConnectionError,
  normalizeGoogleCalendarEvent,
  normalizeGoogleCalendarReference,
} from "../src/google/calendar-api.js";

describe("Google Calendar API normalization", () => {
  it("maps Google calendar metadata into the bot domain model", () => {
    expect(
      normalizeGoogleCalendarReference({
        accessRole: "writer",
        id: "calendar-id",
        primary: true,
        summary: "Personal",
        timeZone: "America/Chicago",
      }),
    ).toEqual({
      id: "calendar-id",
      isPrimary: true,
      readOnly: false,
      summary: "Personal",
      timeZone: "America/Chicago",
    });
  });

  it("returns undefined when Google omits a usable calendar ID", () => {
    expect(normalizeGoogleCalendarReference({ summary: "No ID" })).toBeUndefined();
  });

  it("normalizes optional attendee and original-start fields without undefined properties", () => {
    expect(
      normalizeGoogleCalendarEvent(
        {
          attendees: [
            { email: "owner@example.com", self: true },
            { email: "guest@example.com", responseStatus: "accepted" },
          ],
          end: { dateTime: "2025-01-10T16:00:00.000-05:00", timeZone: "America/New_York" },
          etag: "etag-1",
          id: "event-1",
          start: { dateTime: "2025-01-10T15:00:00.000-05:00", timeZone: "America/New_York" },
          summary: "Review",
        },
        "primary",
      ),
    ).toEqual({
      attendees: [
        { email: "owner@example.com", self: true },
        { email: "guest@example.com", responseStatus: "accepted" },
      ],
      calendarId: "primary",
      end: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone: "America/New_York" },
      etag: "etag-1",
      id: "event-1",
      start: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone: "America/New_York" },
      status: "confirmed",
      summary: "Review",
    });
  });

  it("requires a nonempty ETag and consistently creates If-Match request headers", () => {
    expect(buildIfMatchOptions('"version-1"')).toEqual({ headers: { "If-Match": '"version-1"' } });
    expect(() => buildIfMatchOptions(" ")).toThrow(GoogleCalendarConnectionError);
  });
});
