import type { CalendarEvent, CalendarReference } from "../src/domain/calendar.js";
import type { CalendarGateway } from "../src/google/calendar-api.js";
import { AgendaService } from "../src/scheduling/agenda-service.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";
import { describe, expect, it } from "vitest";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2026-08-20T01:00:00.000-04:00", kind: "timed", timeZone },
    etag: "etag-1",
    id: "event-1",
    start: { dateTime: "2026-08-18T23:00:00.000-04:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Overnight work",
    ...overrides,
  };
}

function gateway(events: readonly CalendarEvent[], fail = false): CalendarGateway {
  const calendars: readonly CalendarReference[] = [{ id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone }];
  return {
    createEvent: async () => event(),
    deleteEvent: async () => undefined,
    getEvent: async () => event(),
    listCalendars: async () => {
      if (fail) {
        throw new Error("Google unavailable");
      }
      return calendars;
    },
    listEvents: async () => events,
    splitRecurringEvent: async () => event(),
    truncateRecurringEvent: async () => undefined,
    updateEvent: async () => event(),
  };
}

describe("AgendaService", () => {
  it("renders unified categories in order and includes a spanning event on every overlapping day", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    schedules.createScheduledItem({
      id: "task-1", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Buy cheese",
    });
    schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T13:00:00.000Z"), id: "reminder-1", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Call dentist",
    });
    const agenda = new AgendaService({ calendarGateway: gateway([event()]), now: () => now, ownerId, schedulingRepository: schedules, timeZone });

    const days = await agenda.getDays({ date: "2026-08-18", endDate: "2026-08-19" });
    expect(days[0]?.events.map(({ event: item }) => item.summary)).toEqual(["Overnight work"]);
    expect(days[1]?.events.map(({ event: item }) => item.summary)).toEqual(["Overnight work"]);
    const rendered = await agenda.render({ date: "2026-08-19", endDate: "2026-08-19", range: "day" });
    expect(rendered).toMatch(/Agenda for <t:\d+:D>:/u);
    expect(rendered).toContain("Tasks:\n- Buy cheese");
    expect(rendered).toMatch(/Events:\n- \[Personal\] Overnight work — <t:\d+:F>/u);
    expect(rendered).toMatch(/Reminders:\n- Call dentist — <t:\d+:F>/u);
    expect(rendered).not.toContain("2026-08-19");
    expect(rendered.indexOf("Tasks:")).toBeLessThan(rendered.indexOf("Events:"));
    expect(rendered.indexOf("Events:")).toBeLessThan(rendered.indexOf("Reminders:"));
    schedules.close();
  });

  it("fails rather than marking an incomplete all-calendar agenda as complete", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const agenda = new AgendaService({ calendarGateway: gateway([], true), now: () => now, ownerId, schedulingRepository: schedules, timeZone });
    await expect(agenda.render({ date: "2026-08-18", endDate: "2026-08-18", range: "day" })).rejects.toThrow("Google unavailable");
    schedules.close();
  });
});
