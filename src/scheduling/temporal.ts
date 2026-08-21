import { DateTime, IANAZone } from "luxon";

import type { RecurrenceFrequency, ScheduleRecurrence } from "./schedule-domain.js";

export interface DateAnchor {
  readonly dates: readonly string[];
  readonly hasConcreteDate: boolean;
  readonly weekdays: readonly number[];
}

export interface ParsedDuration {
  readonly amount: number;
  readonly unit: "day" | "hour" | "minute" | "month" | "week" | "year";
}

const WEEKDAY_BY_NAME: Readonly<Record<string, number>> = {
  fri: 5,
  friday: 5,
  mon: 1,
  monday: 1,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
};

const UNIT_BY_TOKEN: Readonly<Record<string, ParsedDuration["unit"]>> = {
  d: "day",
  day: "day",
  days: "day",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  m: "month",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  month: "month",
  months: "month",
  w: "week",
  week: "week",
  weeks: "week",
  y: "year",
  year: "year",
  years: "year",
};

/**
 * Canonicalizes only number-plus-unit expressions. This deliberately leaves
 * free text such as "M&M meeting" or a calendar name untouched.
 */
export function normalizeTemporalAliases(input: string): string {
  return input.replace(/\b(\d+(?:\.\d+)?)\s*(hrs?|hr|d|w|m|y|mins?|min)\b/giu, (whole, amount: string, token: string) => {
    const unit = UNIT_BY_TOKEN[token.toLowerCase()];
    if (!unit) {
      return whole;
    }
    const canonical = unit === "hour" ? "hours"
      : unit === "minute" ? "minutes"
        : unit === "day" ? "days"
          : unit === "week" ? "weeks"
            : unit === "month" ? "months"
              : "years";
    return `${amount} ${canonical}`;
  });
}

export function parseDurationToken(value: string): ParsedDuration | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(hrs?|hr|hours?|d(?:ays?)?|w(?:eeks?)?|m(?:onths?)?|y(?:ears?)?|mins?|minutes?)\s*$/iu.exec(value);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = UNIT_BY_TOKEN[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || !unit) {
    return undefined;
  }
  return { amount, unit };
}

export function resolveRelativeDate(input: string, now: Date, timeZone: string): string | undefined {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || !IANAZone.isValidZone(timeZone)) {
    return undefined;
  }
  const match = /\bin\s+(\d+(?:\.\d+)?)\s*(hrs?|hr|hours?|d(?:ays?)?|w(?:eeks?)?|m(?:onths?)?|y(?:ears?)?|mins?|minutes?)\b/iu.exec(input);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = UNIT_BY_TOKEN[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount) || !unit) {
    return undefined;
  }
  const local = DateTime.fromJSDate(now, { zone: timeZone });
  const future = unit === "minute" ? local.plus({ minutes: amount })
    : unit === "hour" ? local.plus({ hours: amount })
      : unit === "day" ? local.plus({ days: amount })
        : unit === "week" ? local.plus({ weeks: amount })
          : unit === "month" ? local.plus({ months: amount })
            : local.plus({ years: amount });
  return future.isValid ? future.toFormat("yyyy-LL-dd") : undefined;
}

/** Resolves a whole-hour or whole-minute delay to a safe local reminder time. */
export function resolveRelativeTime(
  input: string,
  now: Date,
  timeZone: string,
): { readonly date: string; readonly time: string } | undefined {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || !IANAZone.isValidZone(timeZone)) {
    return undefined;
  }
  const match = /\bin\s+(\d+)\s*(hrs?|hours?|mins?|minutes?)\b/iu.exec(input);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = UNIT_BY_TOKEN[match[2].toLowerCase()];
  if (!Number.isSafeInteger(amount) || amount <= 0 || (unit !== "hour" && unit !== "minute")) {
    return undefined;
  }
  const local = DateTime.fromJSDate(now, { zone: timeZone });
  const future = unit === "hour" ? local.plus({ hours: amount }) : local.plus({ minutes: amount });
  if (!future.isValid) {
    return undefined;
  }
  const rounded = future.second === 0 && future.millisecond === 0
    ? future
    : future.startOf("minute").plus({ minutes: 1 });
  return { date: rounded.toFormat("yyyy-LL-dd"), time: rounded.toFormat("HH:mm") };
}

export function resolveDateAnchor(input: string, now: Date, timeZone: string): DateAnchor | undefined {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || !IANAZone.isValidZone(timeZone)) {
    return undefined;
  }
  const localNow = DateTime.fromJSDate(now, { zone: timeZone }).startOf("day");
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(input);
  if (iso?.[1]) {
    const date = DateTime.fromFormat(iso[1], "yyyy-LL-dd", { zone: timeZone });
    if (!date.isValid || date.toFormat("yyyy-LL-dd") !== iso[1]) {
      return undefined;
    }
    return { dates: [iso[1]], hasConcreteDate: true, weekdays: [date.weekday] };
  }

  const relative = /\b(today|tomorrow)\b/iu.exec(input);
  if (relative?.[1]) {
    const date = localNow.plus({ days: relative[1].toLowerCase() === "tomorrow" ? 1 : 0 });
    return { dates: [date.toFormat("yyyy-LL-dd")], hasConcreteDate: true, weekdays: [date.weekday] };
  }

  const relativeDate = resolveRelativeDate(input, now, timeZone);
  if (relativeDate) {
    const date = DateTime.fromFormat(relativeDate, "yyyy-LL-dd", { zone: timeZone });
    return { dates: [relativeDate], hasConcreteDate: true, weekdays: [date.weekday] };
  }

  const found = [...input.matchAll(/\b(mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu)]
    .map((match) => WEEKDAY_BY_NAME[match[1]?.toLowerCase() ?? ""])
    .filter((weekday): weekday is number => weekday !== undefined);
  const weekdays = [...new Set(found)].sort((first, second) => first - second);
  if (weekdays.length === 0) {
    return undefined;
  }
  const dates = weekdays.map((weekday) => {
    const offset = (weekday - localNow.weekday + 7) % 7;
    return localNow.plus({ days: offset }).toFormat("yyyy-LL-dd");
  });
  return { dates, hasConcreteDate: false, weekdays };
}

export function parseRecurrence(input: string, anchor?: DateAnchor): ScheduleRecurrence | undefined {
  const normalized = normalizeTemporalAliases(input).toLowerCase();
  const everyOtherWeekday = /\bevery\s+other\s+(?:mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/iu.test(normalized);
  const everyOther = /\b(?:every\s+other|bi[-\s]?weekly)\s*(day|week|month|year|days|weeks|months|years)?\b/iu.exec(normalized);
  const explicit = /\bevery\s+(?:(\d+)\s+)?(day|week|month|year|days|weeks|months|years)\b/iu.exec(normalized);
  const named = /\b(daily|weekly|monthly|yearly)\b/iu.exec(normalized);
  const weeklyByDays = anchor?.weekdays.length && /\bevery\b/iu.test(normalized) && !explicit && !named;

  let frequency: RecurrenceFrequency | undefined;
  let interval = 1;
  if (everyOtherWeekday) {
    frequency = "weekly";
    interval = 2;
  } else if (everyOther) {
    frequency = toFrequency(everyOther[1] ?? "week");
    interval = 2;
  } else if (explicit) {
    frequency = toFrequency(explicit[2] ?? "");
    interval = Number(explicit[1] ?? "1");
  } else if (named) {
    frequency = toFrequency(named[1] ?? "");
  } else if (weeklyByDays) {
    frequency = "weekly";
  }
  if (!frequency || !Number.isInteger(interval) || interval < 1 || interval > 366) {
    return undefined;
  }
  return {
    frequency,
    interval,
    ...(frequency === "weekly" && anchor?.weekdays.length ? { weekdays: anchor.weekdays } : {}),
  };
}

export function formatRecurrence(recurrence: ScheduleRecurrence): string {
  const every = recurrence.interval === 1 ? "every" : `every ${recurrence.interval}`;
  const unit = recurrence.frequency === "daily" ? "day"
    : recurrence.frequency === "weekly" ? "week"
      : recurrence.frequency === "monthly" ? "month"
        : "year";
  return `${every} ${unit}${recurrence.interval === 1 ? "" : "s"}`;
}

function toFrequency(value: string): RecurrenceFrequency | undefined {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("day")) {
    return "daily";
  }
  if (normalized.startsWith("week")) {
    return "weekly";
  }
  if (normalized.startsWith("month")) {
    return "monthly";
  }
  if (normalized.startsWith("year")) {
    return "yearly";
  }
  return undefined;
}
