import { describe, expect, it } from "vitest";

import {
  parseDeterministicCommand,
  type ParserContext,
} from "../src/nlp/deterministic-command-parser.js";

function context(
  now = "2025-01-06T16:00:00.000Z",
  timeZone = "America/New_York",
): ParserContext {
  return { now: new Date(now), timeZone };
}

describe("parseDeterministicCommand", () => {
  it("resolves today and tomorrow in the supplied IANA time zone", () => {
    const losAngelesContext = context("2025-01-03T01:30:00.000Z", "America/Los_Angeles");

    expect(parseDeterministicCommand("what do I have today?", losAngelesContext)).toEqual({
      kind: "list",
      date: "2025-01-02",
    });
    expect(parseDeterministicCommand("what do I have tomorrow?", losAngelesContext)).toEqual({
      kind: "list",
      date: "2025-01-03",
    });
  });

  it("resolves weekdays, next weekdays, and ISO dates deterministically", () => {
    expect(parseDeterministicCommand("what do I have Friday?", context())).toEqual({
      kind: "list",
      date: "2025-01-10",
    });
    expect(parseDeterministicCommand("list next Friday", context())).toEqual({
      kind: "list",
      date: "2025-01-17",
    });
    expect(parseDeterministicCommand("what do I have on 2025-04-02?", context())).toEqual({
      kind: "list",
      date: "2025-04-02",
    });
  });

  it("creates an event with a default duration and noon normalized to 24-hour time", () => {
    expect(parseDeterministicCommand("schedule lunch Friday at noon", context())).toEqual({
      kind: "create",
      date: "2025-01-10",
      durationMinutes: 60,
      startTime: "12:00",
      title: "lunch",
    });
  });

  it("normalizes common clock forms and explicit durations for creates", () => {
    expect(
      parseDeterministicCommand("schedule planning Friday at 3:30 PM for 45 minutes", context()),
    ).toEqual({
      kind: "create",
      date: "2025-01-10",
      durationMinutes: 45,
      startTime: "15:30",
      title: "planning",
    });
    expect(parseDeterministicCommand("schedule backup Saturday at midnight", context())).toEqual({
      kind: "create",
      date: "2025-01-11",
      durationMinutes: 60,
      startTime: "00:00",
      title: "backup",
    });
  });

  it("parses a time-specific update selector and its replacement time", () => {
    expect(
      parseDeterministicCommand("change the 3pm meeting on Friday to 4pm", context()),
    ).toEqual({
      kind: "update",
      newStartTime: "16:00",
      selector: {
        date: "2025-01-10",
        summary: "meeting",
        time: "15:00",
      },
    });
  });

  it("parses delete and reminder selectors", () => {
    expect(parseDeterministicCommand("delete the 3pm meeting on Friday", context())).toEqual({
      kind: "delete",
      selector: {
        date: "2025-01-10",
        summary: "meeting",
        time: "15:00",
      },
    });
    expect(
      parseDeterministicCommand(
        "remind me 30 mins before the 3pm meeting on Friday",
        context(),
      ),
    ).toEqual({
      kind: "set_reminder",
      minutesBefore: 30,
      selector: {
        date: "2025-01-10",
        summary: "meeting",
        time: "15:00",
      },
    });
  });

  it("parses explicit recurrence scope without treating it as an event title", () => {
    expect(
      parseDeterministicCommand(
        "change the 3pm meeting on Friday to 4pm all future occurrences",
        context(),
      ),
    ).toEqual({
      kind: "update",
      newStartTime: "16:00",
      recurrenceScope: "all_future",
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
    expect(parseDeterministicCommand("delete the 3pm meeting on Friday whole series", context())).toEqual({
      kind: "delete",
      recurrenceScope: "series",
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
  });

  it("parses supported attendee changes into a constrained command", () => {
    expect(
      parseDeterministicCommand("add alex@example.com to the 3pm meeting on Friday", context()),
    ).toEqual({
      kind: "manage_attendees",
      change: { action: "add", emails: ["alex@example.com"] },
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
    expect(
      parseDeterministicCommand("remove alex@example.com from the 3pm meeting on Friday", context()),
    ).toEqual({
      kind: "manage_attendees",
      change: { action: "remove", emails: ["alex@example.com"] },
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
  });

  it("asks for clarification instead of inventing indispensable details", () => {
    expect(parseDeterministicCommand("schedule lunch Friday", context())).toMatchObject({
      kind: "clarify",
    });
    expect(parseDeterministicCommand("delete Friday", context())).toMatchObject({
      kind: "clarify",
    });
    expect(parseDeterministicCommand("organize my calendar", context())).toMatchObject({
      kind: "clarify",
    });
  });
});


describe("deterministic clarification eligibility", () => {
  it("labels only unrecognized requests as unsupported", () => {
    expect(parseDeterministicCommand("organize my calendar", context())).toMatchObject({
      kind: "clarify",
      reason: "unsupported_intent",
    });
    expect(parseDeterministicCommand("schedule lunch Friday", context())).toMatchObject({
      kind: "clarify",
      reason: "missing_required_detail",
    });
    expect(parseDeterministicCommand("schedule lunch 2025-02-30 at 3pm", context())).toMatchObject({
      kind: "clarify",
      reason: "invalid_value",
    });
  });
});