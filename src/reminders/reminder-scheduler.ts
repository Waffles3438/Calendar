import { DateTime } from "luxon";
import type { Logger } from "pino";

import {
  eventOccurrenceStart,
  eventStartForReminder,
  formatEventStart,
} from "../calendar/event-time.js";
import type { CalendarEvent, CalendarReference } from "../domain/calendar.js";
import type { CalendarGateway } from "../google/calendar-api.js";
import { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";

export interface ReminderStateRepository {
  getReminderOverride(input: {
    calendarId: string;
    eventId: string;
    occurrenceStart?: string;
  }): number | undefined;
  hasReminderDelivery(deliveryKey: string): boolean;
  recordReminderDelivery(input: {
    deliveryKey: string;
    eventId: string;
    scheduledFor: string;
  }): boolean;
}

export interface ReminderSchedulerOptions {
  readonly calendarGateway: Pick<CalendarGateway, "listCalendars" | "listEvents">;
  readonly defaultMinutesBefore?: number;
  readonly lateGraceMinutes?: number;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly pollIntervalMilliseconds?: number;
  readonly sendOwnerMessage: (content: string) => Promise<void>;
  readonly stateRepository: ReminderStateRepository;
}

export interface ReminderRunResult {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Polls an upcoming window wide enough to honor every supported local reminder override. */
export class ReminderScheduler {
  private readonly defaultMinutesBefore: number;
  private readonly lateGraceMinutes: number;
  private readonly now: () => Date;
  private readonly pollIntervalMilliseconds: number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: ReminderSchedulerOptions) {
    this.defaultMinutesBefore = options.defaultMinutesBefore ?? 15;
    this.lateGraceMinutes = options.lateGraceMinutes ?? 30;
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 60_000;
  }

  public start(): void {
    if (this.timer) {
      return;
    }

    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMilliseconds);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async runOnce(): Promise<ReminderRunResult> {
    if (this.running) {
      return { delivered: 0, failed: 0, skipped: 0 };
    }

    this.running = true;
    try {
      return await this.runScheduledReminders();
    } finally {
      this.running = false;
    }
  }

  private async runScheduledReminders(): Promise<ReminderRunResult> {
    const result = { delivered: 0, failed: 0, skipped: 0 };
    const now = DateTime.fromJSDate(this.now()).toUTC();
    const lookback = now.minus({ minutes: this.lateGraceMinutes });
    const horizon = now.plus({ minutes: Math.max(48 * 60, MAX_REMINDER_MINUTES) });

    let calendars: readonly CalendarReference[];
    try {
      calendars = await this.options.calendarGateway.listCalendars();
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not list calendars for reminders");
      return { ...result, failed: 1 };
    }

    for (const calendar of calendars) {
      try {
        const events = await this.options.calendarGateway.listEvents({
          calendarId: calendar.id,
          timeMax: horizon.toISO() ?? "",
          timeMin: lookback.minus({ hours: 2 }).toISO() ?? "",
        });
        for (const event of events) {
          const delivery = await this.tryDeliverEventReminder(event, calendar, now, lookback);
          result.delivered += delivery.delivered;
          result.failed += delivery.failed;
          result.skipped += delivery.skipped;
        }
      } catch (error: unknown) {
        this.options.logger.error({ calendarId: calendar.id, error }, "Could not process calendar reminders");
        result.failed += 1;
      }
    }

    return result;
  }

  private async tryDeliverEventReminder(
    event: CalendarEvent,
    calendar: CalendarReference,
    now: DateTime,
    lookback: DateTime,
  ): Promise<ReminderRunResult> {
    if (event.status === "cancelled" || event.attendees.some((attendee) => attendee.self && attendee.responseStatus === "declined")) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    const occurrenceStart = eventOccurrenceStart(event);
    const minutesBefore =
      this.options.stateRepository.getReminderOverride({
        calendarId: calendar.id,
        eventId: event.id,
        occurrenceStart,
      }) ?? this.defaultMinutesBefore;
    const reminderAt = eventStartForReminder(event, calendar.timeZone)
      .minus({ minutes: minutesBefore })
      .toUTC();

    if (reminderAt > now || reminderAt < lookback) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    const deliveryKey = `${calendar.id}:${event.id}:${occurrenceStart}:${minutesBefore}`;
    if (this.options.stateRepository.hasReminderDelivery(deliveryKey)) {
      return { delivered: 0, failed: 0, skipped: 1 };
    }

    try {
      const delayed = reminderAt < now.minus({ minutes: 1 });
      await this.options.sendOwnerMessage(
        `${delayed ? "Late reminder" : "Reminder"}: ${event.summary} starts ${formatEventStart(event, calendar.timeZone)}.`,
      );
      this.options.stateRepository.recordReminderDelivery({
        deliveryKey,
        eventId: event.id,
        scheduledFor: reminderAt.toISO() ?? "",
      });
      return { delivered: 1, failed: 0, skipped: 0 };
    } catch (error: unknown) {
      this.options.logger.error({ calendarId: calendar.id, error, eventId: event.id }, "Could not deliver reminder");
      return { delivered: 0, failed: 1, skipped: 0 };
    }
  }
}
