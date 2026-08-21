import { DateTime } from "luxon";

import { formatDiscordDate, formatDiscordTimestamp } from "../discord/discord-timestamp.js";
import type { CalendarEvent, CalendarEventDateTime, TimedEventDateTime } from "../domain/calendar.js";

export class CalendarTimeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CalendarTimeError";
  }
}

function requireValidDateTime(value: DateTime, description: string): DateTime {
  if (!value.isValid) {
    throw new CalendarTimeError(`Invalid ${description}`);
  }
  return value;
}

function requireIso(value: DateTime, description: string): string {
  const iso = value.toISO();
  if (!iso) {
    throw new CalendarTimeError(`Could not serialize ${description}`);
  }
  return iso;
}

export function createTimedEventDateTime(
  localDate: string,
  localTime: string,
  timeZone: string,
): TimedEventDateTime {
  const dateTime = requireValidDateTime(
    DateTime.fromFormat(`${localDate} ${localTime}`, "yyyy-LL-dd HH:mm", { zone: timeZone }),
    "local date and time",
  );

  return {
    dateTime: requireIso(dateTime, "event start"),
    kind: "timed",
    timeZone,
  };
}

export function calendarDateTimeToDateTime(
  value: CalendarEventDateTime,
  fallbackTimeZone: string,
): DateTime {
  const timeZone = value.timeZone || fallbackTimeZone;
  const dateTime =
    value.kind === "timed"
      ? DateTime.fromISO(value.dateTime, { setZone: true }).setZone(timeZone)
      : DateTime.fromISO(value.date, { zone: timeZone }).startOf("day");

  return requireValidDateTime(dateTime, "calendar event date and time");
}

export function calendarDayBounds(
  localDate: string,
  timeZone: string,
): { readonly timeMax: string; readonly timeMin: string } {
  const start = requireValidDateTime(
    DateTime.fromISO(localDate, { zone: timeZone }).startOf("day"),
    "calendar day",
  );
  return {
    timeMax: requireIso(start.plus({ days: 1 }).toUTC(), "calendar day end"),
    timeMin: requireIso(start.toUTC(), "calendar day start"),
  };
}

export function eventDurationMinutes(event: CalendarEvent, fallbackTimeZone: string): number {
  const start = calendarDateTimeToDateTime(event.start, fallbackTimeZone);
  const end = calendarDateTimeToDateTime(event.end, fallbackTimeZone);
  const minutes = Math.round(end.diff(start, "minutes").minutes);
  return minutes > 0 ? minutes : 60;
}

export function eventOccurrenceStart(event: CalendarEvent): string {
  const occurrence = event.originalStart ?? event.start;
  return occurrence.kind === "timed" ? occurrence.dateTime : occurrence.date;
}

export function eventStartForReminder(event: CalendarEvent, fallbackTimeZone: string): DateTime {
  if (event.start.kind === "timed") {
    return calendarDateTimeToDateTime(event.start, fallbackTimeZone);
  }

  return requireValidDateTime(
    DateTime.fromISO(event.start.date, { zone: event.start.timeZone || fallbackTimeZone }).set({
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
    }),
    "all-day reminder time",
  );
}

export function formatEventStart(event: CalendarEvent, fallbackTimeZone: string): string {
  if (event.start.kind === "all_day") {
    return `${formatDiscordDate(event.start.date, event.start.timeZone || fallbackTimeZone)} (all day)`;
  }

  return formatDiscordTimestamp(calendarDateTimeToDateTime(event.start, fallbackTimeZone).toUTC().toJSDate());
}

export function eventMatchesLocalTime(
  event: CalendarEvent,
  localTime: string,
  fallbackTimeZone: string,
): boolean {
  return event.start.kind === "timed" &&
    calendarDateTimeToDateTime(event.start, fallbackTimeZone).toFormat("HH:mm") === localTime;
}
