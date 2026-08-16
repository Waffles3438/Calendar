import { DateTime } from "luxon";

import type { RecurrenceScope } from "../domain/calendar.js";

export interface ParserContext {
  readonly now: Date;
  readonly timeZone: string;
}

export interface EventQuery {
  readonly date?: string;
  readonly summary?: string;
  readonly time?: string;
}

export interface AttendeeChange {
  readonly action: "add" | "remove";
  readonly emails: readonly string[];
}

export type ClarificationReason = "invalid_value" | "missing_required_detail" | "unsupported_intent";

export type ParsedCalendarCommand =
  | { readonly kind: "list"; readonly date: string }
  | {
    readonly kind: "create";
    readonly date: string;
    readonly durationMinutes: number;
    readonly startTime: string;
    readonly title: string;
  }
  | {
    readonly kind: "update";
    readonly newStartTime: string;
    readonly recurrenceScope?: RecurrenceScope;
    readonly selector: EventQuery;
  }
  | { readonly kind: "delete"; readonly recurrenceScope?: RecurrenceScope; readonly selector: EventQuery }
  | {
    readonly kind: "manage_attendees";
    readonly change: AttendeeChange;
    readonly recurrenceScope?: RecurrenceScope;
    readonly selector: EventQuery;
  }
  | { readonly kind: "set_reminder"; readonly minutesBefore: number; readonly selector: EventQuery }
  | { readonly kind: "clarify"; readonly message: string; readonly reason: ClarificationReason };

interface TextRange {
  readonly end: number;
  readonly start: number;
}

interface DateMatch {
  readonly date: string;
  readonly range: TextRange;
}

type DateResolution = DateMatch | { readonly state: "invalid" | "missing" };

interface TimeMatch {
  readonly range: TextRange;
  readonly time: string;
}

interface RecurrenceScopeMatch {
  readonly range: TextRange;
  readonly scope: RecurrenceScope;
}

type DurationResolution =
  | { readonly state: "none" | "invalid" }
  | { readonly state: "valid"; readonly minutes: number; readonly range: TextRange };

type SelectorResolution = { readonly selector: EventQuery } | { readonly message: string };

const WEEKDAYS: Readonly<Record<string, number>> = {
  friday: 5,
  monday: 1,
  saturday: 6,
  sunday: 7,
  thursday: 4,
  tuesday: 2,
  wednesday: 3,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function parseDeterministicCommand(
  input: string,
  context: ParserContext,
): ParsedCalendarCommand {
  const now = DateTime.fromJSDate(context.now, { zone: context.timeZone });
  if (!now.isValid) {
    return clarify("Please provide a valid current time and time zone.");
  }

  const text = normalizeInput(input);
  if (!text) {
    return clarify("Please specify a calendar command.");
  }

  if (isListCommand(text)) {
    return parseListCommand(text, now);
  }

  if (/^(?:change|move|reschedule|update)\b/iu.test(text)) {
    return parseUpdateCommand(stripCommandPrefix(text, /^(?:change|move|reschedule|update)\b\s*/iu), now);
  }

  if (
    /^invite\b/iu.test(text) ||
    /^remove\b.*\bfrom\b/iu.test(text) ||
    /^add\b(?=.*@)(?=.*\bto\b)/iu.test(text)
  ) {
    return parseAttendeeCommand(text, now);
  }

  if (/^(?:delete|remove|cancel)\b/iu.test(text)) {
    return parseDeleteCommand(stripCommandPrefix(text, /^(?:delete|remove|cancel)\b\s*/iu), now);
  }

  if (/^remind\s+me\b/iu.test(text)) {
    return parseReminderCommand(text, now);
  }

  if (/^(?:schedule|create|add)\b/iu.test(text)) {
    return parseCreateCommand(stripCommandPrefix(text, /^(?:schedule|create|add)\b\s*/iu), now);
  }

  return clarify("I couldn't determine a calendar command.", "unsupported_intent");
}

function parseListCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const resolvedDate = resolveDate(text, now);
  if ("state" in resolvedDate) {
    return clarifyForDate(resolvedDate);
  }

  return { kind: "list", date: resolvedDate.date };
}

function parseCreateCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const resolvedDate = resolveDate(text, now);
  if ("state" in resolvedDate) {
    return clarifyForDate(resolvedDate);
  }

  const duration = resolveDuration(text);
  if (duration.state === "invalid") {
    return clarify("Please specify a positive duration.");
  }

  const startTime = findTimeAfterKeyword(text, "at") ?? findTimes(text)[0];
  if (!startTime) {
    return clarify("Please specify a start time.");
  }

  const ranges = [
    withLeadingKeyword(text, resolvedDate.range, "on"),
    withLeadingKeyword(text, startTime.range, "at"),
  ];
  if (duration.state === "valid") {
    ranges.push(duration.range);
  }

  const title = cleanDescription(removeRanges(text, ranges));
  if (!title) {
    return clarify("Please specify an event title.");
  }

  return {
    kind: "create",
    date: resolvedDate.date,
    durationMinutes: duration.state === "valid" ? duration.minutes : 60,
    startTime: startTime.time,
    title,
  };
}

function parseUpdateCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const newStartTime = findTimeAfterKeyword(text, "to");
  if (!newStartTime) {
    return clarify("Please specify the new start time.");
  }

  const scope = findRecurrenceScope(text);
  const destinationRange = withLeadingKeyword(text, newStartTime.range, "to");
  const selector = resolveSelector(text, now, [
    destinationRange,
    ...(scope ? [scope.range] : []),
  ]);
  if ("message" in selector) {
    return clarify(selector.message);
  }

  return {
    kind: "update",
    newStartTime: newStartTime.time,
    ...(scope ? { recurrenceScope: scope.scope } : {}),
    selector: selector.selector,
  };
}

function parseDeleteCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const scope = findRecurrenceScope(text);
  const selector = resolveSelector(text, now, scope ? [scope.range] : []);
  if ("message" in selector) {
    return clarify(selector.message);
  }

  return {
    kind: "delete",
    ...(scope ? { recurrenceScope: scope.scope } : {}),
    selector: selector.selector,
  };
}

function parseAttendeeCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const match = /^(add|invite|remove)\s+(.+?)\s+(to|from)\s+(.+)$/iu.exec(text);
  if (!match) {
    return clarify("Please specify email addresses and the event to update.");
  }

  const verb = match[1]?.toLowerCase();
  const preposition = match[3]?.toLowerCase();
  const emails = parseEmails(match[2] ?? "");
  const selectorText = match[4] ?? "";
  if (!verb || !preposition || emails.length === 0) {
    return clarify("Please provide one or more valid attendee email addresses.");
  }
  if ((verb === "remove" && preposition !== "from") || (verb !== "remove" && preposition !== "to")) {
    return clarify("Use 'add … to' or 'remove … from' an event.");
  }

  const scope = findRecurrenceScope(selectorText);
  const selector = resolveSelector(selectorText, now, scope ? [scope.range] : []);
  if ("message" in selector) {
    return clarify(selector.message);
  }

  return {
    kind: "manage_attendees",
    change: { action: verb === "remove" ? "remove" : "add", emails },
    ...(scope ? { recurrenceScope: scope.scope } : {}),
    selector: selector.selector,
  };
}

function parseReminderCommand(text: string, now: DateTime): ParsedCalendarCommand {
  const match = /^remind\s+me\s+(\d+)\s*(?:minutes?|mins?)\s+before\s+(.+)$/iu.exec(text);
  if (!match) {
    return clarify("Please specify reminder minutes and an event.");
  }

  const minutesBefore = Number(match[1] ?? "");
  if (!Number.isSafeInteger(minutesBefore) || minutesBefore <= 0) {
    return clarify("Please specify positive reminder minutes.");
  }

  const selector = resolveSelector(match[2] ?? "", now);
  if ("message" in selector) {
    return clarify(selector.message);
  }

  return {
    kind: "set_reminder",
    minutesBefore,
    selector: selector.selector,
  };
}

function parseEmails(value: string): readonly string[] {
  const candidates = value
    .split(/\s*(?:,|\band\b)\s*/iu)
    .map((candidate) => candidate.trim().toLowerCase())
    .filter(Boolean);
  if (candidates.length === 0 || candidates.some((candidate) => !EMAIL.test(candidate))) {
    return [];
  }
  return [...new Set(candidates)];
}

function findRecurrenceScope(text: string): RecurrenceScopeMatch | undefined {
  const definitions: readonly { readonly expression: RegExp; readonly scope: RecurrenceScope }[] = [
    {
      expression: /\b(?:this\s+(?:occurrence|instance|event)|only\s+this\s+(?:one|occurrence))\b/iu,
      scope: "this_instance",
    },
    {
      expression: /\b(?:whole|entire)\s+series\b|\ball\s+occurrences\b/iu,
      scope: "series",
    },
    {
      expression: /\b(?:all\s+future(?:\s+occurrences)?|this\s+and\s+following|future\s+occurrences)\b/iu,
      scope: "all_future",
    },
  ];

  for (const definition of definitions) {
    const match = definition.expression.exec(text);
    if (match && match.index !== undefined) {
      return {
        range: { start: match.index, end: match.index + match[0].length },
        scope: definition.scope,
      };
    }
  }
  return undefined;
}

function resolveSelector(
  text: string,
  now: DateTime,
  excludedRanges: readonly TextRange[] = [],
): SelectorResolution {
  const resolvedDate = resolveDate(text, now);
  if ("state" in resolvedDate) {
    return {
      message:
        resolvedDate.state === "invalid"
          ? "Please provide a valid date."
          : "Please specify a date.",
    };
  }

  const time = findTimes(text).find(
    (candidate) => !excludedRanges.some((range) => rangesOverlap(candidate.range, range)),
  );
  const ranges: TextRange[] = [
    ...excludedRanges,
    withLeadingKeyword(text, resolvedDate.range, "on"),
  ];
  if (time) {
    ranges.push(withLeadingKeyword(text, time.range, "at"));
  }

  const summary = cleanDescription(removeRanges(text, ranges));
  if (!time && !summary) {
    return { message: "Please specify the event title or time." };
  }

  const selector: { date?: string; summary?: string; time?: string } = {
    date: resolvedDate.date,
  };
  if (summary) {
    selector.summary = summary;
  }
  if (time) {
    selector.time = time.time;
  }

  return { selector };
}

function resolveDate(text: string, now: DateTime): DateResolution {
  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text);
  if (isoMatch) {
    const dateText = isoMatch[1];
    if (!dateText) {
      return { state: "invalid" };
    }

    const parsedDate = DateTime.fromISO(dateText, { zone: now.zoneName ?? "UTC" });
    if (!parsedDate.isValid) {
      return { state: "invalid" };
    }

    return {
      date: parsedDate.toFormat("yyyy-LL-dd"),
      range: { start: isoMatch.index, end: isoMatch.index + dateText.length },
    };
  }

  const relativeMatch = /\b(today|tomorrow)\b/iu.exec(text);
  if (relativeMatch) {
    const relative = relativeMatch[1]?.toLowerCase();
    const offset = relative === "tomorrow" ? 1 : 0;
    return {
      date: now.startOf("day").plus({ days: offset }).toFormat("yyyy-LL-dd"),
      range: { start: relativeMatch.index, end: relativeMatch.index + relativeMatch[0].length },
    };
  }

  const weekdayMatch =
    /\b(?:(next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.exec(text);
  if (!weekdayMatch) {
    return { state: "missing" };
  }

  const weekdayName = weekdayMatch[2]?.toLowerCase();
  const targetWeekday = weekdayName ? WEEKDAYS[weekdayName] : undefined;
  if (targetWeekday === undefined) {
    return { state: "missing" };
  }

  const daysUntilWeekday = (targetWeekday - now.weekday + 7) % 7;
  const offset = weekdayMatch[1] ? daysUntilWeekday + 7 : daysUntilWeekday;
  return {
    date: now.startOf("day").plus({ days: offset }).toFormat("yyyy-LL-dd"),
    range: { start: weekdayMatch.index, end: weekdayMatch.index + weekdayMatch[0].length },
  };
}

function resolveDuration(text: string): DurationResolution {
  const numericMatch =
    /\bfor\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/iu.exec(text);
  if (numericMatch) {
    const amount = Number(numericMatch[1] ?? "");
    const unit = (numericMatch[2] ?? "").toLowerCase();
    const minutes = amount * (unit.startsWith("h") ? 60 : 1);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes <= 0) {
      return { state: "invalid" };
    }

    return {
      state: "valid",
      minutes,
      range: {
        start: numericMatch.index,
        end: numericMatch.index + numericMatch[0].length,
      },
    };
  }

  const verbalMatch = /\bfor\s+(?:an?|one)\s+hour\b/iu.exec(text);
  if (verbalMatch) {
    return {
      state: "valid",
      minutes: 60,
      range: { start: verbalMatch.index, end: verbalMatch.index + verbalMatch[0].length },
    };
  }

  if (/\bfor\s+\S+\s*(?:minutes?|mins?|hours?|hrs?)\b/iu.test(text)) {
    return { state: "invalid" };
  }

  return { state: "none" };
}

function findTimes(text: string): readonly TimeMatch[] {
  const matches: TimeMatch[] = [];
  const expression =
    /\b(?:noon|midnight|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d)(?![a-z])/giu;

  for (const match of text.matchAll(expression)) {
    const token = match[0];
    const time = token ? parseClock(token) : undefined;
    if (time) {
      matches.push({
        range: { start: match.index, end: match.index + token.length },
        time,
      });
    }
  }

  return matches;
}

function findTimeAfterKeyword(text: string, keyword: string): TimeMatch | undefined {
  const keywordBeforeTime = new RegExp(`\\b${keyword}\\s*$`, "iu");
  return findTimes(text).find((time) => keywordBeforeTime.test(text.slice(0, time.range.start)));
}

function parseClock(token: string): string | undefined {
  const compact = token.toLowerCase().replace(/[.\s]/gu, "");
  if (compact === "noon") {
    return "12:00";
  }
  if (compact === "midnight") {
    return "00:00";
  }

  const twelveHour = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/u.exec(compact);
  if (twelveHour) {
    const hour = Number(twelveHour[1] ?? "");
    const minute = Number(twelveHour[2] ?? "0");
    const period = twelveHour[3];
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || !period) {
      return undefined;
    }

    const normalizedHour = period === "am" ? hour % 12 : (hour % 12) + 12;
    return formatTime(normalizedHour, minute);
  }

  const twentyFourHour = /^(\d{1,2}):(\d{2})$/u.exec(compact);
  if (!twentyFourHour) {
    return undefined;
  }

  const hour = Number(twentyFourHour[1] ?? "");
  const minute = Number(twentyFourHour[2] ?? "");
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return undefined;
  }

  return formatTime(hour, minute);
}

function formatTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function isListCommand(text: string): boolean {
  return /^(?:what\s+(?:do\s+)?i\s+have\b|what(?:'s|\s+is)\s+(?:on\s+)?|(?:show|list)\b)/iu.test(
    text,
  );
}

function stripCommandPrefix(text: string, expression: RegExp): string {
  return text.replace(expression, "").trim();
}

function normalizeInput(input: string): string {
  return input.trim().replace(/\s+/gu, " ");
}

function clarifyForDate(resolution: Extract<DateResolution, { readonly state: string }>): ParsedCalendarCommand {
  return clarify(
    resolution.state === "invalid" ? "Please provide a valid date." : "Please specify a date.",
  );
}

function clarify(
  message: string,
  reason: ClarificationReason = /\b(?:positive|valid)\b|^Use /u.test(message)
    ? "invalid_value"
    : "missing_required_detail",
): ParsedCalendarCommand {
  return { kind: "clarify", message, reason };
}

function withLeadingKeyword(text: string, range: TextRange, keyword: string): TextRange {
  const leadingKeyword = new RegExp(`\\b${keyword}\\s*$`, "iu").exec(text.slice(0, range.start));
  if (!leadingKeyword) {
    return range;
  }

  return { start: leadingKeyword.index, end: range.end };
}

function rangesOverlap(first: TextRange, second: TextRange): boolean {
  return first.start < second.end && second.start < first.end;
}

function removeRanges(text: string, ranges: readonly TextRange[]): string {
  const sortedRanges = [...ranges].sort(
    (first, second) => first.start - second.start || first.end - second.end,
  );
  let cursor = 0;
  let remainingText = "";

  for (const range of sortedRanges) {
    if (range.end <= cursor) {
      continue;
    }
    if (range.start > cursor) {
      remainingText += text.slice(cursor, range.start);
    }
    cursor = Math.max(cursor, range.end);
  }

  return remainingText + text.slice(cursor);
}

function cleanDescription(text: string): string {
  let description = text.replace(/\s+/gu, " ").trim();
  description = description.replace(/^[,;:—–-]+\s*/u, "").replace(/\s*[,;:.?!]+$/u, "").trim();
  description = description.replace(/^(?:the|an|a)\s+/iu, "");
  return description.replace(/\s+(?:on|at|to|for)$/iu, "").trim();
}
