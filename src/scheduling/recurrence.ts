import { DateTime, IANAZone } from "luxon";

import type { ScheduleRecurrence } from "./schedule-domain.js";

/**
 * Expands a local-date recurrence inclusively. Monthly schedules retain the
 * original day-of-month where possible and clamp only short months; yearly
 * February 29 schedules resolve to February 28 in non-leap years.
 */
export function expandScheduleDates(input: {
  readonly endDate: string;
  readonly recurrence: ScheduleRecurrence;
  readonly startDate: string;
  readonly timeZone: string;
}): readonly string[] {
  if (!IANAZone.isValidZone(input.timeZone)) {
    return [];
  }
  const start = DateTime.fromFormat(input.startDate, "yyyy-LL-dd", { zone: input.timeZone }).startOf("day");
  const end = DateTime.fromFormat(input.endDate, "yyyy-LL-dd", { zone: input.timeZone }).endOf("day");
  if (!start.isValid || !end.isValid || start > end) {
    return [];
  }

  switch (input.recurrence.frequency) {
    case "daily":
      return expandDaily(start, end, input.recurrence.interval);
    case "weekly":
      return expandWeekly(start, end, input.recurrence.interval, input.recurrence.weekdays ?? [start.weekday]);
    case "monthly":
      return expandMonthly(start, end, input.recurrence.interval);
    case "yearly":
      return expandYearly(start, end, input.recurrence.interval);
  }
}

export function buildCalendarRRule(recurrence: ScheduleRecurrence): string {
  const frequency = recurrence.frequency === "daily" ? "DAILY"
    : recurrence.frequency === "weekly" ? "WEEKLY"
      : recurrence.frequency === "monthly" ? "MONTHLY"
        : "YEARLY";
  const parts = [`RRULE:FREQ=${frequency}`];
  if (recurrence.interval > 1) {
    parts.push(`INTERVAL=${recurrence.interval}`);
  }
  if (recurrence.frequency === "weekly" && recurrence.weekdays?.length) {
    const days = recurrence.weekdays.map(weekdayToRRuleDay).filter((day): day is string => Boolean(day));
    if (days.length > 0) {
      parts.push(`BYDAY=${days.join(",")}`);
    }
  }
  return parts.join(";");
}

function expandDaily(start: DateTime, end: DateTime, interval: number): readonly string[] {
  const values: string[] = [];
  for (let current = start; current <= end; current = current.plus({ days: interval })) {
    values.push(current.toFormat("yyyy-LL-dd"));
  }
  return values;
}

function expandWeekly(start: DateTime, end: DateTime, interval: number, weekdays: readonly number[]): readonly string[] {
  const values: string[] = [];
  const selected = [...new Set(weekdays)].filter((weekday) => weekday >= 1 && weekday <= 7).sort((a, b) => a - b);
  const weekStart = start.startOf("week");
  for (let week = weekStart; week <= end; week = week.plus({ weeks: interval })) {
    for (const weekday of selected) {
      const candidate = week.plus({ days: weekday - 1 });
      if (candidate >= start && candidate <= end) {
        values.push(candidate.toFormat("yyyy-LL-dd"));
      }
    }
  }
  return values;
}

function expandMonthly(start: DateTime, end: DateTime, interval: number): readonly string[] {
  const values: string[] = [];
  const anchorDay = start.day;
  for (let index = 0; ; index += interval) {
    const month = start.startOf("month").plus({ months: index });
    if (month > end) {
      break;
    }
    const candidate = month.set({ day: Math.min(anchorDay, month.daysInMonth ?? 28) });
    if (candidate >= start && candidate <= end) {
      values.push(candidate.toFormat("yyyy-LL-dd"));
    }
  }
  return values;
}

function expandYearly(start: DateTime, end: DateTime, interval: number): readonly string[] {
  const values: string[] = [];
  for (let year = start.year; year <= end.year; year += interval) {
    const month = DateTime.fromObject({ year, month: start.month, day: 1 }, { zone: start.zoneName ?? "UTC" });
    const candidate = month.set({ day: Math.min(start.day, month.daysInMonth ?? 28) });
    if (candidate >= start && candidate <= end) {
      values.push(candidate.toFormat("yyyy-LL-dd"));
    }
  }
  return values;
}

function weekdayToRRuleDay(weekday: number): string | undefined {
  return [undefined, "MO", "TU", "WE", "TH", "FR", "SA", "SU"][weekday];
}
