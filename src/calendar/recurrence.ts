import { DateTime } from "luxon";

import { calendarDateTimeToDateTime } from "./event-time.js";
import type { CalendarEvent, CalendarEventDateTime } from "../domain/calendar.js";

export class RecurrenceSplitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecurrenceSplitError";
  }
}

export interface RecurrenceSplit {
  readonly futureRecurrence: readonly string[];
  readonly precedingRecurrence: readonly string[];
}

function occurrenceStart(event: CalendarEvent): CalendarEventDateTime {
  return event.originalStart ?? event.start;
}

function requireSimpleRule(recurrence: readonly string[] | undefined): string {
  if (!recurrence || recurrence.length !== 1 || !recurrence[0]?.startsWith("RRULE:")) {
    throw new RecurrenceSplitError(
      "This recurring event has exceptions or multiple rules, so all-future changes are not safe to automate.",
    );
  }

  const rule = recurrence[0];
  if (!rule || !/;?FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/u.test(rule)) {
    throw new RecurrenceSplitError("This recurring event has an unsupported recurrence rule.");
  }
  if (/(?:^|;)COUNT=/u.test(rule.slice("RRULE:".length))) {
    throw new RecurrenceSplitError(
      "This recurring event uses a count limit, so all-future changes are not safe to automate.",
    );
  }

  return rule;
}

function untilBefore(value: CalendarEventDateTime, timeZone: string): string {
  if (value.kind === "all_day") {
    const previousDay = DateTime.fromISO(value.date, { zone: value.timeZone || timeZone }).minus({ days: 1 });
    if (!previousDay.isValid) {
      throw new RecurrenceSplitError("Could not determine the occurrence before the requested split.");
    }
    return previousDay.toFormat("yyyyLLdd");
  }

  const previousSecond = calendarDateTimeToDateTime(value, timeZone)
    .toUTC()
    .minus({ seconds: 1 });
  if (!previousSecond.isValid) {
    throw new RecurrenceSplitError("Could not determine the occurrence before the requested split.");
  }
  return previousSecond.toFormat("yyyyLLdd'T'HHmmss'Z'");
}

function replaceUntil(rule: string, value: string): string {
  const properties = rule.slice("RRULE:".length).split(";");
  const withoutUntil = properties.filter((property) => !property.startsWith("UNTIL="));
  return `RRULE:${[...withoutUntil, `UNTIL=${value}`].join(";")}`;
}

/**
 * Splits a simple RRULE into the historical portion and a future portion.
 * Complex rules are deliberately rejected instead of risking lost exceptions.
 */
export function splitRecurrenceAt(
  master: CalendarEvent,
  targetOccurrence: CalendarEvent,
  timeZone: string,
): RecurrenceSplit {
  const rule = requireSimpleRule(master.recurrence);
  if (isFirstRecurringOccurrence(master, targetOccurrence, timeZone)) {
    throw new RecurrenceSplitError(
      "The selected occurrence is the first in the series; use the whole-series scope instead.",
    );
  }

  return {
    futureRecurrence: [rule],
    precedingRecurrence: [replaceUntil(rule, untilBefore(occurrenceStart(targetOccurrence), timeZone))],
  };
}

export function isFirstRecurringOccurrence(
  master: CalendarEvent,
  targetOccurrence: CalendarEvent,
  timeZone: string,
): boolean {
  const masterStart = calendarDateTimeToDateTime(master.start, timeZone);
  const targetStart = calendarDateTimeToDateTime(occurrenceStart(targetOccurrence), timeZone);
  return targetStart.toMillis() <= masterStart.toMillis();
}
