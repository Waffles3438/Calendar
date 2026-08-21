import { describe, expect, it } from "vitest";

import { parseScheduleCommand } from "../src/scheduling/schedule-parser.js";

const context = {
  now: new Date("2026-08-18T12:00:00.000Z"),
  timeZone: "America/Toronto",
};

describe("schedule parser safety rules", () => {
  it("keeps the requested type rules strict", () => {
    expect(parseScheduleCommand("Schedule yoga tomorrow at 6am", context)).toMatchObject({
      date: "2026-08-19",
      kind: "local",
      scheduleKind: "reminder",
      startTime: "06:00",
      title: "yoga",
    });
    expect(parseScheduleCommand("Remind me to buy cheese tomorrow", context)).toMatchObject({
      date: "2026-08-19",
      kind: "local",
      scheduleKind: "task",
      title: "buy cheese",
    });
    expect(parseScheduleCommand("Create task plan tomorrow at 6pm", context)).toEqual({
      kind: "clarify",
      message: "Tasks are all-day and cannot include a start time, end time, or duration.",
    });
  });

  it("does not invent one-time multi-date schedules and retains legacy command ownership", () => {
    expect(parseScheduleCommand("Schedule yoga Tuesday and Thursday at 6am", context)).toEqual({
      kind: "clarify",
      message: "One-time schedules need exactly one date.",
    });
    expect(parseScheduleCommand("remind me in 30 mins to run", context)).toEqual({ kind: "unsupported" });
    expect(parseScheduleCommand("remind me 30 mins before the meeting Friday", context)).toEqual({ kind: "unsupported" });
  });

  it("supports the documented manual calendar field and an overnight duration", () => {
    expect(parseScheduleCommand([
      "create: event",
      "title: overnight deployment",
      "date: 2026-08-21",
      "starttime: 23:30",
      "duration: 90m",
      "calendar: Operations",
    ].join("\n"), context)).toEqual({
      calendarName: "Operations",
      date: "2026-08-21",
      endDate: "2026-08-22",
      endTime: "01:00",
      kind: "event",
      startTime: "23:30",
      title: "overnight deployment",
    });
  });

  it("parses structured bulk and named cleanup without treating dates as title terms", () => {
    expect(parseScheduleCommand("delete all tasks", context)).toEqual({
      kind: "cleanup",
      mode: "bulk",
      targetKinds: ["task"],
      terms: [],
      title: "all tasks",
    });
    expect(parseScheduleCommand("delete all reminders for today", context)).toEqual({
      date: "2026-08-18",
      kind: "cleanup",
      mode: "bulk",
      targetKinds: ["reminder"],
      terms: [],
      title: "all reminders for today",
    });
    expect(parseScheduleCommand("delete all tasks/events/reminders for today", context)).toEqual({
      date: "2026-08-18",
      kind: "cleanup",
      mode: "bulk",
      targetKinds: ["task", "event", "reminder"],
      terms: [],
      title: "all tasks/events/reminders for today",
    });
    expect(parseScheduleCommand("delete reminder call dentist for today", context)).toEqual({
      date: "2026-08-18",
      kind: "cleanup",
      mode: "named",
      targetKinds: ["reminder"],
      terms: ["call", "dentist"],
      title: "call dentist",
    });
    expect(parseScheduleCommand("delete task run tomorrow", context)).toEqual({
      date: "2026-08-19",
      kind: "cleanup",
      mode: "named",
      targetKinds: ["task"],
      terms: ["run"],
      title: "run",
    });
    expect(parseScheduleCommand("delete all future yoga tasks", context)).toMatchObject({
      kind: "cleanup",
      mode: "reviewed",
      targetKinds: ["task"],
      terms: ["yoga"],
      title: "yoga",
    });
  });
});
