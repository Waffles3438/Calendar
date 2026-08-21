import { DateTime } from "luxon";

import type { LocalTaskSelector } from "./task-domain.js";
import { isValidTaskTimeZone, validateLocalTaskDateTime } from "./task-time.js";

export interface TaskParserContext {
  readonly now: Date;
  readonly timeZone: string;
}

export type TaskClarificationReason = "invalid_value" | "missing_required_detail" | "unsupported_intent";

export type ParsedTaskCommand =
  | { readonly kind: "cancel"; readonly selector: LocalTaskSelector }
  | { readonly date?: string; readonly kind: "cancel_all" }
  | { readonly date: string; readonly kind: "create"; readonly time: string; readonly title: string }
  | { readonly kind: "complete"; readonly selector: LocalTaskSelector }
  | { readonly date?: string; readonly kind: "list" }
  | { readonly kind: "not_task" }
  | { readonly kind: "recurrence_unsupported" }
  | { readonly kind: "clarify"; readonly message: string; readonly reason: TaskClarificationReason };

interface TextRange {
  readonly end: number;
  readonly start: number;
}

interface DateMatch {
  readonly date: string;
  readonly range: TextRange;
}

interface TimeMatch {
  readonly range: TextRange;
  readonly time: string;
}

type DateResolution = DateMatch | { readonly state: "invalid" | "missing" };

const MAX_TASK_TITLE_CHARACTERS = 160;
const WEEKDAYS: Readonly<Record<string, number>> = {
  friday: 5,
  monday: 1,
  saturday: 6,
  sunday: 7,
  thursday: 4,
  tuesday: 2,
  wednesday: 3,
};

const EVENT_REMINDER = /^remind\s+me\s+\d+\s*(?:minutes?|mins?)\s+before\b/iu;
const RELATIVE_REMINDER = /^in\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)$/iu;
const RECURRENCE_WORDS = /\b(?:every|each|daily|weekly|monthly|yearly)\b/iu;
const CALENDAR_CUES = /\b(?:calendar|event|meeting|appointment|schedule)\b/iu;
const NATURAL_TASK_LIST_QUERY = /^(?:what\s+do\s+i\s+(?:need|have)\s+to\s+do|what\s+should\s+i\s+do)\b/iu;
const GENERIC_SELECTOR_TERMS = new Set(["a", "an", "complete", "done", "task", "the", "to"]);
const LIST_DATE_PATTERN = /^(?:today|tomorrow|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})$/iu;
const LIST_COMMAND_PREFIX = /^(?:tasks?|list(?:\s+my)?\s+tasks?|show(?:\s+my)?\s+tasks?|(?:what|which)\s+(?:my\s+)?tasks?\s+do\s+i\s+have)(.*)$/iu;

/** Returns true only for input that is explicitly task-oriented, never calendar reminders. */
export function isTaskShapedInput(input: string): boolean {
  const text = normalizeInput(input);
  if (!text || EVENT_REMINDER.test(text)) {
    return false;
  }

  if (isTaskListSyntax(text)) {
    return true;
  }

  if (/^delete\s+all\s+tasks\b/iu.test(text)) {
    return true;
  }

  const explicitTaskCommand = /^(?:remind\s+me\b|(?:create|add)\s+(?:a\s+)?task\b|done\b|complete\b|(?:cancel|delete)\s+task\b|to[ -]?do\b)/iu.test(text);
  if (explicitTaskCommand) {
    return true;
  }

  // Route natural-language task questions to the task planner. The deterministic
  // parser intentionally leaves them unsupported so Gemini must interpret them.
  if (NATURAL_TASK_LIST_QUERY.test(text)) {
    return !CALENDAR_CUES.test(text);
  }

  // Preserve the existing Calendar fallback for requests that explicitly describe calendar work.
  return /\bremember\s+to\b/iu.test(text) && !CALENDAR_CUES.test(text);
}

export function parseDeterministicTaskCommand(
  input: string,
  context: TaskParserContext,
): ParsedTaskCommand {
  const text = normalizeInput(input);
  if (!text || !isTaskShapedInput(text)) {
    return { kind: "not_task" };
  }

  if (!isValidTaskTimeZone(context.timeZone) || !(context.now instanceof Date) || Number.isNaN(context.now.valueOf())) {
    return clarify("Please provide a valid current time and task time zone.", "invalid_value");
  }
  const now = DateTime.fromJSDate(context.now, { zone: context.timeZone });

  const listCommand = parseListCommand(text, now);
  if (listCommand) {
    return listCommand;
  }

  if (RECURRENCE_WORDS.test(text)) {
    return { kind: "recurrence_unsupported" };
  }

  if (/^(?:done|complete)\b/iu.test(text)) {
    return parseCompletionCommand(text, now);
  }

  if (/^delete\s+all\s+tasks\b/iu.test(text)) {
    return parseBulkCancellationCommand(text, now);
  }

  if (/^(?:cancel|delete)\s+task\b/iu.test(text)) {
    return parseCancellationCommand(text, now);
  }

  if (/^remind\s+me\b/iu.test(text)) {
    return parseReminderTask(text, now, context.timeZone);
  }

  if (/^(?:create|add)\s+(?:a\s+)?task\b/iu.test(text)) {
    const body = text.replace(/^(?:create|add)\s+(?:a\s+)?task\b\s*/iu, "");
    return parseCreateTaskBody(body, now, context.timeZone);
  }

  return clarify("I couldn't determine a local task command.", "unsupported_intent");
}

function parseListCommand(text: string, now: DateTime): ParsedTaskCommand | undefined {
  const suffix = taskListSuffix(text);
  if (suffix === undefined) {
    return undefined;
  }
  if (!suffix) {
    return { kind: "list" };
  }

  const resolvedDate = resolveDate(suffix, now);
  return "state" in resolvedDate
    ? clarifyForDate(resolvedDate)
    : { date: resolvedDate.date, kind: "list" };
}

function isTaskListSyntax(text: string): boolean {
  const suffix = taskListSuffix(text);
  return suffix !== undefined && (!suffix || LIST_DATE_PATTERN.test(suffix));
}

function taskListSuffix(text: string): string | undefined {
  const match = LIST_COMMAND_PREFIX.exec(text);
  if (!match) {
    return undefined;
  }

  return (match[1] ?? "")
    .trim()
    .replace(/\?$/u, "")
    .trim()
    .replace(/^(?:on|for)\s+/iu, "")
    .trim();
}

function parseReminderTask(text: string, now: DateTime, timeZone: string): ParsedTaskCommand {
  const body = text.replace(/^remind\s+me\s*/iu, "");
  const separator = /\s+to\s+(.+)$/iu.exec(body);
  if (!separator?.[1] || separator.index === undefined) {
    return clarify("Please say what to remind you to do after 'to'.");
  }

  const schedulingText = body.slice(0, separator.index);
  const title = cleanDescription(separator[1]);
  if (!title) {
    return clarify("Please specify a task title.");
  }

  const relativeMatch = RELATIVE_REMINDER.exec(schedulingText);
  if (relativeMatch) {
    return parseRelativeReminder(title, relativeMatch[1] ?? "", relativeMatch[2] ?? "", now, timeZone);
  }

  return parseScheduledTask(title, schedulingText, now, timeZone);
}

function parseRelativeReminder(
  title: string,
  amountText: string,
  unitText: string,
  now: DateTime,
  timeZone: string,
): ParsedTaskCommand {
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return clarify("Please specify a positive whole number of hours or minutes.", "invalid_value");
  }

  const dueAt = /^h/iu.test(unitText) ? now.plus({ hours: amount }) : now.plus({ minutes: amount });
  const roundedDueAt = dueAt.second === 0 && dueAt.millisecond === 0
    ? dueAt
    : dueAt.startOf("minute").plus({ minutes: 1 });
  return finalizeCreate(
    title,
    roundedDueAt.toFormat("yyyy-LL-dd"),
    roundedDueAt.toFormat("HH:mm"),
    now,
    timeZone,
  );
}

function parseCreateTaskBody(body: string, now: DateTime, timeZone: string): ParsedTaskCommand {
  const resolvedDate = resolveDate(body, now);
  if ("state" in resolvedDate) {
    return clarifyForDate(resolvedDate);
  }

  const time = findTimeAfterKeyword(body, "at") ?? findTimes(body)[0];
  if (!time) {
    return clarifyForTime(body);
  }

  const title = cleanDescription(removeRanges(body, [
    withLeadingKeyword(body, resolvedDate.range, "on"),
    withLeadingKeyword(body, time.range, "at"),
  ]));
  if (!title) {
    return clarify("Please specify a task title.");
  }

  return finalizeCreate(title, resolvedDate.date, time.time, now, timeZone);
}

function parseScheduledTask(
  title: string,
  schedulingText: string,
  now: DateTime,
  timeZone: string,
): ParsedTaskCommand {
  const resolvedDate = resolveDate(schedulingText, now);
  if ("state" in resolvedDate) {
    return clarifyForDate(resolvedDate);
  }

  const time = findTimeAfterKeyword(schedulingText, "at") ?? findTimes(schedulingText)[0];
  if (!time) {
    return clarifyForTime(schedulingText);
  }

  return finalizeCreate(title, resolvedDate.date, time.time, now, timeZone);
}

function finalizeCreate(
  title: string,
  date: string,
  time: string,
  now: DateTime,
  timeZone: string,
): ParsedTaskCommand {
  if (title.length > MAX_TASK_TITLE_CHARACTERS) {
    return clarify(`Please keep the task title to ${MAX_TASK_TITLE_CHARACTERS} characters or fewer.`, "invalid_value");
  }

  const validation = validateLocalTaskDateTime(date, time, timeZone);
  if (validation.kind === "nonexistent") {
    return clarify("That Toronto time does not exist because of the daylight-saving change. Choose another time.", "invalid_value");
  }
  if (validation.kind === "ambiguous") {
    return clarify("That Toronto time occurs twice because of the daylight-saving change. Choose a different time.", "invalid_value");
  }
  if (validation.kind !== "valid") {
    return clarify("Please provide a valid date and time.", "invalid_value");
  }
  if (validation.value <= now) {
    return clarify("Please choose a future task time.", "invalid_value");
  }

  return { date, kind: "create", time, title };
}

function parseCompletionCommand(text: string, now: DateTime): ParsedTaskCommand {
  const body = text
    .replace(/^done(?:\s+task)?\b\s*/iu, "")
    .replace(/^complete(?:\s+task)?\b\s*/iu, "");
  const selector = parseSelector(body, now);
  return "message" in selector ? clarify(selector.message) : { kind: "complete", selector: selector.selector };
}

function parseBulkCancellationCommand(text: string, now: DateTime): ParsedTaskCommand {
  const match = /^delete\s+all\s+tasks(?:\s+(?:for|on)\b(.*))?$/iu.exec(text);
  if (!match) {
    return clarify("Use 'delete all tasks' or 'delete all tasks for today'.", "invalid_value");
  }

  const scope = match[1]?.trim();
  if (scope === undefined) {
    return { kind: "cancel_all" };
  }
  if (!scope) {
    return clarify("Please specify a task date after 'for'.");
  }
  if (!LIST_DATE_PATTERN.test(scope)) {
    return clarify("Please provide a valid task date.", "invalid_value");
  }

  const resolvedDate = resolveDate(scope, now);
  return "state" in resolvedDate
    ? clarifyForDate(resolvedDate)
    : { date: resolvedDate.date, kind: "cancel_all" };
}

function parseCancellationCommand(text: string, now: DateTime): ParsedTaskCommand {
  const body = text.replace(/^(?:cancel|delete)\s+task\b\s*/iu, "");
  const selector = parseSelector(body, now);
  return "message" in selector ? clarify(selector.message) : { kind: "cancel", selector: selector.selector };
}

function parseSelector(
  text: string,
  now: DateTime,
): { readonly selector: LocalTaskSelector } | { readonly message: string } {
  const resolvedDate = resolveDate(text, now);
  if ("state" in resolvedDate && resolvedDate.state === "invalid") {
    return { message: "Please provide a valid task date." };
  }

  const title = cleanDescription(
    "state" in resolvedDate ? text : removeRanges(text, [withLeadingKeyword(text, resolvedDate.range, "on")]),
  );
  if (!title || !hasMeaningfulSelectorTerms(title)) {
    return { message: "Please specify the task to complete or cancel." };
  }
  if (title.length > MAX_TASK_TITLE_CHARACTERS) {
    return { message: `Please keep the task description to ${MAX_TASK_TITLE_CHARACTERS} characters or fewer.` };
  }

  return {
    selector: {
      ...("state" in resolvedDate ? {} : { date: resolvedDate.date }),
      title,
    },
  };
}

function resolveDate(text: string, now: DateTime): DateResolution {
  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text);
  if (isoMatch) {
    const dateText = isoMatch[1];
    if (!dateText) {
      return { state: "invalid" };
    }
    const parsed = DateTime.fromFormat(dateText, "yyyy-LL-dd", { setZone: true, zone: now.zoneName ?? "UTC" });
    if (!parsed.isValid || parsed.toFormat("yyyy-LL-dd") !== dateText) {
      return { state: "invalid" };
    }
    return { date: dateText, range: { end: isoMatch.index + dateText.length, start: isoMatch.index } };
  }

  const relativeMatch = /\b(today|tomorrow)\b/iu.exec(text);
  if (relativeMatch) {
    const offset = relativeMatch[1]?.toLowerCase() === "tomorrow" ? 1 : 0;
    return {
      date: now.startOf("day").plus({ days: offset }).toFormat("yyyy-LL-dd"),
      range: { end: relativeMatch.index + relativeMatch[0].length, start: relativeMatch.index },
    };
  }

  const weekdayMatch = /\b(?:(next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.exec(text);
  if (!weekdayMatch) {
    return { state: "missing" };
  }
  const weekday = weekdayMatch[2]?.toLowerCase();
  const target = weekday ? WEEKDAYS[weekday] : undefined;
  if (target === undefined) {
    return { state: "missing" };
  }
  const baseOffset = (target - now.weekday + 7) % 7;
  const offset = weekdayMatch[1] ? baseOffset + 7 : baseOffset;
  return {
    date: now.startOf("day").plus({ days: offset }).toFormat("yyyy-LL-dd"),
    range: { end: weekdayMatch.index + weekdayMatch[0].length, start: weekdayMatch.index },
  };
}

function findTimes(text: string): readonly TimeMatch[] {
  const matches: TimeMatch[] = [];
  const expression = /\b(?:noon|midnight|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d)(?![a-z])/giu;
  for (const match of text.matchAll(expression)) {
    const token = match[0];
    const time = token ? parseClock(token) : undefined;
    if (time && match.index !== undefined) {
      matches.push({ range: { end: match.index + token.length, start: match.index }, time });
    }
  }
  return matches;
}

function findTimeAfterKeyword(text: string, keyword: string): TimeMatch | undefined {
  const expression = new RegExp(`\\b${keyword}\\s+`, "iu");
  const keywordMatch = expression.exec(text);
  if (!keywordMatch || keywordMatch.index === undefined) {
    return undefined;
  }
  return findTimes(text.slice(keywordMatch.index + keywordMatch[0].length))[0] && (() => {
    const candidate = findTimes(text.slice(keywordMatch.index + keywordMatch[0].length))[0];
    if (!candidate) {
      return undefined;
    }
    const start = keywordMatch.index + keywordMatch[0].length + candidate.range.start;
    return { range: { end: start + (candidate.range.end - candidate.range.start), start }, time: candidate.time };
  })();
}

function parseClock(token: string): string | undefined {
  const normalized = token.toLowerCase().replace(/\./gu, "").replace(/\s+/gu, "");
  if (normalized === "noon") {
    return "12:00";
  }
  if (normalized === "midnight") {
    return "00:00";
  }

  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/u.exec(normalized);
  if (twelveHour) {
    const hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) {
      return undefined;
    }
    const converted = (hour % 12) + (twelveHour[3] === "pm" ? 12 : 0);
    return `${String(converted).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const twentyFourHour = /^(\d{1,2}):(\d{2})$/u.exec(normalized);
  if (!twentyFourHour) {
    return undefined;
  }
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clarifyForDate(resolution: Extract<DateResolution, { readonly state: string }>): ParsedTaskCommand {
  return resolution.state === "invalid"
    ? clarify("Please provide a valid task date.", "invalid_value")
    : clarify("Please specify a task date, such as tomorrow or 2026-08-18.");
}

function clarifyForTime(text: string): ParsedTaskCommand {
  return /\bat\b/iu.test(text)
    ? clarify("Please provide a valid task time.", "invalid_value")
    : clarify("Please specify a task time.");
}

function clarify(message: string, reason: TaskClarificationReason = "missing_required_detail"): ParsedTaskCommand {
  return { kind: "clarify", message, reason };
}

function withLeadingKeyword(text: string, range: TextRange, keyword: string): TextRange {
  const before = text.slice(0, range.start);
  const match = new RegExp(`\\b${keyword}\\s*$`, "iu").exec(before);
  return match?.index === undefined ? range : { end: range.end, start: match.index };
}

function removeRanges(text: string, ranges: readonly TextRange[]): string {
  const uniqueRanges = [...ranges]
    .sort((first, second) => second.start - first.start)
    .filter((range, index, all) => index === 0 || range.end <= all[index - 1]!.start);
  let remaining = text;
  for (const range of uniqueRanges) {
    remaining = `${remaining.slice(0, range.start)} ${remaining.slice(range.end)}`;
  }
  return remaining;
}

function hasMeaningfulSelectorTerms(value: string): boolean {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((term) => term.length > 0 && !GENERIC_SELECTOR_TERMS.has(term));
}

function cleanDescription(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^(?:the|a|an)\s+/iu, "")
    .replace(/[.!?,;:]+$/u, "")
    .trim();
}

function normalizeInput(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export { MAX_TASK_TITLE_CHARACTERS };
