import { describe, expect, it } from "vitest";

import {
  parseNaturalLanguageAction,
  validateNaturalLanguageAction,
} from "../src/nlp/natural-language-action.js";

const validation = {
  now: new Date("2026-08-17T20:00:00.000Z"),
  timeZone: "America/Toronto",
};

describe("natural-language action contract", () => {
  it("accepts the three explicit task deletion scopes", () => {
    expect(validateNaturalLanguageAction({ action: "delete_task", scope: "all" }, validation)).toEqual({
      action: "delete_task",
      scope: "all",
    });
    expect(validateNaturalLanguageAction({ action: "delete_task", date: "2026-08-17", scope: "today" }, validation)).toEqual({
      action: "delete_task",
      date: "2026-08-17",
      scope: "today",
    });
    expect(validateNaturalLanguageAction({
      action: "delete_task",
      scope: "single",
      selector: { title: "call plumber" },
    }, validation)).toEqual({
      action: "delete_task",
      scope: "single",
      selector: { title: "call plumber" },
    });
  });

  it("normalizes valid attendee email addresses and preserves application selectors", () => {
    expect(parseNaturalLanguageAction(JSON.stringify({
      action: "manage_calendar_attendees",
      change: { action: "add", emails: ["SAM@EXAMPLE.COM"] },
      selector: { date: "2026-08-21", summary: "lunch" },
    }), validation)).toEqual({
      action: "manage_calendar_attendees",
      change: { action: "add", emails: ["sam@example.com"] },
      selector: { date: "2026-08-21", summary: "lunch" },
    });
  });

  it("rejects missing deletion fields, unknown fields, IDs, URLs, and invalid local times", () => {
    const invalidValues: unknown[] = [
      { action: "delete_task", scope: "single" },
      { action: "delete_task", date: "2026-08-17", scope: "all" },
      { action: "delete_task", id: "task-1", scope: "all" },
      { action: "list_calendar", date: "2026-02-30" },
      { action: "create_task_or_reminder", date: "2026-03-08", scheduleKind: "reminder", startTime: "02:30", title: "spring forward" },
      { action: "list_tasks", tool: "delete everything" },
      { action: "complete_task", selector: { title: "https://example.test" } },
    ];
    for (const value of invalidValues) {
      expect(validateNaturalLanguageAction(value, validation)).toBeUndefined();
    }
  });

  it("rejects an ambiguous or past one-time task time instead of guessing", () => {
    expect(validateNaturalLanguageAction({
      action: "create_task_or_reminder",
      date: "2026-08-17",
      scheduleKind: "reminder",
      startTime: "15:00",
      title: "already passed",
    }, validation)).toBeUndefined();
    expect(validateNaturalLanguageAction({
      action: "create_calendar_event",
      date: "2026-08-21",
      endTime: "11:00",
      startTime: "12:00",
      title: "backwards",
    }, validation)).toBeUndefined();
  });

  it("bounds agenda actions to a day or a seven-day week", () => {
    expect(validateNaturalLanguageAction({
      action: "show_agenda",
      date: "2026-08-18",
      endDate: "2026-08-18",
      range: "day",
    }, validation)).toMatchObject({ action: "show_agenda", range: "day" });
    expect(validateNaturalLanguageAction({
      action: "show_agenda",
      date: "2026-08-17",
      endDate: "2026-08-23",
      range: "week",
    }, validation)).toMatchObject({ action: "show_agenda", range: "week" });
    expect(validateNaturalLanguageAction({
      action: "show_agenda",
      date: "2026-08-17",
      endDate: "2026-08-30",
      range: "week",
    }, validation)).toBeUndefined();
  });
});
