import { google, type calendar_v3 } from "googleapis";

import { splitRecurrenceAt } from "../calendar/recurrence.js";
import type {
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventDateTime,
  CalendarEventPatch,
  CalendarReference,
  CalendarSendUpdates,
} from "../domain/calendar.js";
import type {
  AppStateRepository,
  GoogleOAuthCredentials,
} from "../persistence/state-repository.js";
import type { GoogleOAuthClientConfig } from "./oauth-service.js";

export interface CalendarReader {
  listCalendars(): Promise<readonly CalendarReference[]>;
}

export interface ListCalendarEventsInput {
  readonly calendarId: string;
  readonly timeMax: string;
  readonly timeMin: string;
}

export interface CreateCalendarEventInput {
  readonly attendees?: readonly CalendarEventAttendee[];
  readonly calendarId: string;
  readonly description?: string;
  readonly end: CalendarEventDateTime;
  readonly recurrence?: readonly string[];
  readonly sendUpdates?: CalendarSendUpdates;
  readonly start: CalendarEventDateTime;
  readonly summary: string;
}

export interface UpdateCalendarEventInput {
  readonly calendarId: string;
  readonly etag: string;
  readonly eventId: string;
  readonly patch: CalendarEventPatch;
  readonly sendUpdates: CalendarSendUpdates;
}

export interface DeleteCalendarEventInput {
  readonly calendarId: string;
  readonly etag: string;
  readonly eventId: string;
  readonly sendUpdates: CalendarSendUpdates;
}

export interface SplitRecurringEventInput {
  readonly calendarId: string;
  readonly master: CalendarEvent;
  readonly patch: CalendarEventPatch;
  readonly sendUpdates: CalendarSendUpdates;
  readonly targetOccurrence: CalendarEvent;
}

export interface TruncateRecurringEventInput {
  readonly calendarId: string;
  readonly master: CalendarEvent;
  readonly sendUpdates: CalendarSendUpdates;
  readonly targetOccurrence: CalendarEvent;
}

export interface CalendarGateway extends CalendarReader {
  createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent>;
  deleteEvent(input: DeleteCalendarEventInput): Promise<void>;
  getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent>;
  listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]>;
  splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent>;
  truncateRecurringEvent(input: TruncateRecurringEventInput): Promise<void>;
  updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent>;
}

export interface GoogleCalendarListEntry {
  readonly accessRole?: string | null;
  readonly id?: string | null;
  readonly primary?: boolean | null;
  readonly summary?: string | null;
  readonly timeZone?: string | null;
}

interface GoogleCalendarEventDateTime {
  readonly date?: string | null;
  readonly dateTime?: string | null;
  readonly timeZone?: string | null;
}

interface GoogleCalendarEvent {
  readonly attendees?: readonly {
    readonly email?: string | null;
    readonly optional?: boolean | null;
    readonly responseStatus?: string | null;
    readonly self?: boolean | null;
  }[] | null;
  readonly description?: string | null;
  readonly end?: GoogleCalendarEventDateTime | null;
  readonly etag?: string | null;
  readonly id?: string | null;
  readonly originalStartTime?: GoogleCalendarEventDateTime | null;
  readonly recurrence?: readonly string[] | null;
  readonly recurringEventId?: string | null;
  readonly start?: GoogleCalendarEventDateTime | null;
  readonly status?: string | null;
  readonly summary?: string | null;
}

export interface GoogleCalendarApiOptions extends GoogleOAuthClientConfig {
  readonly stateRepository: Pick<AppStateRepository, "getGoogleOAuth" | "saveGoogleOAuth">;
}

export class GoogleCalendarConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarConnectionError";
  }
}

export function buildIfMatchOptions(etag: string): { readonly headers: { readonly "If-Match": string } } {
  if (!etag.trim()) {
    throw new GoogleCalendarConnectionError("Google Calendar did not provide an event version marker");
  }
  return { headers: { "If-Match": etag } };
}

export function isCalendarPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly response?: { readonly status?: unknown };
    readonly status?: unknown;
  };
  return candidate.code === 412 || candidate.status === 412 || candidate.response?.status === 412;
}

export function normalizeGoogleCalendarReference(
  entry: GoogleCalendarListEntry,
): CalendarReference | undefined {
  if (!entry.id) {
    return undefined;
  }

  const accessRole = entry.accessRole ?? "reader";
  return {
    id: entry.id,
    isPrimary: Boolean(entry.primary),
    readOnly: accessRole === "freeBusyReader" || accessRole === "reader",
    summary: entry.summary ?? entry.id,
    timeZone: entry.timeZone ?? "UTC",
  };
}

function normalizeDateTime(
  value: GoogleCalendarEventDateTime | null | undefined,
  fallbackTimeZone: string,
): CalendarEventDateTime | undefined {
  if (!value) {
    return undefined;
  }

  const timeZone = value.timeZone ?? fallbackTimeZone;
  if (value.dateTime) {
    return { dateTime: value.dateTime, kind: "timed", timeZone };
  }
  if (value.date) {
    return { date: value.date, kind: "all_day", timeZone };
  }
  return undefined;
}

function normalizeResponseStatus(
  value: string | null | undefined,
): CalendarEventAttendee["responseStatus"] | undefined {
  return value === "accepted" || value === "declined" || value === "needsAction" || value === "tentative"
    ? value
    : undefined;
}

function normalizeAttendees(
  attendees: GoogleCalendarEvent["attendees"],
): readonly CalendarEventAttendee[] {
  return (attendees ?? []).flatMap((attendee) => {
    if (!attendee.email) {
      return [];
    }

    const responseStatus = normalizeResponseStatus(attendee.responseStatus);
    const normalized: CalendarEventAttendee = {
      email: attendee.email,
      ...(attendee.optional !== null && attendee.optional !== undefined
        ? { optional: attendee.optional }
        : {}),
      ...(responseStatus ? { responseStatus } : {}),
      ...(attendee.self !== null && attendee.self !== undefined ? { self: attendee.self } : {}),
    };
    return [normalized];
  });
}

export function normalizeGoogleCalendarEvent(
  entry: GoogleCalendarEvent,
  calendarId: string,
): CalendarEvent | undefined {
  if (!entry.id || !entry.start || !entry.end) {
    return undefined;
  }

  const fallbackTimeZone = entry.start.timeZone ?? entry.end.timeZone ?? "UTC";
  const start = normalizeDateTime(entry.start, fallbackTimeZone);
  const end = normalizeDateTime(entry.end, fallbackTimeZone);
  const originalStart = normalizeDateTime(entry.originalStartTime, fallbackTimeZone);
  if (!start || !end) {
    return undefined;
  }

  const status = entry.status === "cancelled" || entry.status === "tentative" ? entry.status : "confirmed";
  return {
    attendees: normalizeAttendees(entry.attendees),
    calendarId,
    ...(entry.description ? { description: entry.description } : {}),
    end,
    etag: entry.etag ?? "",
    id: entry.id,
    ...(originalStart ? { originalStart } : {}),
    ...(entry.recurrence?.length ? { recurrence: entry.recurrence } : {}),
    ...(entry.recurringEventId ? { recurringEventId: entry.recurringEventId } : {}),
    start,
    status,
    summary: entry.summary ?? "Untitled event",
  };
}

function toGoogleDateTime(value: CalendarEventDateTime): calendar_v3.Schema$EventDateTime {
  return value.kind === "timed"
    ? { dateTime: value.dateTime, timeZone: value.timeZone }
    : { date: value.date, timeZone: value.timeZone };
}

function toGoogleAttendee(attendee: CalendarEventAttendee): calendar_v3.Schema$EventAttendee {
  return {
    email: attendee.email,
    ...(attendee.optional !== undefined ? { optional: attendee.optional } : {}),
    ...(attendee.responseStatus ? { responseStatus: attendee.responseStatus } : {}),
  };
}

function toGooglePatch(patch: CalendarEventPatch): calendar_v3.Schema$Event {
  return {
    ...(patch.attendees ? { attendees: patch.attendees.map(toGoogleAttendee) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.end ? { end: toGoogleDateTime(patch.end) } : {}),
    ...(patch.recurrence ? { recurrence: [...patch.recurrence] } : {}),
    ...(patch.start ? { start: toGoogleDateTime(patch.start) } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
  };
}

/** Google Calendar API adapter used by the Discord command layer. */
/** Collects all Google list pages and fails closed on a malformed token cycle. */
export async function collectGooglePages<T>(
  fetchPage: (pageToken: string | undefined) => Promise<{
    readonly items?: readonly T[] | null | undefined;
    readonly nextPageToken?: string | null | undefined;
  }>,
): Promise<readonly T[]> {
  const values: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(pageToken);
    values.push(...(page.items ?? []));
    const next = page.nextPageToken ?? undefined;
    if (next && seenTokens.has(next)) {
      throw new GoogleCalendarConnectionError("Google Calendar returned a repeated page token");
    }
    if (next) {
      seenTokens.add(next);
    }
    pageToken = next;
  } while (pageToken);
  return values;
}

export class GoogleCalendarApi implements CalendarGateway {
  public constructor(private readonly options: GoogleCalendarApiOptions) { }

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    const calendar = this.createAuthenticatedCalendarClient();
    const entries = await collectGooglePages<GoogleCalendarListEntry>(async (pageToken) => {
      const response = await calendar.calendarList.list({
        ...(pageToken ? { pageToken } : {}),
        showHidden: false,
      });
      return {
        items: response.data.items as readonly GoogleCalendarListEntry[] | null | undefined,
        nextPageToken: response.data.nextPageToken,
      };
    });
    return entries.flatMap((entry) => {
      const normalized = normalizeGoogleCalendarReference(entry);
      return normalized ? [normalized] : [];
    });
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    const calendar = this.createAuthenticatedCalendarClient();
    const entries = await collectGooglePages<GoogleCalendarEvent>(async (pageToken) => {
      const response = await calendar.events.list({
        calendarId: input.calendarId,
        orderBy: "startTime",
        ...(pageToken ? { pageToken } : {}),
        showDeleted: false,
        singleEvents: true,
        timeMax: input.timeMax,
        timeMin: input.timeMin,
      });
      return {
        items: response.data.items as readonly GoogleCalendarEvent[] | null | undefined,
        nextPageToken: response.data.nextPageToken,
      };
    });
    return entries.flatMap((entry) => {
      const normalized = normalizeGoogleCalendarEvent(entry, input.calendarId);
      return normalized ? [normalized] : [];
    });
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const calendar = this.createAuthenticatedCalendarClient();
    const response = await calendar.events.get({
      calendarId: input.calendarId,
      eventId: input.eventId,
    });
    const normalized = normalizeGoogleCalendarEvent(response.data, input.calendarId);
    if (!normalized) {
      throw new GoogleCalendarConnectionError("Google returned an invalid calendar event");
    }
    return normalized;
  }

  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    const calendar = this.createAuthenticatedCalendarClient();
    const response = await calendar.events.insert({
      calendarId: input.calendarId,
      ...(input.sendUpdates ? { sendUpdates: input.sendUpdates } : {}),
      requestBody: {
        ...(input.attendees ? { attendees: input.attendees.map(toGoogleAttendee) } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        end: toGoogleDateTime(input.end),
        ...(input.recurrence ? { recurrence: [...input.recurrence] } : {}),
        start: toGoogleDateTime(input.start),
        summary: input.summary,
      },
    });
    const normalized = normalizeGoogleCalendarEvent(response.data, input.calendarId);
    if (!normalized) {
      throw new GoogleCalendarConnectionError("Google did not return the created event");
    }
    return normalized;
  }

  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    const calendar = this.createAuthenticatedCalendarClient();
    const response = await calendar.events.patch(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        requestBody: toGooglePatch(input.patch),
        sendUpdates: input.sendUpdates,
      },
      buildIfMatchOptions(input.etag),
    );
    const normalized = normalizeGoogleCalendarEvent(response.data, input.calendarId);
    if (!normalized) {
      throw new GoogleCalendarConnectionError("Google did not return the updated event");
    }
    return normalized;
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    const calendar = this.createAuthenticatedCalendarClient();
    await calendar.events.delete(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        sendUpdates: input.sendUpdates,
      },
      buildIfMatchOptions(input.etag),
    );
  }

  public async splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent> {
    const recurrence = splitRecurrenceAt(input.master, input.targetOccurrence, input.master.start.timeZone);
    const futureStart = input.patch.start ?? input.targetOccurrence.start;
    const futureEnd = input.patch.end ?? input.targetOccurrence.end;
    const futureDescription = input.patch.description ?? input.master.description;
    const futureAttendees = input.patch.attendees ?? input.master.attendees;
    const future = await this.createEvent({
      ...(futureAttendees.length > 0 ? { attendees: futureAttendees } : {}),
      calendarId: input.calendarId,
      ...(futureDescription !== undefined ? { description: futureDescription } : {}),
      end: futureEnd,
      recurrence: recurrence.futureRecurrence,
      sendUpdates: input.sendUpdates,
      start: futureStart,
      summary: input.patch.summary ?? input.master.summary,
    });

    try {
      await this.updateEvent({
        calendarId: input.calendarId,
        etag: input.master.etag,
        eventId: input.master.id,
        patch: { recurrence: recurrence.precedingRecurrence },
        sendUpdates: input.sendUpdates,
      });
    } catch (error: unknown) {
      if (future.etag.trim()) {
        try {
          await this.deleteEvent({
            calendarId: input.calendarId,
            etag: future.etag,
            eventId: future.id,
            sendUpdates: "none",
          });
        } catch {
          // The original error is the actionable one. A cleanup failure is logged by the caller.
        }
      }
      throw error;
    }

    return future;
  }

  public async truncateRecurringEvent(input: TruncateRecurringEventInput): Promise<void> {
    const recurrence = splitRecurrenceAt(input.master, input.targetOccurrence, input.master.start.timeZone);
    await this.updateEvent({
      calendarId: input.calendarId,
      etag: input.master.etag,
      eventId: input.master.id,
      patch: { recurrence: recurrence.precedingRecurrence },
      sendUpdates: input.sendUpdates,
    });
  }

  private createAuthenticatedCalendarClient() {
    const credentials = this.options.stateRepository.getGoogleOAuth();
    if (!credentials) {
      throw new GoogleCalendarConnectionError("Google Calendar is not connected");
    }

    const auth = new google.auth.OAuth2(
      this.options.clientId,
      this.options.clientSecret,
      this.options.redirectUri,
    );
    const expiryDate = credentials.expiresAt ? Date.parse(credentials.expiresAt) : undefined;
    auth.setCredentials({
      access_token: credentials.accessToken,
      ...(expiryDate !== undefined && Number.isFinite(expiryDate)
        ? { expiry_date: expiryDate }
        : {}),
      ...(credentials.refreshToken ? { refresh_token: credentials.refreshToken } : {}),
    });
    auth.on("tokens", (tokens) => {
      this.persistRefreshedCredentials(credentials, tokens);
    });

    return google.calendar({ auth, version: "v3" });
  }

  private persistRefreshedCredentials(
    current: GoogleOAuthCredentials,
    tokens: {
      readonly access_token?: string | null;
      readonly expiry_date?: number | null;
      readonly refresh_token?: string | null;
      readonly scope?: string | null;
    },
  ): void {
    if (!tokens.access_token && !tokens.refresh_token) {
      return;
    }

    this.options.stateRepository.saveGoogleOAuth({
      accessToken: tokens.access_token ?? current.accessToken,
      ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date).toISOString() } : {}),
      ...(tokens.refresh_token || current.refreshToken
        ? { refreshToken: tokens.refresh_token ?? current.refreshToken }
        : {}),
      ...(tokens.scope || current.scope ? { scope: tokens.scope ?? current.scope } : {}),
    });
  }
}
