import { describe, expect, it } from "vitest";

import {
  isTaskShapedInput,
  parseDeterministicTaskCommand,
  type TaskParserContext,
} from "../src/tasks/deterministic-task-parser.js";

function context(
  now = "2026-08-17T20:00:00.000Z",
  timeZone = "America/Toronto",
): TaskParserContext {
  return { now: new Date(now), timeZone };
}

describe("parseDeterministicTaskCommand", () => {
  it("creates the requested local task from canonical reminder wording", () => {
    expect(parseDeterministicTaskCommand("remind me at 6pm tomorrow to run", context())).toEqual({
      date: "2026-08-18",
      kind: "create",
      time: "18:00",
      title: "run",
    });
  });

  it("creates a relative-minute local task without requiring a date", () => {
    expect(parseDeterministicTaskCommand("remind me in 30 mins to run", context())).toEqual({
      date: "2026-08-17",
      kind: "create",
      time: "16:30",
      title: "run",
    });
  });

  it("calculates relative-minute tasks across minute boundaries, midnight, and spring-forward", () => {
    expect(
      parseDeterministicTaskCommand("remind me in 30 minutes to run", context("2026-08-17T20:00:30.001Z")),
    ).toEqual({
      date: "2026-08-17",
      kind: "create",
      time: "16:31",
      title: "run",
    });
    expect(
      parseDeterministicTaskCommand("remind me in 30 mins to run", context("2026-08-18T03:45:00.000Z")),
    ).toEqual({
      date: "2026-08-18",
      kind: "create",
      time: "00:15",
      title: "run",
    });
    expect(
      parseDeterministicTaskCommand("remind me in 30 mins to run", context("2026-03-08T06:45:00.000Z")),
    ).toEqual({
      date: "2026-03-08",
      kind: "create",
      time: "03:15",
      title: "run",
    });
  });

  it("rejects unsafe, nonpositive, and repeated-hour relative task times", () => {
    expect(parseDeterministicTaskCommand("remind me in 0 mins to run", context())).toMatchObject({
      kind: "clarify",
      reason: "invalid_value",
    });
    expect(
      parseDeterministicTaskCommand("remind me in 9007199254740992 mins to run", context()),
    ).toMatchObject({
      kind: "clarify",
      reason: "invalid_value",
    });
    expect(
      parseDeterministicTaskCommand("remind me in 30 mins to run", context("2026-11-01T04:45:00.000Z")),
    ).toMatchObject({
      kind: "clarify",
      reason: "invalid_value",
    });
  });

  it("supports create-task syntax while preserving an explicit supplied date", () => {
    expect(parseDeterministicTaskCommand("create task pay hydro Friday at noon", context())).toEqual({
      date: "2026-08-21",
      kind: "create",
      time: "12:00",
      title: "pay hydro",
    });
  });

  it("does not claim Google event-reminder grammar or Calendar-oriented wording", () => {
    expect(isTaskShapedInput("remind me 15 mins before Friday's meeting")).toBe(false);
    expect(parseDeterministicTaskCommand("remind me 15 mins before Friday's meeting", context())).toEqual({
      kind: "not_task",
    });

    const calendarRequest = "remember to schedule a meeting on my calendar tomorrow";
    expect(isTaskShapedInput(calendarRequest)).toBe(false);
    expect(parseDeterministicTaskCommand(calendarRequest, context())).toEqual({ kind: "not_task" });
  });

  it("requires a supplied date and time rather than guessing one", () => {
    expect(parseDeterministicTaskCommand("remind me at 6pm to run", context())).toMatchObject({
      kind: "clarify",
      reason: "missing_required_detail",
    });
    expect(parseDeterministicTaskCommand("remind me tomorrow to run", context())).toMatchObject({
      kind: "clarify",
      reason: "missing_required_detail",
    });
  });

  it("parses date-filtered task lists, completion, explicit cancellation, and delete commands", () => {
    expect(parseDeterministicTaskCommand("tasks", context())).toEqual({ kind: "list" });
    expect(isTaskShapedInput("what tasks do I have today?")).toBe(true);
    expect(parseDeterministicTaskCommand("what tasks do I have today?", context())).toEqual({
      date: "2026-08-17",
      kind: "list",
    });
    expect(isTaskShapedInput("what do I have today?")).toBe(false);
    expect(isTaskShapedInput("what tasks do I have on my calendar today?")).toBe(false);
    expect(parseDeterministicTaskCommand("done run tomorrow", context())).toEqual({
      kind: "complete",
      selector: { date: "2026-08-18", title: "run" },
    });
    expect(parseDeterministicTaskCommand("done task", context())).toMatchObject({
      kind: "clarify",
      reason: "missing_required_detail",
    });
    expect(parseDeterministicTaskCommand("cancel task run Friday", context())).toEqual({
      kind: "cancel",
      selector: { date: "2026-08-21", title: "run" },
    });
    expect(isTaskShapedInput("delete task run")).toBe(true);
    expect(parseDeterministicTaskCommand("delete task run", context())).toEqual({
      kind: "cancel",
      selector: { title: "run" },
    });
    expect(isTaskShapedInput("delete all tasks")).toBe(true);
    expect(parseDeterministicTaskCommand("delete all tasks", context())).toEqual({ kind: "cancel_all" });
    expect(parseDeterministicTaskCommand("delete all tasks for today", context())).toEqual({
      date: "2026-08-17",
      kind: "cancel_all",
    });
    expect(parseDeterministicTaskCommand("delete all tasks after lunch", context())).toMatchObject({
      kind: "clarify",
      reason: "invalid_value",
    });
  });

  it("rejects recurring local task wording without invoking an inferred recurrence model", () => {
    expect(parseDeterministicTaskCommand("remind me every Tuesday at 6pm to run", context())).toEqual({
      kind: "recurrence_unsupported",
    });
  });

  it("rejects invalid and ambiguous Toronto daylight-saving times", () => {
    expect(
      parseDeterministicTaskCommand(
        "remind me at 2:30am on 2026-03-08 to run",
        context("2026-03-01T12:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "clarify", reason: "invalid_value" });
    expect(
      parseDeterministicTaskCommand(
        "remind me at 1:30am on 2026-11-01 to run",
        context("2026-10-30T12:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "clarify", reason: "invalid_value" });
  });
});
