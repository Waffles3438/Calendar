import { DateTime, IANAZone } from "luxon";
import { z } from "zod";

import { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";
import type { RecurrenceScope } from "../domain/calendar.js";
import type { ScheduleRecurrence } from "../scheduling/schedule-domain.js";
import { validateLocalTaskDateTime } from "../tasks/task-time.js";
import type { NaturalLanguageClarificationReason } from "./natural-language-types.js";

export const NATURAL_LANGUAGE_ACTION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const NATURAL_LANGUAGE_ACTION_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
export const MAX_NATURAL_LANGUAGE_ACTION_TITLE_CHARACTERS = 160;
export const MAX_NATURAL_LANGUAGE_ACTION_SELECTOR_CHARACTERS = 160;
export const MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_MESSAGES = 4;
export const MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_CHARACTERS = 4_000;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TIME_PATTERN = NATURAL_LANGUAGE_ACTION_TIME_PATTERN;
const DATE_PATTERN = NATURAL_LANGUAGE_ACTION_DATE_PATTERN;
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "api",
  "calendarid",
  "calendarnameid",
  "credentials",
  "etag",
  "eventid",
  "function",
  "functioncall",
  "functioninstructions",
  "id",
  "instructions",
  "requestbody",
  "sendupdates",
  "taskid",
  "taskids",
  "tool",
  "tools",
  "url",
  "uri",
]);

const safeText = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !URL_PATTERN.test(value), "URLs are not accepted in natural-language actions");

const dateSchema = z.string().regex(DATE_PATTERN);
const timeSchema = z.string().regex(TIME_PATTERN);
const recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(366),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
}).strict().superRefine((value, context) => {
  if (value.frequency !== "weekly" && value.weekdays !== undefined) {
    context.addIssue({ code: "custom", message: "weekdays are valid only for weekly recurrence" });
  }
});
const recurrenceScopeSchema = z.enum(["all_future", "series", "this_instance"]);
const calendarSelectorSchema = z.object({
  date: dateSchema,
  summary: safeText(MAX_NATURAL_LANGUAGE_ACTION_SELECTOR_CHARACTERS).optional(),
  time: timeSchema.optional(),
}).strict().refine((value) => Boolean(value.summary || value.time), "A calendar selector needs a title or time");
const taskSelectorSchema = z.object({
  date: dateSchema.optional(),
  title: safeText(MAX_NATURAL_LANGUAGE_ACTION_SELECTOR_CHARACTERS),
}).strict();
const attendeeChangeSchema = z.object({
  action: z.enum(["add", "remove"]),
  emails: z.array(z.string().trim().max(254).regex(EMAIL_PATTERN)).min(1).max(20),
}).strict();
const clarificationReasonSchema = z.enum([
  "ambiguous_domain",
  "ambiguous_intent",
  "invalid_value",
  "missing_required_detail",
  "unsupported_intent",
]);
const cleanupTargetSchema = z.enum(["task", "reminder", "event"]);

const modelActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_calendar_event"),
    calendarName: safeText(MAX_NATURAL_LANGUAGE_ACTION_TITLE_CHARACTERS).optional(),
    date: dateSchema,
    endDate: dateSchema.optional(),
    endTime: timeSchema,
    recurrence: recurrenceSchema.optional(),
    startTime: timeSchema,
    title: safeText(MAX_NATURAL_LANGUAGE_ACTION_TITLE_CHARACTERS),
  }).strict(),
  z.object({ action: z.literal("list_calendar"), date: dateSchema }).strict(),
  z.object({
    action: z.literal("move_calendar_event"),
    newStartTime: timeSchema,
    recurrenceScope: recurrenceScopeSchema.optional(),
    selector: calendarSelectorSchema,
  }).strict(),
  z.object({
    action: z.literal("delete_calendar_event"),
    recurrenceScope: recurrenceScopeSchema.optional(),
    selector: calendarSelectorSchema,
  }).strict(),
  z.object({
    action: z.literal("manage_calendar_attendees"),
    change: attendeeChangeSchema,
    recurrenceScope: recurrenceScopeSchema.optional(),
    selector: calendarSelectorSchema,
  }).strict(),
  z.object({
    action: z.literal("set_calendar_reminder"),
    minutesBefore: z.number().int().min(1).max(MAX_REMINDER_MINUTES),
    selector: calendarSelectorSchema,
  }).strict(),
  z.object({
    action: z.literal("create_task_or_reminder"),
    date: dateSchema,
    recurrence: recurrenceSchema.optional(),
    scheduleKind: z.enum(["task", "reminder"]),
    startTime: timeSchema.optional(),
    title: safeText(MAX_NATURAL_LANGUAGE_ACTION_TITLE_CHARACTERS),
  }).strict(),
  z.object({ action: z.literal("list_tasks"), date: dateSchema.optional() }).strict(),
  z.object({ action: z.literal("complete_task"), selector: taskSelectorSchema }).strict(),
  z.object({
    action: z.literal("delete_task"),
    date: dateSchema.optional(),
    scope: z.enum(["single", "today", "all"]),
    selector: taskSelectorSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.scope === "single" && !value.selector) {
      context.addIssue({ code: "custom", message: "single task deletion needs a selector" });
    }
    if (value.scope !== "single" && value.selector) {
      context.addIssue({ code: "custom", message: "bulk task deletion cannot include a selector" });
    }
    if (value.scope === "all" && value.date) {
      context.addIssue({ code: "custom", message: "all task deletion cannot include a date" });
    }
    if (value.scope === "today" && !value.date) {
      context.addIssue({ code: "custom", message: "today task deletion needs a resolved date" });
    }
  }),
  z.object({
    action: z.literal("show_agenda"),
    date: dateSchema,
    endDate: dateSchema,
    range: z.enum(["day", "week"]),
  }).strict(),
  z.object({
    action: z.literal("cleanup_schedule"),
    date: dateSchema.optional(),
    mode: z.enum(["bulk", "named", "reviewed"]),
    targetKinds: z.array(cleanupTargetSchema).min(1).max(3),
    terms: z.array(safeText(MAX_NATURAL_LANGUAGE_ACTION_SELECTOR_CHARACTERS)).max(20),
    title: safeText(MAX_NATURAL_LANGUAGE_ACTION_TITLE_CHARACTERS),
  }).strict().superRefine((value, context) => {
    if (new Set(value.targetKinds).size !== value.targetKinds.length) {
      context.addIssue({ code: "custom", message: "cleanup target kinds must be unique" });
    }
    if (value.mode === "bulk" && value.terms.length > 0) {
      context.addIssue({ code: "custom", message: "bulk cleanup cannot include title terms" });
    }
    if (value.mode !== "bulk" && value.terms.length === 0) {
      context.addIssue({ code: "custom", message: "named cleanup needs title terms" });
    }
  }),
  z.object({
    action: z.literal("ask_clarification"),
    reason: clarificationReasonSchema,
  }).strict(),
]);

export type NaturalLanguageAction = z.output<typeof modelActionSchema>;
export type NaturalLanguageActionRecurrence = ScheduleRecurrence;
export type NaturalLanguageActionRecurrenceScope = RecurrenceScope;

export interface NaturalLanguageConversationContext {
  readonly clarificationQuestion: string;
  readonly originalRequest: string;
  readonly reason: NaturalLanguageClarificationReason;
  readonly recentMessages: readonly string[];
}

export interface NaturalLanguageActionPlanningInput {
  readonly context?: NaturalLanguageConversationContext;
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
}

export interface NaturalLanguageActionValidationInput {
  readonly now: Date;
  readonly timeZone: string;
}

/**
 * JSON Schema sent to Gemini. Interactions structured output supports a subset
 * of JSON Schema, so this is a broad, action-labeled superset. The
 * application-level Zod validator remains authoritative for required fields,
 * action-specific combinations, dates, times, and safety constraints.
 */
export const NATURAL_LANGUAGE_ACTION_JSON_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    action: {
      enum: [
        "create_calendar_event",
        "list_calendar",
        "move_calendar_event",
        "delete_calendar_event",
        "manage_calendar_attendees",
        "set_calendar_reminder",
        "create_task_or_reminder",
        "list_tasks",
        "complete_task",
        "delete_task",
        "show_agenda",
        "cleanup_schedule",
        "ask_clarification",
      ],
      type: "string",
    },
    calendarName: { type: "string" },
    change: attendeeChangeJsonSchema(),
    date: { type: "string" },
    endDate: { type: "string" },
    endTime: { type: "string" },
    minutesBefore: { maximum: MAX_REMINDER_MINUTES, minimum: 1, type: "integer" },
    mode: { enum: ["bulk", "named", "reviewed"], type: "string" },
    newStartTime: { type: "string" },
    range: { enum: ["day", "week"], type: "string" },
    reason: {
      enum: ["ambiguous_domain", "ambiguous_intent", "invalid_value", "missing_required_detail", "unsupported_intent"],
      type: "string",
    },
    recurrence: recurrenceJsonSchema(),
    recurrenceScope: { enum: ["all_future", "series", "this_instance"], type: "string" },
    scheduleKind: { enum: ["task", "reminder"], type: "string" },
    scope: { enum: ["single", "today", "all"], type: "string" },
    selector: selectorJsonSchema(),
    startTime: { type: "string" },
    targetKinds: {
      items: { enum: ["task", "reminder", "event"], type: "string" },
      maxItems: 3,
      minItems: 1,
      type: "array",
    },
    terms: { items: { type: "string" }, maxItems: 20, type: "array" },
    title: { type: "string" },
  },
  required: ["action"],
  type: "object",
};

/** Parses and semantically validates one untrusted model response. */
export function parseNaturalLanguageAction(
  output: string,
  input: NaturalLanguageActionValidationInput,
): NaturalLanguageAction | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  return validateNaturalLanguageAction(value, input);
}

/** Validates a decoded action independently of Gemini transport. */
export function validateNaturalLanguageAction(
  value: unknown,
  input: NaturalLanguageActionValidationInput,
): NaturalLanguageAction | undefined {
  if (!validInput(input) || containsForbiddenContent(value)) {
    return undefined;
  }
  const parsed = modelActionSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return normalizeAction(parsed.data, input);
}

export function isNaturalLanguageAction(value: unknown): value is NaturalLanguageAction {
  return modelActionSchema.safeParse(value).success;
}

function normalizeAction(
  action: NaturalLanguageAction,
  input: NaturalLanguageActionValidationInput,
): NaturalLanguageAction | undefined {
  switch (action.action) {
    case "ask_clarification":
    case "list_calendar":
    case "list_tasks":
      if ("date" in action && action.date && !isValidDate(action.date, input.timeZone)) {
        return undefined;
      }
      return action;
    case "create_calendar_event": {
      if (!isValidDate(action.date, input.timeZone) ||
        (action.endDate && !isValidDate(action.endDate, input.timeZone)) ||
        !isValidLocalTime(action.date, action.startTime, input.timeZone) ||
        !isValidLocalTime(action.endDate ?? action.date, action.endTime, input.timeZone)) {
        return undefined;
      }
      const start = localDateTime(action.date, action.startTime, input.timeZone);
      const end = localDateTime(action.endDate ?? action.date, action.endTime, input.timeZone);
      if (!start || !end || end <= start || (action.endDate && action.endDate < action.date)) {
        return undefined;
      }
      return action;
    }
    case "create_task_or_reminder": {
      if (!isValidDate(action.date, input.timeZone)) {
        return undefined;
      }
      const localToday = DateTime.fromJSDate(input.now, { zone: input.timeZone }).toFormat("yyyy-LL-dd");
      if (action.date < localToday) {
        return undefined;
      }
      if (action.scheduleKind === "task") {
        return action.startTime === undefined ? action : undefined;
      }
      if (!action.startTime || !isValidLocalTime(action.date, action.startTime, input.timeZone)) {
        return undefined;
      }
      const dateTime = localDateTime(action.date, action.startTime, input.timeZone);
      return action.recurrence || dateTime && dateTime > DateTime.fromJSDate(input.now, { zone: input.timeZone })
        ? action
        : undefined;
    }
    case "move_calendar_event":
      return validCalendarSelector(action.selector, input.timeZone) &&
        isValidLocalTime(action.selector.date, action.newStartTime, input.timeZone)
        ? action
        : undefined;
    case "delete_calendar_event":
      return validCalendarSelector(action.selector, input.timeZone) ? action : undefined;
    case "manage_calendar_attendees":
      return validCalendarSelector(action.selector, input.timeZone) ? {
        ...action,
        change: { ...action.change, emails: action.change.emails.map((email) => email.toLowerCase()) },
      } : undefined;
    case "set_calendar_reminder":
      return validCalendarSelector(action.selector, input.timeZone) ? action : undefined;
    case "complete_task":
      return validTaskSelector(action.selector, input.timeZone) ? action : undefined;
    case "delete_task":
      if (action.date && !isValidDate(action.date, input.timeZone)) {
        return undefined;
      }
      if (action.selector && !validTaskSelector(action.selector, input.timeZone)) {
        return undefined;
      }
      return action;
    case "show_agenda":
      return validAgendaRange(action, input.timeZone)
        ? action
        : undefined;
    case "cleanup_schedule":
      if (action.date && !isValidDate(action.date, input.timeZone)) {
        return undefined;
      }
      return action;
  }
}

function validInput(input: NaturalLanguageActionValidationInput): boolean {
  return input.now instanceof Date && Number.isFinite(input.now.valueOf()) &&
    typeof input.timeZone === "string" && input.timeZone.length <= 100 && IANAZone.isValidZone(input.timeZone);
}

function validAgendaRange(
  action: Extract<NaturalLanguageAction, { action: "show_agenda" }>,
  timeZone: string,
): boolean {
  if (!isValidDate(action.date, timeZone) || !isValidDate(action.endDate, timeZone)) {
    return false;
  }
  const start = DateTime.fromFormat(action.date, "yyyy-LL-dd", { zone: timeZone }).startOf("day");
  const end = DateTime.fromFormat(action.endDate, "yyyy-LL-dd", { zone: timeZone }).startOf("day");
  const calendarDays = Math.round(end.diff(start, "days").days);
  return action.range === "day" ? calendarDays === 0 : calendarDays === 6;
}

function validCalendarSelector(
  selector: z.output<typeof calendarSelectorSchema>,
  timeZone: string,
): boolean {
  return isValidDate(selector.date, timeZone) &&
    (!selector.time || isValidLocalTime(selector.date, selector.time, timeZone));
}

function validTaskSelector(
  selector: z.output<typeof taskSelectorSchema>,
  timeZone: string,
): boolean {
  return !selector.date || isValidDate(selector.date, timeZone);
}

function isValidDate(value: string, timeZone: string): boolean {
  const parsed = DateTime.fromFormat(value, "yyyy-LL-dd", { zone: timeZone, setZone: true });
  return parsed.isValid && parsed.toFormat("yyyy-LL-dd") === value;
}

function isValidLocalTime(date: string, time: string, timeZone: string): boolean {
  const validation = validateLocalTaskDateTime(date, time, timeZone);
  return validation.kind === "valid";
}

function localDateTime(date: string, time: string, timeZone: string): DateTime | undefined {
  const validation = validateLocalTaskDateTime(date, time, timeZone);
  return validation.kind === "valid" ? validation.value : undefined;
}

function containsForbiddenContent(value: unknown, depth = 0): boolean {
  if (depth > 12) {
    return true;
  }
  if (typeof value === "string") {
    return URL_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenContent(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(([key, nested]) =>
    FORBIDDEN_RESPONSE_KEYS.has(key.replace(/[^a-z]/giu, "").toLowerCase()) ||
    containsForbiddenContent(nested, depth + 1),
  );
}

function recurrenceJsonSchema(): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      frequency: { enum: ["daily", "weekly", "monthly", "yearly"], type: "string" },
      interval: { maximum: 366, minimum: 1, type: "integer" },
      weekdays: { items: { maximum: 7, minimum: 1, type: "integer" }, maxItems: 7, minItems: 1, type: "array" },
    },
    required: ["frequency", "interval"],
    type: "object",
  };
}

function attendeeChangeJsonSchema(): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      action: { enum: ["add", "remove"], type: "string" },
      emails: { items: { type: "string" }, maxItems: 20, minItems: 1, type: "array" },
    },
    required: ["action", "emails"],
    type: "object",
  };
}

function selectorJsonSchema(): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      date: { type: "string" },
      summary: { type: "string" },
      time: { type: "string" },
      title: { type: "string" },
    },
    type: "object",
  };
}
