import { DateTime, IANAZone } from "luxon";

import type { ScheduleKind, ScheduleRecurrence } from "./schedule-domain.js";
import {
  normalizeTemporalAliases,
  parseDurationToken,
  parseRecurrence,
  resolveDateAnchor,
  resolveRelativeTime,
  type DateAnchor,
} from "./temporal.js";

export interface ScheduleParserContext {
  readonly now: Date;
  readonly timeZone: string;
}

export type CleanupTargetKind = ScheduleKind | "event";
export type CleanupMode = "bulk" | "named" | "reviewed";

interface CleanupCommand {
  readonly date?: string;
  readonly kind: "cleanup";
  readonly mode: CleanupMode;
  readonly targetKinds: readonly CleanupTargetKind[];
  readonly terms: readonly string[];
  readonly title: string;
}

export type ParsedScheduleCommand =
  | { readonly date: string; readonly endDate: string; readonly kind: "agenda"; readonly range: "day" | "week" }
  | {
    readonly calendarName?: string;
    readonly date: string;
    /** Present only when a duration crosses into the next local date. */
    readonly endDate?: string;
    readonly endTime: string;
    readonly kind: "event";
    readonly recurrence?: ScheduleRecurrence;
    readonly startTime: string;
    readonly title: string;
  }
  | CleanupCommand
  | {
    readonly date: string;
    readonly kind: "local";
    readonly recurrence?: ScheduleRecurrence;
    readonly scheduleKind: ScheduleKind;
    readonly startTime?: string;
    readonly title: string;
  }
  | { readonly kind: "clarify"; readonly message: string }
  | { readonly kind: "unsupported" };

export type ExecutableScheduleCommand = Exclude<ParsedScheduleCommand, { readonly kind: "clarify" | "unsupported" }>;

interface TimeMatch {
  readonly end: number;
  readonly start: number;
  readonly time: string;
}

interface DateTimeParts {
  readonly date: string;
  readonly time: string;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_EXPRESSION = /\b(?:noon|midnight|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d)(?![a-z])/giu;
const CLEANUP_WORDS = new Set(["a", "all", "an", "class", "classes", "ended", "event", "events", "for", "future", "my", "on", "reminder", "reminders", "schedule", "schedules", "task", "tasks", "the", "today", "tomorrow"]);
const ALL_CLEANUP_TARGET_KINDS: readonly CleanupTargetKind[] = ["task", "reminder", "event"];
const CLEANUP_DATE_SUFFIX = /\s+(today|tomorrow|\d{4}-\d{2}-\d{2}|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*$/iu;
const MANUAL_FIELDS = new Set(["calendar", "create", "date", "duration", "endtime", "recurrence", "starttime", "title"]);

/** Parses known scheduling language without sending the text to a hosted model. */
export function parseScheduleCommand(input: string, context: ScheduleParserContext): ParsedScheduleCommand {
  if (!(context.now instanceof Date) || Number.isNaN(context.now.valueOf()) || !IANAZone.isValidZone(context.timeZone)) {
    return { kind: "clarify", message: "Please provide a valid current time and local time zone." };
  }
  const raw = input.trim();
  if (!raw) {
    return { kind: "unsupported" };
  }
  if (/^create\s*:/imu.test(raw)) {
    return parseManualCorrection(raw, context);
  }
  const text = normalizeTemporalAliases(raw).replace(/\s+/gu, " ").trim();
  if (!text) {
    return { kind: "unsupported" };
  }

  const agenda = parseAgenda(text, context);
  if (agenda) {
    return agenda;
  }
  const cleanup = parseCleanup(text, context);
  if (cleanup) {
    return cleanup;
  }
  return parseCreation(text, context);
}

/** Validates a decrypted cache entry before it can reach the execution path. */
export function isExecutableScheduleCommand(value: unknown): value is ExecutableScheduleCommand {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "agenda") {
    return hasOnlyKeys(value, ["date", "endDate", "kind", "range"]) &&
      validAgendaRange(value.date, value.endDate, value.range);
  }
  if (value.kind === "cleanup") {
    return hasOnlyKeys(value, ["date", "kind", "mode", "targetKinds", "terms", "title"]) &&
      validTitle(value.title) && validCleanupMode(value.mode) && validCleanupTargetKinds(value.targetKinds) &&
      (value.date === undefined || validDate(value.date)) &&
      Array.isArray(value.terms) &&
      value.terms.every((term) => typeof term === "string" && term.trim().length > 0 && term.length <= 160) &&
      (value.mode === "bulk" ? value.terms.length === 0 : value.terms.length > 0);
  }
  if (value.kind === "local") {
    return hasOnlyKeys(value, ["date", "kind", "recurrence", "scheduleKind", "startTime", "title"]) &&
      validDate(value.date) && validTitle(value.title) &&
      (value.scheduleKind === "task" || value.scheduleKind === "reminder") &&
      validOptionalRecurrence(value.recurrence) &&
      (value.scheduleKind === "task" ? value.startTime === undefined : typeof value.startTime === "string" && validTime(value.startTime));
  }
  if (value.kind === "event") {
    return hasOnlyKeys(value, ["calendarName", "date", "endDate", "endTime", "kind", "recurrence", "startTime", "title"]) &&
      validDate(value.date) && validTitle(value.title) && validTime(value.startTime) && validTime(value.endTime) &&
      (value.endDate === undefined || typeof value.endDate === "string" && validDate(value.endDate) && value.endDate >= value.date) &&
      (value.calendarName === undefined || typeof value.calendarName === "string" && validTitle(value.calendarName)) &&
      validOptionalRecurrence(value.recurrence);
  }
  return false;
}

function parseAgenda(text: string, context: ScheduleParserContext): ParsedScheduleCommand | undefined {
  const normalized = text.toLocaleLowerCase();
  const agendaCue = /^(?:what\s+(?:do\s+i\s+(?:need|have)\s+to\s+do|needs?\s+to\s+get\s+done)|what\s+does\b|show\s+(?:me\s+)?(?:my\s+)?(?:day|agenda)|(?:my\s+)?agenda\b)/iu;
  if (!agendaCue.test(normalized)) {
    return undefined;
  }
  const now = DateTime.fromJSDate(context.now, { zone: context.timeZone });
  if (/\bthis\s+week\b/iu.test(normalized)) {
    const date = now.startOf("week").toFormat("yyyy-LL-dd");
    return { date, endDate: now.endOf("week").toFormat("yyyy-LL-dd"), kind: "agenda", range: "week" };
  }
  const anchor = resolveDateAnchor(normalized, context.now, context.timeZone);
  if (!anchor) {
    return { kind: "clarify", message: "Please specify a date such as today, this week, or Monday." };
  }
  if (anchor.dates.length !== 1) {
    return { kind: "clarify", message: "Please specify one agenda date." };
  }
  const date = anchor.dates[0];
  if (!date) {
    return { kind: "clarify", message: "Please specify a valid agenda date." };
  }
  return { date, endDate: date, kind: "agenda", range: "day" };
}

function parseCleanup(text: string, context: ScheduleParserContext): ParsedScheduleCommand | undefined {
  const ended = /^(?:my\s+)?(.+?)\s+(?:is|are\s+)?ended[.!?]*$/iu.exec(text.trim());
  const explicit = /^(?:delete|cancel|remove)\s+(.+?)[.!?]*$/iu.exec(text.trim());
  const rawTitle = ended?.[1] ?? explicit?.[1];
  if (!rawTitle) {
    return undefined;
  }

  if (explicit) {
    const structured = parseStructuredCleanup(rawTitle, context);
    if (structured) {
      return structured;
    }
  }
  if (explicit && !/\b(?:all|future|tasks|reminders|events|schedules|related\s+to)\b/iu.test(rawTitle)) {
    return undefined;
  }
  return parseReviewedCleanup(rawTitle);
}

function parseStructuredCleanup(rawTitle: string, context: ScheduleParserContext): ParsedScheduleCommand | undefined {
  const trimmed = rawTitle.trim();
  const scopedBulk = /^(.*?)\s+(?:for|on)\s+(.+)$/iu.exec(trimmed);
  const bulkTitle = scopedBulk?.[1]?.trim() ?? trimmed;
  const targetKinds = bulkCleanupTargetKinds(bulkTitle);
  if (targetKinds) {
    const date = scopedBulk?.[2] ? resolveCleanupDate(scopedBulk[2], context) : undefined;
    if (scopedBulk?.[2] && !date) {
      return { kind: "clarify", message: "Please specify one date such as today, tomorrow, or 2026-08-18." };
    }
    return cleanupCommand({
      ...(date ? { date } : {}),
      mode: "bulk",
      targetKinds,
      title: date ? `${bulkTitle} for ${scopedBulk?.[2]?.trim() ?? "that date"}` : bulkTitle,
    });
  }

  const named = /^(?:the\s+)?(task|reminder|event)\b\s*(.*)$/iu.exec(trimmed);
  if (!named?.[1]) {
    return undefined;
  }
  const targetKind = cleanupTargetKind(named[1]);
  const scope = parseNamedCleanupScope(named[2] ?? "", context);
  if (!targetKind || !scope || !validTitle(scope.title)) {
    return { kind: "clarify", message: "Please provide the name of the task, reminder, or event to delete." };
  }
  const terms = cleanupTerms(scope.title);
  if (terms.length === 0) {
    return { kind: "clarify", message: "Please provide the name of the task, reminder, or event to delete." };
  }
  return cleanupCommand({
    ...(scope.date ? { date: scope.date } : {}),
    mode: "named",
    targetKinds: [targetKind],
    terms,
    title: scope.title,
  });
}

function parseReviewedCleanup(rawTitle: string): ParsedScheduleCommand {
  let title = rawTitle
    .replace(/^(?:all\s+)?(?:future\s+)?/iu, "")
    .replace(/^related\s+to\s+/iu, "")
    .replace(/^(?:the\s+)?/iu, "")
    .trim();
  let targetKinds = ALL_CLEANUP_TARGET_KINDS;
  const trailingKind = /\b(tasks?|reminders?|events?)\s*$/iu.exec(title);
  if (trailingKind?.[1]) {
    const targetKind = cleanupTargetKind(trailingKind[1]);
    if (targetKind && trailingKind.index !== undefined) {
      targetKinds = [targetKind];
      title = title.slice(0, trailingKind.index).trim();
    }
  }
  const terms = cleanupTerms(title);
  if (!validTitle(title) || terms.length === 0) {
    return { kind: "clarify", message: "Please say what future tasks, reminders, or events ended." };
  }
  return cleanupCommand({ mode: "reviewed", targetKinds, terms, title });
}

function cleanupCommand(input: Omit<CleanupCommand, "kind" | "terms"> & { readonly terms?: readonly string[] }): CleanupCommand {
  return { kind: "cleanup", terms: input.terms ?? [], ...input };
}

function parseNamedCleanupScope(value: string, context: ScheduleParserContext): { readonly date?: string; readonly title: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const explicitDate = /^(.*?)\s+(?:for|on)\s+(.+)$/iu.exec(trimmed);
  if (explicitDate?.[1] && explicitDate[2]) {
    const date = resolveCleanupDate(explicitDate[2], context);
    if (date) {
      return { date, title: explicitDate[1].trim() };
    }
  }
  const bareDate = CLEANUP_DATE_SUFFIX.exec(trimmed);
  if (bareDate?.[1] && bareDate.index !== undefined) {
    const date = resolveCleanupDate(bareDate[1], context);
    const title = trimmed.slice(0, bareDate.index).trim();
    if (date && title) {
      return { date, title };
    }
  }
  return { title: trimmed };
}

function resolveCleanupDate(value: string, context: ScheduleParserContext): string | undefined {
  const anchor = resolveDateAnchor(value, context.now, context.timeZone);
  return anchor?.dates.length === 1 ? anchor.dates[0] : undefined;
}

function cleanupTerms(value: string): readonly string[] {
  return [...new Set(value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !CLEANUP_WORDS.has(term)))];
}

function bulkCleanupTargetKinds(value: string): readonly CleanupTargetKind[] | undefined {
  const all = /^all\s+(.+)$/iu.exec(value.trim());
  const requested = all?.[1]?.trim().toLocaleLowerCase();
  if (!requested) {
    return undefined;
  }
  if (/^(?:everything|scheduled(?:\s+items?)?|schedules?)$/iu.test(requested)) {
    return ALL_CLEANUP_TARGET_KINDS;
  }
  const targetKinds = requested
    .replace(/\s+and\s+/giu, "|")
    .replace(/\s*[/,&]\s*/gu, "|")
    .split("|")
    .map(cleanupTargetKind);
  return targetKinds.length > 0 && targetKinds.every((kind): kind is CleanupTargetKind => kind !== undefined)
    ? [...new Set(targetKinds)]
    : undefined;
}

function cleanupTargetKind(value: string): CleanupTargetKind | undefined {
  const singular = value.trim().toLocaleLowerCase().replace(/s$/u, "");
  return singular === "task" || singular === "reminder" || singular === "event" ? singular : undefined;
}

function validCleanupMode(value: unknown): value is CleanupMode {
  return value === "bulk" || value === "named" || value === "reviewed";
}

function validCleanupTargetKinds(value: unknown): value is readonly CleanupTargetKind[] {
  return Array.isArray(value) && value.length > 0 && value.length <= ALL_CLEANUP_TARGET_KINDS.length &&
    new Set(value).size === value.length && value.every((kind) => cleanupTargetKind(String(kind)) === kind);
}

function parseCreation(text: string, context: ScheduleParserContext): ParsedScheduleCommand {
  const lower = text.toLocaleLowerCase();
  if (isLegacyCalendarPhrase(lower) || isLegacyRelativeReminderPhrase(lower) || isLegacyTaskPhrase(lower)) {
    return { kind: "unsupported" };
  }
  if (!hasCreationCue(lower)) {
    return { kind: "unsupported" };
  }

  const anchor = resolveDateAnchor(lower, context.now, context.timeZone);
  const recurrence = parseRecurrence(lower, anchor);
  if (recurrence && !anchor) {
    return { kind: "clarify", message: "Please provide a date or weekday for that recurrence." };
  }
  if (!anchor) {
    return { kind: "clarify", message: "Please provide a date or weekday." };
  }
  if ((recurrence?.frequency === "monthly" || recurrence?.frequency === "yearly") && !anchor.hasConcreteDate) {
    return { kind: "clarify", message: "Monthly and yearly recurrence need a concrete date such as 2026-09-15." };
  }
  if (anchor.dates.length !== 1 && !recurrence) {
    return { kind: "clarify", message: "One-time schedules need exactly one date." };
  }
  const date = anchor.dates[0];
  if (!date) {
    return { kind: "clarify", message: "Please provide a valid date." };
  }

  const relativeStart = resolveRelativeTime(lower, context.now, context.timeZone);
  const times = findTimes(lower);
  if (relativeStart && times.length > 0) {
    return { kind: "clarify", message: "Please use either a relative delay or a clock time, not both." };
  }
  const scheduledDate = relativeStart?.date ?? date;
  if (relativeStart && date !== scheduledDate) {
    return { kind: "clarify", message: "Please use either a date or a relative delay, not both." };
  }
  const startTime = times[0]?.time ?? relativeStart?.time;
  const duration = findDurationMinutes(lower);
  const explicitTask = /\b(?:create|add)\s+(?:an?\s+)?task\b/iu.test(lower) || /\btask\b/iu.test(lower);
  if (explicitTask && (startTime || duration !== undefined)) {
    return { kind: "clarify", message: "Tasks are all-day and cannot include a start time, end time, or duration." };
  }

  const title = extractTitle(text, recurrence !== undefined, duration !== undefined);
  if (!title) {
    return { kind: "clarify", message: "Please provide a title." };
  }
  const calendarName = extractCalendarName(text);

  if (times.length >= 2 || duration !== undefined) {
    if (!startTime) {
      return { kind: "clarify", message: "Events need a start and end time or a valid duration." };
    }
    const end = duration !== undefined
      ? addMinutes(scheduledDate, startTime, duration, context.timeZone)
      : times[1] ? { date: scheduledDate, time: times[1].time } satisfies DateTimeParts : undefined;
    if (!end) {
      return { kind: "clarify", message: "Events need a start and end time or a valid duration." };
    }
    if (end.date === scheduledDate && end.time <= startTime) {
      return { kind: "clarify", message: "The event end time must be after its start time." };
    }
    return {
      ...(calendarName ? { calendarName } : {}),
      date: scheduledDate,
      ...(end.date !== scheduledDate ? { endDate: end.date } : {}),
      endTime: end.time,
      kind: "event",
      ...(recurrence ? { recurrence } : {}),
      startTime,
      title,
    };
  }

  // A start-only event is a reminder, and any reminder wording without a
  // start time is an all-day task, exactly as the owner requested.
  const scheduleKind: ScheduleKind = startTime ? "reminder" : "task";
  return {
    date: scheduledDate,
    kind: "local",
    ...(recurrence ? { recurrence } : {}),
    scheduleKind,
    ...(startTime ? { startTime } : {}),
    title,
  };
}

function parseManualCorrection(text: string, context: ScheduleParserContext): ParsedScheduleCommand {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^([a-z]+)\s*:\s*(.+)$/iu.exec(line);
    if (!match?.[1] || !match[2]) {
      return { kind: "clarify", message: "Each correction line must use field: value." };
    }
    const key = match[1].toLocaleLowerCase();
    if (!MANUAL_FIELDS.has(key) || fields.has(key)) {
      return { kind: "clarify", message: "Use each allowed correction field at most once." };
    }
    fields.set(key, match[2].trim());
  }

  const requestedKind = fields.get("create")?.toLocaleLowerCase();
  const title = fields.get("title");
  const dateText = fields.get("date");
  if ((requestedKind !== "task" && requestedKind !== "reminder" && requestedKind !== "event") || !title || !dateText) {
    return { kind: "clarify", message: "Provide create, title, and date fields in the correction." };
  }
  if (!validTitle(title)) {
    return { kind: "clarify", message: "Please provide a title of 160 characters or fewer." };
  }

  const anchor = resolveDateAnchor(dateText, context.now, context.timeZone);
  if (!anchor) {
    return { kind: "clarify", message: "Please provide a valid correction date." };
  }
  const recurrenceText = fields.get("recurrence");
  const recurrence = recurrenceText ? parseManualRecurrence(recurrenceText, anchor) : undefined;
  if (recurrenceText && !recurrence) {
    return { kind: "clarify", message: "Use daily, weekly, bi-weekly, monthly, or yearly recurrence." };
  }
  if ((recurrence?.frequency === "monthly" || recurrence?.frequency === "yearly") && !anchor.hasConcreteDate) {
    return { kind: "clarify", message: "Monthly and yearly recurrence need a concrete ISO date." };
  }
  if (anchor.dates.length !== 1 && !recurrence) {
    return { kind: "clarify", message: "One-time corrections need exactly one date." };
  }
  const date = anchor.dates[0];
  if (!date) {
    return { kind: "clarify", message: "Please provide a valid correction date." };
  }

  const startTime = parse24Hour(fields.get("starttime"));
  const endTime = parse24Hour(fields.get("endtime"));
  const duration = fields.get("duration") ? parseManualDuration(fields.get("duration") ?? "") : undefined;
  const calendarName = fields.get("calendar");
  if (calendarName !== undefined && !validTitle(calendarName)) {
    return { kind: "clarify", message: "Please provide a valid calendar name." };
  }

  if (requestedKind === "task") {
    if (startTime || endTime || duration !== undefined || calendarName) {
      return { kind: "clarify", message: "Tasks are all-day and cannot include start, end, duration, or calendar fields." };
    }
    return { date, kind: "local", ...(recurrence ? { recurrence } : {}), scheduleKind: "task", title };
  }
  if (requestedKind === "reminder") {
    if (!startTime || endTime || duration !== undefined || calendarName) {
      return { kind: "clarify", message: "Reminders require starttime and cannot include endtime, duration, or calendar fields." };
    }
    return { date, kind: "local", ...(recurrence ? { recurrence } : {}), scheduleKind: "reminder", startTime, title };
  }

  if (!startTime || (!endTime && duration === undefined)) {
    return { kind: "clarify", message: "Events require starttime plus endtime or duration." };
  }
  const end = duration !== undefined
    ? addMinutes(date, startTime, duration, context.timeZone)
    : endTime ? { date, time: endTime } satisfies DateTimeParts : undefined;
  if (!end || (end.date === date && end.time <= startTime)) {
    return { kind: "clarify", message: "Please provide an event end time after its start time or a valid duration." };
  }
  return {
    ...(calendarName ? { calendarName } : {}),
    date,
    ...(end.date !== date ? { endDate: end.date } : {}),
    endTime: end.time,
    kind: "event",
    ...(recurrence ? { recurrence } : {}),
    startTime,
    title,
  };
}

function parseManualDuration(value: string): number | undefined {
  // The documented `duration: 60m` form is unambiguous inside this explicit
  // field. Outside this field, `m` remains month and minutes require min/mins.
  const compactMinutes = /^(\d+)m$/iu.exec(value.trim());
  if (compactMinutes?.[1]) {
    const minutes = Number(compactMinutes[1]);
    return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : undefined;
  }
  return findDurationMinutes(`for ${value}`);
}

function parseManualRecurrence(value: string, anchor: DateAnchor): ScheduleRecurrence | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "bi-weekly" || normalized === "biweekly") {
    return { frequency: "weekly", interval: 2, ...(anchor.weekdays.length ? { weekdays: anchor.weekdays } : {}) };
  }
  if (normalized === "daily") {
    return { frequency: "daily", interval: 1 };
  }
  if (normalized === "weekly") {
    return { frequency: "weekly", interval: 1, ...(anchor.weekdays.length ? { weekdays: anchor.weekdays } : {}) };
  }
  if (normalized === "monthly") {
    return { frequency: "monthly", interval: 1 };
  }
  if (normalized === "yearly") {
    return { frequency: "yearly", interval: 1 };
  }
  return undefined;
}

function findTimes(text: string): readonly TimeMatch[] {
  const result: TimeMatch[] = [];
  for (const match of text.matchAll(TIME_EXPRESSION)) {
    const token = match[0];
    const time = token ? parseClock(token) : undefined;
    if (time && match.index !== undefined) {
      result.push({ end: match.index + token.length, start: match.index, time });
    }
  }
  return result;
}

function parse24Hour(value: string | undefined): string | undefined {
  return value && TIME.test(value.trim()) ? value.trim() : undefined;
}

function parseClock(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase().replace(/[.\s]/gu, "");
  if (normalized === "noon") {
    return "12:00";
  }
  if (normalized === "midnight") {
    return "00:00";
  }
  const twelve = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/u.exec(normalized);
  if (twelve) {
    const hour = Number(twelve[1]);
    const minute = Number(twelve[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) {
      return undefined;
    }
    const converted = (hour % 12) + (twelve[3] === "pm" ? 12 : 0);
    return `${String(converted).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const twentyFour = /^(\d{1,2}):(\d{2})$/u.exec(normalized);
  if (!twentyFour) {
    return undefined;
  }
  const hour = Number(twentyFour[1]);
  const minute = Number(twentyFour[2]);
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : undefined;
}

function findDurationMinutes(text: string): number | undefined {
  const normalized = normalizeTemporalAliases(text);
  const match = /\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|minutes?)\b/iu.exec(normalized);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const duration = parseDurationToken(`${match[1]} ${match[2]}`);
  if (!duration || (duration.unit !== "hour" && duration.unit !== "minute")) {
    return undefined;
  }
  const minutes = duration.unit === "hour" ? duration.amount * 60 : duration.amount;
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : undefined;
}

function addMinutes(date: string, time: string, minutes: number, timeZone: string): DateTimeParts | undefined {
  const local = DateTime.fromFormat(`${date} ${time}`, "yyyy-LL-dd HH:mm", { setZone: true, zone: timeZone });
  if (!local.isValid || !Number.isInteger(minutes) || minutes <= 0) {
    return undefined;
  }
  const end = local.plus({ minutes });
  return end.isValid ? { date: end.toFormat("yyyy-LL-dd"), time: end.toFormat("HH:mm") } : undefined;
}

function extractTitle(original: string, hasRecurrence: boolean, hasDuration: boolean): string | undefined {
  let title = original
    .replace(/^(?:remind\s+me\s+)?/iu, "")
    .replace(/^(?:remember\s+to\s+)?/iu, "")
    .replace(/^(?:create|add|schedule|get|put)\s+(?:a\s+|an\s+|the\s+)?/iu, "")
    .replace(/^(?:task|event|reminder)\s+/iu, "")
    .replace(/\bon\s+my\s+calendar\b/iu, " ")
    .replace(/\b(?:in|on)\s+(?:the\s+)?[\p{L}\p{N} _-]+\s+calendar\b/iu, " ")
    .replace(/\b(?:today|tomorrow|\d{4}-\d{2}-\d{2})\b/giu, " ")
    .replace(/\bin\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\b/giu, " ")
    .replace(/\b(?:mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu, " ")
    .replace(TIME_EXPRESSION, " ");
  if (hasRecurrence) {
    title = title
      .replace(/\bevery\s+other\b/giu, " ")
      .replace(/\b(?:every\s+)?(?:\d+\s+)?(?:day|week|month|year|days|weeks|months|years|daily|weekly|bi[-\s]?weekly|monthly|yearly)\b/giu, " ")
      .replace(/\bevery\b/giu, " ");
  }
  if (hasDuration) {
    title = normalizeTemporalAliases(title).replace(/\bfor\s+\d+(?:\.\d+)?\s+(?:hours?|minutes?)\b/giu, " ");
  }
  title = title
    .replace(/\b(?:at|from|to|and)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,;:.!?-]+|[\s,;:.!?-]+$/gu, "")
    .replace(/^(?:a|an|the)\s+/iu, "")
    .trim();
  return validTitle(title) ? title : undefined;
}

function extractCalendarName(value: string): string | undefined {
  const match = /\b(?:in|on)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} _-]*?)\s+calendar\b/iu.exec(value);
  const name = match?.[1]?.replace(/^my$/iu, "").replace(/\s+/gu, " ").trim();
  return name && validTitle(name) ? name : undefined;
}

function hasCreationCue(value: string): boolean {
  return /^(?:remind\s+me\b|remember\s+to\b|(?:create|add|schedule|put)\b|(?:get)\b.*\bon\s+(?:my\s+)?calendar\b)/iu.test(value) ||
    /\b(?:task|event)\b/iu.test(value);
}

function isLegacyRelativeReminderPhrase(value: string): boolean {
  return /^remind\s+me\s+in\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?)\s+to\b/iu.test(value) ||
    /^remind\s+me\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?)\s+before\b/iu.test(value);
}

function isLegacyTaskPhrase(value: string): boolean {
  return /^(?:done|complete|cancel|delete)\s+task\b/iu.test(value) ||
    /^(?:done|complete)\s+[\p{L}\p{N}]/iu.test(value) ||
    /^(?:tasks?|list\s+tasks?)$/iu.test(value);
}

function isLegacyCalendarPhrase(value: string): boolean {
  return /^(?:show|list|view)\s+(?:me\s+)?(?:my\s+)?calendar\b/iu.test(value) ||
    /^(?:change|move|reschedule)\b/iu.test(value) ||
    /^delete\s+(?:the\s+)?(?:\d|[a-z])/iu.test(value) && /\b(?:meeting|appointment|event)\b/iu.test(value);
}

function validAgendaRange(dateValue: unknown, endDateValue: unknown, range: unknown): boolean {
  if (!validDate(dateValue) || !validDate(endDateValue) || (range !== "day" && range !== "week")) {
    return false;
  }
  const start = DateTime.fromFormat(dateValue, "yyyy-LL-dd", { zone: "UTC" }).startOf("day");
  const end = DateTime.fromFormat(endDateValue, "yyyy-LL-dd", { zone: "UTC" }).startOf("day");
  const calendarDays = Math.round(end.diff(start, "days").days);
  return range === "day" ? calendarDays === 0 : calendarDays === 6;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) {
    return false;
  }
  const date = DateTime.fromFormat(value, "yyyy-LL-dd", { zone: "UTC" });
  return date.isValid && date.toFormat("yyyy-LL-dd") === value;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value);
}

function validTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 160;
}

function validOptionalRecurrence(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) ||
    (value.frequency !== "daily" && value.frequency !== "weekly" && value.frequency !== "monthly" && value.frequency !== "yearly") ||
    typeof value.interval !== "number" || !Number.isInteger(value.interval) || value.interval < 1 || value.interval > 366) {
    return false;
  }
  if (value.weekdays === undefined) {
    return true;
  }
  return Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.length <= 7 &&
    value.weekdays.every((weekday) => typeof weekday === "number" && Number.isInteger(weekday) && weekday >= 1 && weekday <= 7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
