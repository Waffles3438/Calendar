import { DateTime } from "luxon";

import { calendarDateTimeToDateTime, formatEventStart } from "../calendar/event-time.js";
import type { CalendarEvent, CalendarReference } from "../domain/calendar.js";
import { formatDiscordDate, formatDiscordTimestamp } from "../discord/discord-timestamp.js";
import type { CalendarGateway } from "../google/calendar-api.js";
import type { LocalTask } from "../tasks/task-domain.js";
import { localTaskDateBounds } from "../tasks/task-time.js";
import type { ScheduledItem } from "./schedule-domain.js";
import type { SchedulingRepository } from "./scheduling-repository.js";

export interface LegacyTaskAgendaReader {
  listActiveLocalTasksInRange(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    limit: number;
    ownerId: string;
  }): readonly LocalTask[];
}

export interface AgendaServiceOptions {
  readonly calendarGateway?: CalendarGateway;
  readonly legacyTaskReader?: LegacyTaskAgendaReader;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly schedulingRepository: SchedulingRepository;
  readonly timeZone: string;
}

export interface AgendaDay {
  readonly date: string;
  readonly events: readonly AgendaCalendarEvent[];
  readonly reminders: readonly AgendaReminder[];
  readonly tasks: readonly AgendaTask[];
}

export interface AgendaTask {
  readonly id: string;
  readonly title: string;
}

export interface AgendaReminder {
  readonly id: string;
  readonly legacy?: boolean;
  readonly scheduledFor: Date;
  readonly title: string;
}

export interface AgendaCalendarEvent {
  readonly calendar: string;
  readonly event: CalendarEvent;
}

/** Read-only aggregation across local schedule records and all accessible calendars. */
export class AgendaService {
  private readonly now: () => Date;

  public constructor(private readonly options: AgendaServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async getDays(input: { date: string; endDate: string }): Promise<readonly AgendaDay[]> {
    const start = DateTime.fromFormat(input.date, "yyyy-LL-dd", { zone: this.options.timeZone }).startOf("day");
    const end = DateTime.fromFormat(input.endDate, "yyyy-LL-dd", { zone: this.options.timeZone }).startOf("day");
    const calendarDays = Math.round(end.diff(start, "days").days);
    if (!start.isValid || !end.isValid || end < start || calendarDays > 6) {
      throw new Error("Agenda date range is invalid");
    }
    this.options.schedulingRepository.ensureOccurrencesThrough({
      now: this.now(),
      ownerId: this.options.ownerId,
      throughDate: input.endDate,
    });

    const localItems = this.options.schedulingRepository.listActiveScheduledItems({
      ownerId: this.options.ownerId,
      scheduledDateEarliest: input.date,
      scheduledDateLatest: input.endDate,
    });
    const legacy = this.listLegacyReminders(start, end);
    // A Calendar read failure is intentionally propagated. Sending a partial agenda
    // and marking it delivered would hide data, especially in the 7 AM scheduler.
    const events = await this.listCalendarEvents(start, end);

    const days: AgendaDay[] = [];
    for (let day = start; day <= end; day = day.plus({ days: 1 })) {
      const date = day.toFormat("yyyy-LL-dd");
      const dayEnd = day.plus({ days: 1 });
      days.push({
        date,
        events: events
          .filter(({ event }) => eventOverlapsDay(event, day, dayEnd, this.options.timeZone))
          .sort((first, second) => eventStartMillis(first.event, this.options.timeZone) - eventStartMillis(second.event, this.options.timeZone) ||
            first.calendar.localeCompare(second.calendar) || first.event.summary.localeCompare(second.event.summary)),
        reminders: [
          ...localItems
            .filter((item) => item.kind === "reminder" && item.scheduledDate === date)
            .flatMap((item) => toReminder(item)),
          ...legacy.filter((task) => localTaskDate(task, this.options.timeZone) === date).map((task) => ({
            id: task.id,
            legacy: true,
            scheduledFor: task.dueAt,
            title: task.title,
          } satisfies AgendaReminder)),
        ].sort((first, second) => first.scheduledFor.valueOf() - second.scheduledFor.valueOf() || first.title.localeCompare(second.title)),
        tasks: localItems
          .filter((item) => item.kind === "task" && item.scheduledDate === date)
          .map((item) => ({ id: item.id, title: item.title } satisfies AgendaTask))
          .sort((first, second) => first.title.localeCompare(second.title)),
      });
    }
    return days;
  }

  public async render(input: { date: string; endDate: string; range: "day" | "week" }): Promise<string> {
    const days = await this.getDays(input);
    if (input.range === "day") {
      const day = days[0];
      if (!day) {
        return "No tasks, events, or reminders scheduled today.";
      }
      return this.renderDay(day, false);
    }
    return days.map((day) => this.renderDay(day, true)).join("\n\n");
  }

  private renderDay(day: AgendaDay, includeDateHeading: boolean): string {
    const taskLines = day.tasks.map((task) => `- ${task.title}`);
    const eventLines = day.events.map(({ calendar, event }) => `- [${calendar}] ${event.summary} — ${formatEvent(event, this.options.timeZone)}`);
    const reminderLines = day.reminders.map((reminder) => `- ${reminder.title} — ${formatDiscordTimestamp(reminder.scheduledFor)}`);
    const body = [
      "Tasks:",
      ...(taskLines.length > 0 ? taskLines : ["- None"]),
      "Events:",
      ...(eventLines.length > 0 ? eventLines : ["- None"]),
      "Reminders:",
      ...(reminderLines.length > 0 ? reminderLines : ["- None"]),
    ].join("\n");
    const displayDate = formatDiscordDate(day.date, this.options.timeZone);
    return includeDateHeading
      ? `${displayDate}:\n${body}`
      : `Agenda for ${displayDate}:\n${body}`;
  }

  private listLegacyReminders(start: DateTime, end: DateTime): readonly LocalTask[] {
    if (!this.options.legacyTaskReader) {
      return [];
    }
    const startBounds = localTaskDateBounds(start.toFormat("yyyy-LL-dd"), this.options.timeZone);
    const endBounds = localTaskDateBounds(end.toFormat("yyyy-LL-dd"), this.options.timeZone);
    if (!startBounds || !endBounds) {
      return [];
    }
    return this.options.legacyTaskReader.listActiveLocalTasksInRange({
      dueAtEarliest: startBounds.earliest,
      dueAtLatest: endBounds.latest,
      limit: 10_000,
      ownerId: this.options.ownerId,
    });
  }

  private async listCalendarEvents(start: DateTime, end: DateTime): Promise<readonly AgendaCalendarEvent[]> {
    if (!this.options.calendarGateway) {
      return [];
    }
    const calendars: readonly CalendarReference[] = await this.options.calendarGateway.listCalendars();
    const results = await Promise.all(calendars.map(async (calendar) => {
      const events = await this.options.calendarGateway!.listEvents({
        calendarId: calendar.id,
        timeMax: end.plus({ days: 1 }).toUTC().toISO() ?? "",
        timeMin: start.toUTC().toISO() ?? "",
      });
      return events
        .filter((event) => event.status !== "cancelled")
        .map((event) => ({ calendar: calendar.summary, event } satisfies AgendaCalendarEvent));
    }));
    return results.flat();
  }
}

function toReminder(item: ScheduledItem): readonly AgendaReminder[] {
  return item.dueAt ? [{ id: item.id, scheduledFor: item.dueAt, title: item.title }] : [];
}

function localTaskDate(task: LocalTask, timeZone: string): string {
  return DateTime.fromJSDate(task.dueAt, { zone: "utc" }).setZone(timeZone).toFormat("yyyy-LL-dd");
}

function eventOverlapsDay(event: CalendarEvent, dayStart: DateTime, dayEnd: DateTime, timeZone: string): boolean {
  const start = calendarDateTimeToDateTime(event.start, timeZone);
  const end = calendarDateTimeToDateTime(event.end, timeZone);
  return start < dayEnd && end > dayStart;
}

function eventStartMillis(event: CalendarEvent, timeZone: string): number {
  return calendarDateTimeToDateTime(event.start, timeZone).toMillis();
}

function formatEvent(event: CalendarEvent, timeZone: string): string {
  return formatEventStart(event, timeZone);
}
