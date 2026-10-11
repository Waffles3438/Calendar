import { describe, expect, it, vi } from "vitest";
import type { calendar_v3 } from "googleapis";

import {
  buildIfMatchOptions,
  collectGooglePages,
  GoogleCalendarApi,
  GoogleCalendarConnectionError,
  normalizeGoogleCalendarEvent,
  normalizeGoogleCalendarReference,
  normalizeGoogleManagedCalendar,
  normalizeGoogleMigrationEvent,
} from "../src/google/calendar-api.js";

interface FakeCalendarClient {
  calendarList: {
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
  calendars: {
    delete: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
  events: {
    list: ReturnType<typeof vi.fn>;
    move: ReturnType<typeof vi.fn>;
  };
}

function fakeCalendarClient(): FakeCalendarClient {
  return {
    calendarList: {
      get: vi.fn(),
      list: vi.fn(),
      patch: vi.fn(),
    },
    calendars: {
      delete: vi.fn(),
      get: vi.fn(),
      insert: vi.fn(),
      patch: vi.fn(),
    },
    events: {
      list: vi.fn(),
      move: vi.fn(),
    },
  };
}

function api(client: FakeCalendarClient): GoogleCalendarApi {
  return new GoogleCalendarApi({
    calendarClientFactory: () => client as unknown as calendar_v3.Calendar,
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://example.test/oauth/callback",
    stateRepository: {
      getGoogleOAuth: () => ({ accessToken: "access-token", refreshToken: "refresh-token" }),
      saveGoogleOAuth: vi.fn(),
    },
  });
}

describe("Google Calendar API normalization", () => {
  it("persists refreshed access tokens while preserving omitted refresh and expiry values", async () => {
    const client = fakeCalendarClient();
    client.calendarList.list.mockResolvedValue({ data: { items: [] } });
    const saveGoogleOAuth = vi.fn();
    let emitTokens: ((tokens: unknown) => void) | undefined;
    const calendarApi = new GoogleCalendarApi({
      calendarClientFactory: (auth) => {
        emitTokens = (tokens) => {
          (auth as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit("tokens", tokens);
        };
        return client as unknown as calendar_v3.Calendar;
      },
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.test/oauth/callback",
      stateRepository: {
        getGoogleOAuth: () => ({
          accessToken: "old-access-token",
          expiresAt: "2026-08-15T13:00:00.000Z",
          refreshToken: "old-refresh-token",
          scope: "old-scope",
        }),
        saveGoogleOAuth,
      },
    });

    await calendarApi.listCalendars();
    emitTokens?.({ access_token: "new-access-token", refresh_token: null, expiry_date: null });

    expect(saveGoogleOAuth).toHaveBeenCalledWith({
      accessToken: "new-access-token",
      expiresAt: "2026-08-15T13:00:00.000Z",
      refreshToken: "old-refresh-token",
      scope: "old-scope",
    });
  });

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

  it("maps rich list and resource metadata, including hidden and selected settings", () => {
    expect(
      normalizeGoogleManagedCalendar(
        {
          accessRole: "owner",
          backgroundColor: "#4EA7D7",
          description: "List description",
          etag: "list-etag",
          foregroundColor: "#FFFFFF",
          hidden: true,
          id: "calendar-id",
          primary: false,
          selected: false,
          summary: "Original name",
          summaryOverride: "Sidebar name",
          timeZone: "America/Chicago",
        },
        {
          dataOwner: "owner@example.com",
          description: "Resource description",
          etag: "resource-etag",
          id: "calendar-id",
          summary: "Resource name",
          timeZone: "UTC",
        },
      ),
    ).toEqual({
      accessRole: "owner",
      backgroundColor: "#4EA7D7",
      canDelete: true,
      canManageEvents: true,
      canManageMetadata: true,
      dataOwner: "owner@example.com",
      description: "List description",
      foregroundColor: "#FFFFFF",
      hidden: true,
      id: "calendar-id",
      isPrimary: false,
      readOnly: false,
      resourceEtag: "resource-etag",
      selected: false,
      summary: "Sidebar name",
      summaryOverride: "Sidebar name",
      timeZone: "America/Chicago",
    });
  });

  it("fails closed for unknown access roles and never grants deletion capability", () => {
    expect(
      normalizeGoogleManagedCalendar({
        accessRole: "futureGoogleRole",
        id: "shared-calendar",
        primary: false,
        summary: "Shared",
      }),
    ).toMatchObject({
      accessRole: "unknown",
      canDelete: false,
      canManageEvents: false,
      canManageMetadata: false,
      readOnly: true,
    });
  });

  it("normalizes migration metadata, recurrence, guests, and events without times", () => {
    expect(
      normalizeGoogleMigrationEvent(
        {
          attendees: [
            { email: "owner@example.com", self: true },
            { email: "guest@example.com", responseStatus: "accepted" },
          ],
          end: { dateTime: "2026-08-24T16:00:00.000-04:00", timeZone: "America/New_York" },
          eventType: "default",
          etag: "etag-1",
          id: "event-1",
          locked: true,
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
          recurringEventId: "series-1",
          start: { dateTime: "2026-08-24T15:00:00.000-04:00", timeZone: "America/New_York" },
          status: "confirmed",
          summary: "Review",
        },
        "source-calendar",
      ),
    ).toEqual({
      calendarId: "source-calendar",
      end: { dateTime: "2026-08-24T16:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
      eventType: "default",
      etag: "etag-1",
      hasExternalGuests: true,
      id: "event-1",
      locked: true,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
      recurringEventId: "series-1",
      start: { dateTime: "2026-08-24T15:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
      status: "confirmed",
      summary: "Review",
    });

    expect(
      normalizeGoogleMigrationEvent({ id: "event-without-times", summary: "Special event" }, "source-calendar"),
    ).toEqual({
      calendarId: "source-calendar",
      etag: "",
      hasExternalGuests: false,
      id: "event-without-times",
      locked: false,
      status: "confirmed",
      summary: "Special event",
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

describe("GoogleCalendarApi calendar management operations", () => {
  it("reads all calendar-list pages, includes hidden calendars, and normalizes resources", async () => {
    const client = fakeCalendarClient();
    client.calendarList.list
      .mockResolvedValueOnce({
        data: {
          items: [{
            accessRole: "owner",
            backgroundColor: "#4EA7D7",
            hidden: false,
            id: "primary",
            primary: true,
            selected: true,
            summary: "Benny Wang",
            timeZone: "America/Toronto",
          }],
          nextPageToken: "calendar-page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{
            accessRole: "reader",
            hidden: true,
            id: "birthdays",
            selected: false,
            summary: "Birthdays",
          }],
        },
      });
    client.calendars.get.mockImplementation(async ({ calendarId }: { calendarId: string }) => ({
      data: calendarId === "primary"
        ? { description: "Personal", etag: "primary-etag", id: "primary", timeZone: "America/Toronto" }
        : { description: "Shared birthdays", etag: "birthdays-etag", id: "birthdays", timeZone: "UTC" },
    }));

    const calendars = await api(client).listManagedCalendars();

    expect(calendars).toHaveLength(2);
    expect(calendars[1]).toMatchObject({
      accessRole: "reader",
      canDelete: false,
      canManageEvents: false,
      description: "Shared birthdays",
      hidden: true,
      id: "birthdays",
      readOnly: true,
      selected: false,
      summary: "Birthdays",
      resourceEtag: "birthdays-etag",
    });
    expect(client.calendarList.list).toHaveBeenNthCalledWith(1, {
      showDeleted: false,
      showHidden: true,
    });
    expect(client.calendarList.list).toHaveBeenNthCalledWith(2, {
      pageToken: "calendar-page-2",
      showDeleted: false,
      showHidden: true,
    });
    expect(client.calendars.get).toHaveBeenCalledTimes(2);
  });

  it("reads every migration-event page with recurring events preserved", async () => {
    const client = fakeCalendarClient();
    client.events.list
      .mockResolvedValueOnce({
        data: {
          items: [{
            end: { date: "2026-08-25", timeZone: "America/Toronto" },
            eventType: "default",
            id: "event-1",
            recurrence: ["RRULE:FREQ=DAILY"],
            start: { date: "2026-08-24", timeZone: "America/Toronto" },
            summary: "Daily review",
          }],
          nextPageToken: "event-page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "event-2", locked: true, summary: "Locked" }],
        },
      });

    const events = await api(client).listMigrationEvents({ calendarId: "source-calendar" });

    expect(events).toEqual([
      {
        calendarId: "source-calendar",
        end: { date: "2026-08-25", kind: "all_day", timeZone: "America/Toronto" },
        eventType: "default",
        etag: "",
        hasExternalGuests: false,
        id: "event-1",
        locked: false,
        recurrence: ["RRULE:FREQ=DAILY"],
        start: { date: "2026-08-24", kind: "all_day", timeZone: "America/Toronto" },
        status: "confirmed",
        summary: "Daily review",
      },
      {
        calendarId: "source-calendar",
        etag: "",
        hasExternalGuests: false,
        id: "event-2",
        locked: true,
        status: "confirmed",
        summary: "Locked",
      },
    ]);
    expect(client.events.list).toHaveBeenNthCalledWith(1, {
      calendarId: "source-calendar",
      maxResults: 2_500,
      showDeleted: false,
      singleEvents: false,
    });
    expect(client.events.list).toHaveBeenNthCalledWith(2, {
      calendarId: "source-calendar",
      maxResults: 2_500,
      pageToken: "event-page-2",
      showDeleted: false,
      singleEvents: false,
    });
  });

  it("creates, updates, deletes, and moves calendars through the expected Google requests", async () => {
    const client = fakeCalendarClient();
    client.calendars.insert.mockResolvedValue({ data: { id: "new-calendar" } });
    client.calendarList.patch.mockResolvedValue({ data: {} });
    client.calendarList.get.mockResolvedValue({
      data: {
        accessRole: "owner",
        backgroundColor: "#E99C37",
        foregroundColor: "#000000",
        id: "new-calendar",
        selected: true,
        summary: "Renamed calendar",
        timeZone: "America/Toronto",
      },
    });
    client.calendars.get.mockResolvedValue({
      data: {
        description: "Updated description",
        etag: "resource-etag",
        id: "new-calendar",
        summary: "Renamed calendar",
        timeZone: "America/Toronto",
      },
    });

    const calendarApi = api(client);
    await calendarApi.createManagedCalendar({
      backgroundColor: "#E99C37",
      description: "New description",
      foregroundColor: "#000000",
      name: "New calendar",
      timeZone: "America/Toronto",
    });

    expect(client.calendars.insert).toHaveBeenCalledWith({
      requestBody: {
        description: "New description",
        summary: "New calendar",
        timeZone: "America/Toronto",
      },
    });
    expect(client.calendarList.patch).toHaveBeenNthCalledWith(1, {
      calendarId: "new-calendar",
      colorRgbFormat: true,
      requestBody: {
        backgroundColor: "#E99C37",
        foregroundColor: "#000000",
        hidden: false,
        selected: true,
      },
    });

    await calendarApi.updateManagedCalendar({
      calendarId: "new-calendar",
      listSettings: {
        backgroundColor: "#4EA7D7",
        foregroundColor: "#FFFFFF",
        hidden: true,
        selected: false,
      },
      metadata: {
        description: "Updated description",
        name: "Renamed calendar",
      },
    });

    expect(client.calendars.patch).toHaveBeenCalledWith({
      calendarId: "new-calendar",
      requestBody: {
        description: "Updated description",
        summary: "Renamed calendar",
      },
    });
    expect(client.calendarList.patch).toHaveBeenNthCalledWith(2, {
      calendarId: "new-calendar",
      colorRgbFormat: true,
      requestBody: {
        backgroundColor: "#4EA7D7",
        foregroundColor: "#FFFFFF",
        hidden: true,
        selected: false,
      },
    });

    await calendarApi.deleteManagedCalendar("new-calendar");
    expect(client.calendars.delete).toHaveBeenCalledWith({ calendarId: "new-calendar" });

    client.events.move.mockResolvedValue({
      data: {
        end: { dateTime: "2026-08-24T11:00:00.000Z" },
        eventType: "default",
        etag: "moved-etag",
        id: "event-1",
        start: { dateTime: "2026-08-24T10:00:00.000Z" },
        summary: "Moved event",
      },
    });
    await expect(calendarApi.moveCalendarEvent({
      destinationCalendarId: "destination",
      eventId: "event-1",
      sendUpdates: "all",
      sourceCalendarId: "source",
    })).resolves.toMatchObject({
      calendarId: "destination",
      etag: "moved-etag",
      id: "event-1",
      summary: "Moved event",
    });
    expect(client.events.move).toHaveBeenCalledWith({
      calendarId: "source",
      destination: "destination",
      eventId: "event-1",
      sendUpdates: "all",
    });
  });

  it("rejects a repeated page token instead of looping forever", async () => {
    await expect(
      collectGooglePages(async (pageToken) => ({
        items: pageToken ? ["second"] : ["first"],
        nextPageToken: "same-token",
      })),
    ).rejects.toThrow(/repeated page token/i);
  });
});
