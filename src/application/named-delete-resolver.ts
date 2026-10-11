import { DateTime } from "luxon";
import type { Logger } from "pino";

import {
  calendarDateTimeToDateTime,
  calendarDayBounds,
} from "../calendar/event-time.js";
import {
  hasExternalGuests,
  type CalendarEvent,
  type CalendarEventDateTime,
  type CalendarReference,
} from "../domain/calendar.js";
import type { CalendarGateway } from "../google/calendar-api.js";
import type { LocalTask } from "../tasks/task-domain.js";
import { localTaskDate } from "../tasks/task-time.js";
import type { ScheduledItem } from "../scheduling/schedule-domain.js";

const NAMED_DELETE_GENERIC_TERMS = new Set([
  "a",
  "an",
  "appointment",
  "appointments",
  "class",
  "classes",
  "event",
  "events",
  "meeting",
  "meetings",
  "my",
  "on",
  "reminder",
  "reminders",
  "schedule",
  "schedules",
  "task",
  "tasks",
  "the",
  "to",
]);

const DATE_TOKEN_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/gu;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MATERIALIZATION_HORIZON_YEARS = 5;
const MAX_LOCAL_TASK_SCAN_ITEMS = 10_000;

export type NamedDeleteSourceStatus = "complete" | "failed" | "skipped" | "unsafe";

export interface NamedDeleteSourceStatuses {
  readonly calendar: NamedDeleteSourceStatus;
  readonly legacyTasks: NamedDeleteSourceStatus;
  readonly scheduledReminders: NamedDeleteSourceStatus;
}

export interface NormalizedNamedDeleteSelector {
  readonly date?: string;
  readonly terms: readonly string[];
}

export interface NamedDeleteRequest {
  readonly now: Date;
  readonly ownerId: string;
  readonly selectorDate?: string;
  readonly selectorTitle: string;
  readonly source: "gemini";
  readonly timeZone: string;
}

export interface LegacyTaskCandidate {
  readonly domain: "legacy_task";
  readonly dueAt: string;
  readonly expectedRevision: number;
  readonly localDate: string;
  readonly taskId: string;
  readonly timeZone: string;
  readonly title: string;
}

export interface ScheduledReminderCandidate {
  readonly domain: "scheduled_reminder";
  readonly dueAt?: string;
  readonly expectedRevision: number;
  readonly itemId: string;
  readonly occurrenceKey?: string;
  readonly scheduledDate: string;
  readonly seriesId?: string;
  readonly timeZone: string;
  readonly title: string;
}

export interface CalendarEventCandidate {
  readonly calendarId: string;
  readonly calendarSummary: string;
  readonly calendarTimeZone: string;
  readonly domain: "calendar_event";
  readonly end: CalendarEventDateTime;
  readonly eventId: string;
  readonly expectedEtag: string;
  readonly hasExternalGuests: boolean;
  readonly recurrence?: readonly string[];
  readonly recurringEventId?: string;
  readonly start: CalendarEventDateTime;
  readonly summary: string;
}

export type NamedDeleteCandidate =
  | CalendarEventCandidate
  | LegacyTaskCandidate
  | ScheduledReminderCandidate;

export interface NamedDeleteResolutionBase {
  readonly candidates: readonly NamedDeleteCandidate[];
  readonly sources: NamedDeleteSourceStatuses;
}

export type NamedDeleteResolution =
  | (NamedDeleteResolutionBase & { readonly status: "none" })
  | (NamedDeleteResolutionBase & { readonly candidate: NamedDeleteCandidate; readonly status: "exact" })
  | (NamedDeleteResolutionBase & { readonly status: "ambiguous" })
  | (NamedDeleteResolutionBase & { readonly status: "read_failure" | "unsafe_calendar" });

export interface NamedDeleteLocalTaskReader {
  listActiveLocalTasks(input: { limit?: number; ownerId: string }): readonly LocalTask[];
}

export interface NamedDeleteScheduledReader {
  ensureOccurrencesThrough?(input: { now: Date; ownerId: string; throughDate: string }): void;
  listActiveScheduledItems(input: {
    kinds?: readonly ["reminder"];
    ownerId: string;
    scheduledDateEarliest: string;
    scheduledDateLatest: string;
  }): readonly ScheduledItem[];
}

export type NamedDeleteCalendarReader = Pick<CalendarGateway, "listCalendars" | "listEvents">;

export interface NamedDeleteResolverOptions {
  readonly calendarGateway?: NamedDeleteCalendarReader;
  readonly logger?: Pick<Logger, "warn">;
  readonly ownerId: string;
  readonly schedulingRepository: NamedDeleteScheduledReader;
  readonly stateRepository: NamedDeleteLocalTaskReader;
  readonly timeZone: string;
}

/**
 * The one generic matcher used by the unified single-named route. Existing
 * deterministic domain matchers intentionally do not call this function.
 */
export function tokenizeNamedDeleteTitle(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  return normalized
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((term) => term.length > 0);
}

export function normalizeNamedDeleteSelector(input: {
  readonly date?: string;
  readonly now?: Date;
  readonly timeZone?: string;
  readonly title: string;
}): NormalizedNamedDeleteSelector | undefined {
  const title = input.title.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  if (!title) {
    return undefined;
  }

  let date = input.date;
  if (date && !isValidIsoDate(date, input.timeZone)) {
    return undefined;
  }

  const dateTokens = title.match(DATE_TOKEN_PATTERN) ?? [];
  for (const dateToken of dateTokens) {
    if (!isValidIsoDate(dateToken, input.timeZone)) {
      continue;
    }
    if (date && date !== dateToken) {
      return undefined;
    }
    date = dateToken;
  }

  const titleWithoutDateTokens = title.replace(DATE_TOKEN_PATTERN, " ");
  const terms: string[] = [];
  for (const term of titleWithoutDateTokens.split(/[^\p{L}\p{N}]+/gu)) {
    if (!term || NAMED_DELETE_GENERIC_TERMS.has(term)) {
      continue;
    }

    const parsedDate = parseRelativeDateTerm(term, input.now, input.timeZone);
    if (parsedDate) {
      if (date && date !== parsedDate) {
        return undefined;
      }
      date = parsedDate;
      continue;
    }

    if (!terms.includes(term)) {
      terms.push(term);
    }
  }

  if (terms.length === 0) {
    return undefined;
  }

  return {
    ...(date ? { date } : {}),
    terms,
  };
}

export function namedDeleteTitleMatches(
  title: string,
  selector: Pick<NormalizedNamedDeleteSelector, "terms"> | readonly string[],
): boolean {
  const terms: readonly string[] = "terms" in selector ? selector.terms : selector;
  if (terms.length === 0) {
    return false;
  }
  const candidateTerms = new Set(tokenizeNamedDeleteTitle(title));
  return terms.every((term) => candidateTerms.has(term));
}

export function isNamedDeleteCalendarEventForDate(
  event: CalendarEvent,
  calendar: CalendarReference,
  date: string,
): boolean {
  const day = DateTime.fromISO(date, { zone: calendar.timeZone }).startOf("day");
  if (!day.isValid || day.toFormat("yyyy-LL-dd") !== date) {
    return false;
  }
  const dayEnd = day.plus({ days: 1 });
  if (event.start.kind === "all_day") {
    return event.end.kind === "all_day" && event.start.date <= date && event.end.date > date;
  }
  if (event.end.kind !== "timed") {
    return false;
  }
  try {
    const eventStart = calendarDateTimeToDateTime(event.start, calendar.timeZone).toMillis();
    const eventEnd = calendarDateTimeToDateTime(event.end, calendar.timeZone).toMillis();
    return eventStart < dayEnd.toMillis() && eventEnd > day.toMillis();
  } catch {
    return false;
  }
}

export function isNamedDeleteCalendarEventFuture(
  event: CalendarEvent,
  calendar: CalendarReference,
  now: Date,
): boolean {
  try {
    return calendarDateTimeToDateTime(event.start, calendar.timeZone).toJSDate() > now;
  } catch {
    return false;
  }
}

/** Resolves all configured owner-scoped sources before returning any result. */
export class NamedDeleteResolver {
  public constructor(private readonly options: NamedDeleteResolverOptions) { }

  public async resolve(input: NamedDeleteRequest): Promise<NamedDeleteResolution> {
    const selector = normalizeNamedDeleteSelector({
      ...(input.selectorDate ? { date: input.selectorDate } : {}),
      now: input.now,
      timeZone: input.timeZone,
      title: input.selectorTitle,
    });
    const skippedSources: NamedDeleteSourceStatuses = {
      calendar: this.options.calendarGateway ? "complete" : "skipped",
      legacyTasks: "complete",
      scheduledReminders: "complete",
    };
    if (!selector) {
      return { candidates: [], sources: skippedSources, status: "none" };
    }

    const local = this.readLegacyTasks(input, selector);
    const reminders = this.readScheduledReminders(input, selector);
    const calendar = await this.readCalendar(input, selector);

    const sources: NamedDeleteSourceStatuses = {
      calendar: calendar.status,
      legacyTasks: local.status,
      scheduledReminders: reminders.status,
    };
    if (local.status === "failed" || reminders.status === "failed" || calendar.status === "failed") {
      return { candidates: [], sources, status: "read_failure" };
    }
    if (calendar.status === "unsafe") {
      return { candidates: [], sources, status: "unsafe_calendar" };
    }

    const candidates = this.sortCandidates([
      ...local.candidates,
      ...reminders.candidates,
      ...calendar.candidates,
    ]);
    if (candidates.length === 0) {
      return { candidates: [], sources, status: "none" };
    }
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (!candidate) {
        return { candidates: [], sources, status: "none" };
      }
      return { candidate, candidates, sources, status: "exact" };
    }
    return { candidates, sources, status: "ambiguous" };
  }

  private readLegacyTasks(
    input: NamedDeleteRequest,
    selector: NormalizedNamedDeleteSelector,
  ): { readonly candidates: readonly LegacyTaskCandidate[]; readonly status: "complete" | "failed" } {
    try {
      const tasks = this.options.stateRepository.listActiveLocalTasks({
        limit: MAX_LOCAL_TASK_SCAN_ITEMS,
        ownerId: input.ownerId,
      });
      const candidates = tasks
        .filter((task) => task.ownerId === input.ownerId && task.status === "active")
        .filter((task) => namedDeleteTitleMatches(task.title, selector))
        .filter((task) => !selector.date || localTaskDate(task.dueAt, task.timeZone) === selector.date)
        .map((task): LegacyTaskCandidate => ({
          domain: "legacy_task",
          dueAt: task.dueAt.toISOString(),
          expectedRevision: task.revision,
          localDate: localTaskDate(task.dueAt, task.timeZone),
          taskId: task.id,
          timeZone: task.timeZone,
          title: task.title,
        }));
      return { candidates, status: "complete" };
    } catch {
      this.options.logger?.warn({ source: "legacy_tasks" }, "Named-delete legacy task read failed");
      return { candidates: [], status: "failed" };
    }
  }

  private readScheduledReminders(
    input: NamedDeleteRequest,
    selector: NormalizedNamedDeleteSelector,
  ): { readonly candidates: readonly ScheduledReminderCandidate[]; readonly status: "complete" | "failed" } {
    try {
      const now = input.now;
      const throughDate = DateTime.fromJSDate(now, { zone: input.timeZone })
        .plus({ years: MATERIALIZATION_HORIZON_YEARS })
        .toFormat("yyyy-LL-dd");
      this.options.schedulingRepository.ensureOccurrencesThrough?.({
        now,
        ownerId: input.ownerId,
        throughDate,
      });
      const items = this.options.schedulingRepository.listActiveScheduledItems({
        kinds: ["reminder"],
        ownerId: input.ownerId,
        scheduledDateEarliest: selector.date ?? "0000-01-01",
        scheduledDateLatest: selector.date ?? "9999-12-31",
      });
      const candidates = items
        .filter((item) => item.ownerId === input.ownerId && item.status === "active" && item.kind === "reminder")
        .filter((item) => namedDeleteTitleMatches(item.title, selector))
        .filter((item) => selector.date
          ? item.scheduledDate === selector.date
          : Boolean(item.dueAt && Number.isFinite(item.dueAt.valueOf()) && item.dueAt > now))
        .map((item): ScheduledReminderCandidate => ({
          domain: "scheduled_reminder",
          ...(item.dueAt ? { dueAt: item.dueAt.toISOString() } : {}),
          expectedRevision: item.revision,
          itemId: item.id,
          ...(item.occurrenceKey ? { occurrenceKey: item.occurrenceKey } : {}),
          scheduledDate: item.scheduledDate,
          ...(item.seriesId ? { seriesId: item.seriesId } : {}),
          timeZone: item.timeZone,
          title: item.title,
        }));
      return { candidates, status: "complete" };
    } catch {
      this.options.logger?.warn({ source: "scheduled_reminders" }, "Named-delete scheduled reminder read failed");
      return { candidates: [], status: "failed" };
    }
  }

  private async readCalendar(
    input: NamedDeleteRequest,
    selector: NormalizedNamedDeleteSelector,
  ): Promise<{
    readonly candidates: readonly CalendarEventCandidate[];
    readonly status: "complete" | "failed" | "skipped" | "unsafe";
  }> {
    const gateway = this.options.calendarGateway;
    if (!gateway) {
      return { candidates: [], status: "skipped" };
    }

    let calendars: readonly CalendarReference[];
    try {
      calendars = await gateway.listCalendars();
    } catch {
      this.options.logger?.warn({ source: "calendar_list" }, "Named-delete Calendar list read failed");
      return { candidates: [], status: "failed" };
    }

    const candidates = new Map<string, CalendarEventCandidate>();
    let failed = false;
    let unsafe = false;
    for (const calendar of calendars) {
      if (calendar.readOnly) {
        continue;
      }
      let events: readonly CalendarEvent[];
      try {
        const range = selector.date
          ? calendarDayBounds(selector.date, calendar.timeZone)
          : this.futureCalendarRange(input.now);
        events = await gateway.listEvents({ calendarId: calendar.id, ...range });
      } catch {
        failed = true;
        this.options.logger?.warn({ source: "calendar_events" }, "Named-delete Calendar event read failed");
        continue;
      }

      for (const event of events) {
        if (event.status === "cancelled" || !namedDeleteTitleMatches(event.summary, selector)) {
          continue;
        }

        const dateEligible = selector.date
          ? isNamedDeleteCalendarEventForDate(event, calendar, selector.date)
          : isNamedDeleteCalendarEventFuture(event, calendar, input.now);
        if (!dateEligible) {
          // An active matching event with malformed date fields is unsafe rather
          // than evidence that no matching event exists.
          if (!this.hasUsableCalendarInterval(event, calendar)) {
            unsafe = true;
          }
          continue;
        }
        if (!event.etag.trim() || !this.hasUsableCalendarInterval(event, calendar)) {
          unsafe = true;
          continue;
        }

        const candidate: CalendarEventCandidate = {
          calendarId: calendar.id,
          calendarSummary: calendar.summary,
          calendarTimeZone: calendar.timeZone,
          domain: "calendar_event",
          end: event.end,
          eventId: event.id,
          expectedEtag: event.etag,
          hasExternalGuests: hasExternalGuests(event),
          ...(event.recurrence ? { recurrence: [...event.recurrence] } : {}),
          ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
          start: event.start,
          summary: event.summary,
        };
        candidates.set(`${calendar.id}:${event.id}`, candidate);
      }
    }

    return {
      candidates: [...candidates.values()],
      status: failed ? "failed" : unsafe ? "unsafe" : "complete",
    };
  }

  private futureCalendarRange(now: Date): { readonly timeMax: string; readonly timeMin: string } {
    const timeMax = DateTime.fromJSDate(now, { zone: "utc" })
      .plus({ years: MATERIALIZATION_HORIZON_YEARS })
      .toUTC()
      .toISO();
    if (!timeMax) {
      throw new Error("Could not calculate Calendar resolution horizon");
    }
    return { timeMax, timeMin: now.toISOString() };
  }

  private hasUsableCalendarInterval(event: CalendarEvent, calendar: CalendarReference): boolean {
    try {
      const start = calendarDateTimeToDateTime(event.start, calendar.timeZone);
      const end = calendarDateTimeToDateTime(event.end, calendar.timeZone);
      return end > start;
    } catch {
      return false;
    }
  }

  private sortCandidates(candidates: readonly NamedDeleteCandidate[]): readonly NamedDeleteCandidate[] {
    const domainOrder: Record<NamedDeleteCandidate["domain"], number> = {
      legacy_task: 0,
      scheduled_reminder: 1,
      calendar_event: 2,
    };
    return [...candidates].sort((first, second) => {
      const domainDifference = domainOrder[first.domain] - domainOrder[second.domain];
      if (domainDifference !== 0) {
        return domainDifference;
      }
      const firstDate = candidateSortDate(first);
      const secondDate = candidateSortDate(second);
      if (firstDate !== secondDate) {
        return firstDate.localeCompare(secondDate);
      }
      const firstTitle = first.domain === "calendar_event" ? first.summary : first.title;
      const secondTitle = second.domain === "calendar_event" ? second.summary : second.title;
      return `${firstTitle}\u0000${candidateIdentity(first)}`.localeCompare(`${secondTitle}\u0000${candidateIdentity(second)}`);
    });
  }
}

export function candidateSortDate(candidate: NamedDeleteCandidate): string {
  switch (candidate.domain) {
    case "legacy_task":
      return candidate.dueAt;
    case "scheduled_reminder":
      return candidate.dueAt ?? `${candidate.scheduledDate}T00:00:00.000Z`;
    case "calendar_event":
      return candidate.start.kind === "timed" ? candidate.start.dateTime : `${candidate.start.date}T00:00:00.000Z`;
  }
}

export function candidateIdentity(candidate: NamedDeleteCandidate): string {
  switch (candidate.domain) {
    case "legacy_task":
      return candidate.taskId;
    case "scheduled_reminder":
      return candidate.itemId;
    case "calendar_event":
      return `${candidate.calendarId}:${candidate.eventId}`;
  }
}

function isValidIsoDate(value: string, timeZone = "UTC"): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = DateTime.fromFormat(value, "yyyy-LL-dd", { setZone: true, zone: timeZone });
  return parsed.isValid && parsed.toFormat("yyyy-LL-dd") === value;
}

function parseRelativeDateTerm(value: string, now?: Date, timeZone?: string): string | undefined {
  if (!now || !timeZone || !Number.isFinite(now.valueOf())) {
    return undefined;
  }
  const localNow = DateTime.fromJSDate(now, { zone: timeZone });
  if (!localNow.isValid) {
    return undefined;
  }
  switch (value) {
    case "today":
      return localNow.toFormat("yyyy-LL-dd");
    case "tomorrow":
      return localNow.plus({ days: 1 }).toFormat("yyyy-LL-dd");
    case "yesterday":
      return localNow.minus({ days: 1 }).toFormat("yyyy-LL-dd");
    default:
      return undefined;
  }
}
