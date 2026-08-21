import { createHash } from "node:crypto";

import type {
  CalendarEvent,
  CalendarReference,
} from "../domain/calendar.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  ListCalendarEventsInput,
  SplitRecurringEventInput,
  TruncateRecurringEventInput,
  UpdateCalendarEventInput,
} from "./calendar-api.js";

/**
 * Process-local change generation for Calendar-dependent interpretation cache
 * entries. Event contents are never stored; only short fingerprints are kept.
 */
export class CalendarChangeTracker {
  private readonly eventCollectionFingerprints = new Map<string, string>();
  private readonly eventFingerprints = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private calendarFingerprint: string | undefined;
  private generation = 0;

  public getGeneration(): number {
    return this.generation;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Explicitly invalidates Calendar-dependent cached actions. */
  public markChanged(): void {
    this.generation += 1;
    this.calendarFingerprint = undefined;
    this.eventCollectionFingerprints.clear();
    this.eventFingerprints.clear();
    for (const listener of this.listeners) {
      listener();
    }
  }

  public observeCalendars(calendars: readonly CalendarReference[]): void {
    const fingerprint = digest(JSON.stringify(calendars
      .map((calendar) => ({
        id: calendar.id,
        isPrimary: calendar.isPrimary,
        readOnly: calendar.readOnly,
        summary: calendar.summary,
        timeZone: calendar.timeZone,
      }))
      .sort((first, second) => first.id.localeCompare(second.id))));
    this.recordFingerprint(
      this.calendarFingerprint,
      fingerprint,
      () => {
        this.calendarFingerprint = fingerprint;
      },
    );
  }

  public observeEvents(input: ListCalendarEventsInput, events: readonly CalendarEvent[]): void {
    const key = `${input.calendarId}\u0000${input.timeMin}\u0000${input.timeMax}`;
    const fingerprint = digest(JSON.stringify(events
      .map(eventFingerprint)
      .sort((first, second) => first.id.localeCompare(second.id))));
    const previous = this.eventCollectionFingerprints.get(key);
    if (previous !== undefined && previous !== fingerprint) {
      this.markChanged();
    }
    this.eventCollectionFingerprints.set(key, fingerprint);
  }

  public observeEvent(event: CalendarEvent): void {
    const key = `${event.calendarId}\u0000${event.id}`;
    const fingerprint = digest(JSON.stringify(eventFingerprint(event)));
    const previous = this.eventFingerprints.get(key);
    if (previous !== undefined && previous !== fingerprint) {
      this.markChanged();
    }
    this.eventFingerprints.set(key, fingerprint);
  }

  private recordFingerprint(
    previous: string | undefined,
    next: string,
    save: () => void,
  ): void {
    if (previous !== undefined && previous !== next) {
      this.markChanged();
    }
    save();
  }
}

/** Adds change observation and successful-mutation invalidation to any gateway. */
export class TrackedCalendarGateway implements CalendarGateway {
  public constructor(
    private readonly delegate: CalendarGateway,
    private readonly tracker: CalendarChangeTracker,
  ) { }

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    const calendars = await this.delegate.listCalendars();
    this.tracker.observeCalendars(calendars);
    return calendars;
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    const events = await this.delegate.listEvents(input);
    this.tracker.observeEvents(input, events);
    return events;
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const event = await this.delegate.getEvent(input);
    this.tracker.observeEvent(event);
    return event;
  }

  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    const event = await this.delegate.createEvent(input);
    this.tracker.markChanged();
    return event;
  }

  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    const event = await this.delegate.updateEvent(input);
    this.tracker.markChanged();
    return event;
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    await this.delegate.deleteEvent(input);
    this.tracker.markChanged();
  }

  public async splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent> {
    const event = await this.delegate.splitRecurringEvent(input);
    this.tracker.markChanged();
    return event;
  }

  public async truncateRecurringEvent(input: TruncateRecurringEventInput): Promise<void> {
    await this.delegate.truncateRecurringEvent(input);
    this.tracker.markChanged();
  }
}

function eventFingerprint(event: CalendarEvent): {
  readonly end: CalendarEvent["end"];
  readonly etag: string;
  readonly id: string;
  readonly recurringEventId?: string;
  readonly start: CalendarEvent["start"];
  readonly status: CalendarEvent["status"];
  readonly summary: string;
} {
  return {
    end: event.end,
    etag: event.etag,
    id: event.id,
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    start: event.start,
    status: event.status,
    summary: event.summary,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
