import { describe, expect, it } from "vitest";

import { parseScheduleCommand } from "../src/scheduling/schedule-parser.js";
import { normalizeTemporalAliases, resolveRelativeDate } from "../src/scheduling/temporal.js";

const context = {
  now: new Date("2026-08-18T12:00:00.000Z"),
  timeZone: "America/Toronto",
};

describe("schedule temporal grammar", () => {
  it("normalizes only numeric aliases and keeps title text intact", () => {
    expect(normalizeTemporalAliases("in 1 hr, 2 hrs, 3 d, 4 w, 5 m, 6 y, 7 min, 8 mins")).toBe(
      "in 1 hours, 2 hours, 3 days, 4 weeks, 5 months, 6 years, 7 minutes, 8 minutes",
    );
    expect(normalizeTemporalAliases("Schedule M&M meeting in 1 hr")).toBe("Schedule M&M meeting in 1 hours");
    expect(resolveRelativeDate("in 3 m", context.now, context.timeZone)).toBe("2026-11-18");
    expect(resolveRelativeDate("in 2 mins", context.now, context.timeZone)).toBe("2026-08-18");
  });
});

describe("parseScheduleCommand", () => {
  it("deterministically understands the exact today agenda acceptance phrase", () => {
    expect(parseScheduleCommand("What do i need to do today", context)).toEqual({
      date: "2026-08-18",
      endDate: "2026-08-18",
      kind: "agenda",
      range: "day",
    });
  });

  it("handles a weekly all-day recurring task when no start time exists", () => {
    expect(parseScheduleCommand("Remind me every other Wednesday to buy cheese", context)).toMatchObject({
      date: "2026-08-19",
      kind: "local",
      recurrence: { frequency: "weekly", interval: 2, weekdays: [3] },
      scheduleKind: "task",
      title: "buy cheese",
    });
  });

  it("classifies a start-only schedule as a reminder", () => {
    expect(parseScheduleCommand("Get a yoga class on my calendar every Tuesday and Thursday at 6am", context)).toMatchObject({
      date: "2026-08-18",
      kind: "local",
      recurrence: { frequency: "weekly", interval: 1, weekdays: [2, 4] },
      scheduleKind: "reminder",
      startTime: "06:00",
      title: "yoga class",
    });
  });

  it("requires an explicit end or duration to classify a schedule as an event", () => {
    expect(parseScheduleCommand("Schedule yoga Tuesday at 6am for 1 hr", context)).toMatchObject({
      date: "2026-08-18",
      endTime: "07:00",
      kind: "event",
      startTime: "06:00",
      title: "yoga",
    });
  });

  it("keeps relative hour and minute start times as reminders", () => {
    expect(parseScheduleCommand("Schedule focus in 1 hr", context)).toEqual({
      date: "2026-08-18",
      kind: "local",
      scheduleKind: "reminder",
      startTime: "09:00",
      title: "focus",
    });
    expect(parseScheduleCommand("Schedule stretch in 30 mins", context)).toEqual({
      date: "2026-08-18",
      kind: "local",
      scheduleKind: "reminder",
      startTime: "08:30",
      title: "stretch",
    });
  });

  it("requires a concrete date anchor for monthly and yearly recurrence", () => {
    expect(parseScheduleCommand("Remind me every month Monday to pay rent", context)).toEqual({
      kind: "clarify",
      message: "Monthly and yearly recurrence need a concrete date such as 2026-09-15.",
    });
    expect(parseScheduleCommand("Remind me every year on 2026-12-01 to renew passport", context)).toMatchObject({
      date: "2026-12-01",
      kind: "local",
      recurrence: { frequency: "yearly", interval: 1 },
      scheduleKind: "task",
    });
  });

  it("validates the documented manual correction grammar", () => {
    expect(parseScheduleCommand([
      "create: event",
      "title: yoga",
      "date: 2026-08-20",
      "starttime: 06:00",
      "duration: 60m",
      "recurrence: weekly",
    ].join("\n"), context)).toMatchObject({
      date: "2026-08-20",
      endTime: "07:00",
      kind: "event",
      recurrence: { frequency: "weekly", interval: 1, weekdays: [4] },
      startTime: "06:00",
      title: "yoga",
    });
  });
});
