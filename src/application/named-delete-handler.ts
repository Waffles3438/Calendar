import { randomUUID } from "node:crypto";

import { formatEventStart } from "../calendar/event-time.js";
import { formatDiscordDate, formatDiscordTimestamp } from "../discord/discord-timestamp.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { CalendarEvent, CalendarEventDateTime, CalendarReference } from "../domain/calendar.js";
import type { CalendarGateway } from "../google/calendar-api.js";
import type { NaturalLanguageAction } from "../nlp/natural-language-action.js";
import type { PendingAction } from "../persistence/state-repository.js";
import type { LocalTask } from "../tasks/task-domain.js";
import type { ScheduledItem } from "../scheduling/schedule-domain.js";
import { localTaskDate } from "../tasks/task-time.js";
import type {
  CalendarEventCandidate,
  LegacyTaskCandidate,
  NamedDeleteCandidate,
  NamedDeleteRequest,
  NamedDeleteResolution,
  NamedDeleteResolver,
  ScheduledReminderCandidate,
} from "./named-delete-resolver.js";
import {
  isNamedDeleteCalendarEventForDate,
  isNamedDeleteCalendarEventFuture,
  namedDeleteTitleMatches,
  normalizeNamedDeleteSelector,
} from "./named-delete-resolver.js";
import type { PendingActionInstruction, PendingActionMessageHandler } from "./pending-action.js";
import { markGeminiResponseUsed } from "./gemini-response-attribution.js";

export type NamedDeleteAction = Extract<NaturalLanguageAction, { action: "delete_task" }>;

export interface NamedDeletePendingRepository {
  consumePendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
  createPendingAction(input: {
    expiresAt: Date;
    id: string;
    ownerId: string;
    payload: unknown;
  }): void;
  getPendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
}

export interface NamedDeleteExactAdapters {
  readonly calendarAssistant?: {
    handleResolvedNamedDeletion(
      message: OwnerDirectMessage,
      candidate: CalendarEventCandidate,
      selectorDate?: string,
    ): Promise<void>;
  };
  readonly localTaskAssistant?: {
    handleResolvedNamedCancellation(message: OwnerDirectMessage, candidate: LegacyTaskCandidate): Promise<void>;
  };
  readonly scheduleAssistant?: {
    handleResolvedNamedReminderCancellation(
      message: OwnerDirectMessage,
      candidate: ScheduledReminderCandidate,
      selectorDate?: string,
    ): Promise<void>;
  };
}

export interface NamedDeleteHandlerOptions extends NamedDeleteExactAdapters {
  readonly calendarGateway?: Pick<CalendarGateway, "getEvent" | "listCalendars">;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pendingActionTtlMilliseconds?: number;
  readonly resolver: NamedDeleteResolver;
  readonly stateRepository: NamedDeletePendingRepository & {
    getLocalTask?(input: { id: string; ownerId: string }): LocalTask | undefined;
  };
  readonly schedulingRepository?: {
    getScheduledItem(input: { id: string; ownerId: string }): ScheduledItem | undefined;
  };
  readonly timeZone: string;
}

export interface NamedDeleteSelectionPendingPayload {
  readonly candidates: readonly NamedDeleteCandidate[];
  readonly kind: "named_delete_selection";
  readonly selectorDate?: string;
  readonly selectorTerms: readonly string[];
  readonly selectorTitle: string;
  readonly source: "gemini";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCalendarDateTime(value: unknown): value is CalendarEventDateTime {
  if (!isRecord(value) || typeof value.timeZone !== "string" || value.timeZone.trim().length === 0) {
    return false;
  }
  if (value.kind === "timed") {
    return typeof value.dateTime === "string" && value.dateTime.trim().length > 0;
  }
  return value.kind === "all_day" && typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.date);
}

export function isNamedDeleteCandidate(value: unknown): value is NamedDeleteCandidate {
  if (!isRecord(value) || typeof value.domain !== "string") {
    return false;
  }
  if (value.domain === "legacy_task") {
    return typeof value.taskId === "string" && value.taskId.trim().length > 0 &&
      typeof value.expectedRevision === "number" && Number.isInteger(value.expectedRevision) && value.expectedRevision > 0 &&
      typeof value.title === "string" && value.title.trim().length > 0 &&
      typeof value.dueAt === "string" && Number.isFinite(Date.parse(value.dueAt)) &&
      typeof value.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.localDate) &&
      typeof value.timeZone === "string" && value.timeZone.trim().length > 0;
  }
  if (value.domain === "scheduled_reminder") {
    return typeof value.itemId === "string" && value.itemId.trim().length > 0 &&
      typeof value.expectedRevision === "number" && Number.isInteger(value.expectedRevision) && value.expectedRevision > 0 &&
      typeof value.title === "string" && value.title.trim().length > 0 &&
      typeof value.scheduledDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.scheduledDate) &&
      typeof value.timeZone === "string" && value.timeZone.trim().length > 0 &&
      (!(["dueAt"] as const).some((key) => key in value) || typeof value.dueAt === "string" && Number.isFinite(Date.parse(value.dueAt)));
  }
  if (value.domain === "calendar_event") {
    return typeof value.calendarId === "string" && value.calendarId.trim().length > 0 &&
      typeof value.eventId === "string" && value.eventId.trim().length > 0 &&
      typeof value.expectedEtag === "string" && value.expectedEtag.trim().length > 0 &&
      typeof value.calendarSummary === "string" && value.calendarSummary.trim().length > 0 &&
      typeof value.calendarTimeZone === "string" && value.calendarTimeZone.trim().length > 0 &&
      typeof value.summary === "string" && value.summary.trim().length > 0 &&
      typeof value.hasExternalGuests === "boolean" &&
      isCalendarDateTime(value.start) && isCalendarDateTime(value.end) &&
      (!(["recurringEventId"] as const).some((key) => key in value) || typeof value.recurringEventId === "string") &&
      (!(["recurrence"] as const).some((key) => key in value) || Array.isArray(value.recurrence) && value.recurrence.every((item) => typeof item === "string"));
  }
  return false;
}

export function isNamedDeleteSelectionPendingPayload(value: unknown): value is NamedDeleteSelectionPendingPayload {
  return isRecord(value) && value.kind === "named_delete_selection" && value.source === "gemini" &&
    typeof value.selectorTitle === "string" && value.selectorTitle.trim().length > 0 &&
    Array.isArray(value.selectorTerms) && value.selectorTerms.length > 0 &&
    value.selectorTerms.every((term) => typeof term === "string" && term.trim().length > 0) &&
    (!(["selectorDate"] as const).some((key) => key in value) || typeof value.selectorDate === "string") &&
    Array.isArray(value.candidates) && value.candidates.length > 1 && value.candidates.every(isNamedDeleteCandidate);
}

/** Builds a resolver request while enforcing the action/date boundary. */
export function namedDeleteRequestFromAction(
  action: NamedDeleteAction,
  ownerId: string,
  now: Date,
  timeZone: string,
): NamedDeleteRequest | undefined {
  if (action.action !== "delete_task" || action.scope !== "single" || !action.selector || !action.selector.title.trim()) {
    return undefined;
  }
  if (action.date && action.selector.date && action.date !== action.selector.date) {
    return undefined;
  }
  const explicitDate = action.date ?? action.selector.date;
  const selector = normalizeNamedDeleteSelector({
    ...(explicitDate ? { date: explicitDate } : {}),
    now,
    timeZone,
    title: action.selector.title,
  });
  if (!selector) {
    return undefined;
  }
  return {
    now,
    ownerId,
    ...(selector.date ? { selectorDate: selector.date } : {}),
    selectorTitle: action.selector.title,
    source: "gemini",
    timeZone,
  };
}

/** Coordinates complete resolution, ambiguity review, and exact-domain routing. */
export class NamedDeleteHandler implements PendingActionMessageHandler {
  private readonly now: () => Date;
  private readonly pendingActionTtlMilliseconds: number;

  public constructor(private readonly options: NamedDeleteHandlerOptions) {
    this.now = options.now ?? (() => new Date());
    this.pendingActionTtlMilliseconds = options.pendingActionTtlMilliseconds ?? 10 * 60 * 1_000;
  }

  public canHandlePendingAction(payload: unknown): boolean {
    return isNamedDeleteSelectionPendingPayload(payload);
  }

  public async handleNaturalLanguageAction(message: OwnerDirectMessage, action: NamedDeleteAction): Promise<void> {
    const now = this.now();
    const request = namedDeleteRequestFromAction(action, this.options.ownerId, now, this.options.timeZone);
    if (!request) {
      await message.reply("Please include one specific item title and, if needed, one consistent date. No changes were made.");
      return;
    }

    let resolution: NamedDeleteResolution;
    try {
      resolution = await this.options.resolver.resolve(request);
    } catch {
      await message.reply("I could not safely review every matching item. No changes were made; please try again.");
      return;
    }

    if (resolution.status === "read_failure" || resolution.status === "unsafe_calendar") {
      await message.reply("I could not safely review every matching item. No changes were made; please try again.");
      return;
    }
    if (resolution.status === "none") {
      await message.reply("I could not find an eligible matching item.");
      return;
    }
    if (resolution.status === "exact") {
      await this.routeExactCandidate(message, resolution.candidate, request.selectorDate);
      return;
    }

    await this.queueSelection(message, request, resolution.candidates);
  }

  public async handlePendingAction(
    message: OwnerDirectMessage,
    instruction: PendingActionInstruction,
  ): Promise<boolean> {
    let pending: PendingAction | undefined;
    try {
      pending = this.options.stateRepository.getPendingAction({
        id: instruction.actionId,
        now: this.now(),
        ownerId: this.options.ownerId,
      });
    } catch {
      return false;
    }
    if (!pending || !isNamedDeleteSelectionPendingPayload(pending.payload)) {
      return false;
    }
    markGeminiResponseUsed(message);

    if (instruction.kind === "cancel") {
      const consumed = this.consumeSelection(instruction.actionId);
      if (!consumed) {
        await message.reply("That action is invalid or has expired.");
        return true;
      }
      await message.reply("Cancelled. No task, reminder, or calendar event was changed.");
      return true;
    }
    if (instruction.kind !== "choose") {
      await message.reply("That selection is invalid or has expired.");
      return true;
    }

    const selected = pending.payload.candidates[instruction.choice - 1];
    if (!selected) {
      await message.reply("That selection number is not available. Reply with a number from the list.");
      return true;
    }
    const consumed = this.consumeSelection(instruction.actionId);
    if (!consumed || !isNamedDeleteSelectionPendingPayload(consumed.payload)) {
      await message.reply("That selection is invalid or has expired.");
      return true;
    }

    let current: NamedDeleteCandidate | undefined;
    try {
      current = await this.revalidateSelectedCandidate(
        selected,
        consumed.payload.selectorTerms,
        consumed.payload.selectorDate,
      );
    } catch {
      current = undefined;
    }
    if (!current) {
      await message.reply("That item changed before it could be selected. Please repeat the request.");
      return true;
    }

    await this.routeExactCandidate(message, current, consumed.payload.selectorDate);
    return true;
  }

  private async queueSelection(
    message: OwnerDirectMessage,
    request: NamedDeleteRequest,
    candidates: readonly NamedDeleteCandidate[],
  ): Promise<void> {
    const selector = normalizeNamedDeleteSelector({
      ...(request.selectorDate ? { date: request.selectorDate } : {}),
      now: request.now,
      timeZone: request.timeZone,
      title: request.selectorTitle,
    });
    if (!selector || candidates.length < 2) {
      await message.reply("I could not safely prepare that selection. Please repeat the request.");
      return;
    }
    if (this.options.dryRun) {
      await message.reply("Dry run: no task, reminder, or calendar event was changed; no selection was stored.");
      return;
    }

    const id = randomUUID();
    const payload: NamedDeleteSelectionPendingPayload = {
      candidates,
      kind: "named_delete_selection",
      ...(selector.date ? { selectorDate: selector.date } : {}),
      selectorTerms: selector.terms,
      selectorTitle: request.selectorTitle,
      source: "gemini",
    };
    try {
      this.options.stateRepository.createPendingAction({
        expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
        id,
        ownerId: this.options.ownerId,
        payload,
      });
    } catch {
      await message.reply("I could not safely prepare that selection. No changes were made; please try again.");
      return;
    }

    await message.reply(
      `I found multiple matching items. Reply choose ${id} followed by a number:\n${candidates
        .map((candidate, index) => `${index + 1}. ${candidateLabel(candidate)}`)
        .join("\n")}`,
    );
  }

  private async routeExactCandidate(
    message: OwnerDirectMessage,
    candidate: NamedDeleteCandidate,
    selectorDate?: string,
  ): Promise<void> {
    switch (candidate.domain) {
      case "legacy_task":
        if (this.options.localTaskAssistant) {
          await this.options.localTaskAssistant.handleResolvedNamedCancellation(message, candidate);
          return;
        }
        break;
      case "scheduled_reminder":
        if (this.options.scheduleAssistant) {
          await this.options.scheduleAssistant.handleResolvedNamedReminderCancellation(
            message,
            candidate,
            selectorDate,
          );
          return;
        }
        break;
      case "calendar_event":
        if (this.options.calendarAssistant) {
          await this.options.calendarAssistant.handleResolvedNamedDeletion(message, candidate, selectorDate);
          return;
        }
        break;
    }
    await message.reply("I could not safely route that item. No changes were made; please try again.");
  }

  private consumeSelection(actionId: string): PendingAction | undefined {
    try {
      const pending = this.options.stateRepository.consumePendingAction({
        id: actionId,
        now: this.now(),
        ownerId: this.options.ownerId,
      });
      return pending && isNamedDeleteSelectionPendingPayload(pending.payload) ? pending : undefined;
    } catch {
      return undefined;
    }
  }

  private async revalidateSelectedCandidate(
    candidate: NamedDeleteCandidate,
    selectorTerms: readonly string[],
    selectorDate?: string,
  ): Promise<NamedDeleteCandidate | undefined> {
    const now = this.now();
    if (candidate.domain === "legacy_task") {
      const task = this.options.stateRepository.getLocalTask?.({ id: candidate.taskId, ownerId: this.options.ownerId });
      if (!task || !this.isCurrentLegacyCandidate(task, candidate, selectorTerms, selectorDate)) {
        return undefined;
      }
      return candidate;
    }
    if (candidate.domain === "scheduled_reminder") {
      const item = this.options.schedulingRepository?.getScheduledItem({ id: candidate.itemId, ownerId: this.options.ownerId });
      if (!item || !this.isCurrentReminderCandidate(item, candidate, selectorTerms, selectorDate, now)) {
        return undefined;
      }
      return candidate;
    }

    const gateway = this.options.calendarGateway;
    if (!gateway) {
      return undefined;
    }
    const calendars = await gateway.listCalendars();
    const calendar = calendars.find((item) => item.id === candidate.calendarId && !item.readOnly);
    if (!calendar) {
      return undefined;
    }
    const event = await gateway.getEvent({ calendarId: candidate.calendarId, eventId: candidate.eventId });
    if (!this.isCurrentCalendarCandidate(event, calendar, candidate, selectorTerms, selectorDate, now)) {
      return undefined;
    }
    return candidate;
  }

  private isCurrentLegacyCandidate(
    task: LocalTask,
    candidate: LegacyTaskCandidate,
    selectorTerms: readonly string[],
    selectorDate: string | undefined,
  ): boolean {
    return task.ownerId === this.options.ownerId && task.status === "active" &&
      task.id === candidate.taskId && task.revision === candidate.expectedRevision &&
      namedDeleteTitleMatches(task.title, selectorTerms) &&
      (!selectorDate || localTaskDate(task.dueAt, task.timeZone) === selectorDate);
  }

  private isCurrentReminderCandidate(
    item: ScheduledItem,
    candidate: ScheduledReminderCandidate,
    selectorTerms: readonly string[],
    selectorDate: string | undefined,
    now: Date,
  ): boolean {
    return item.ownerId === this.options.ownerId && item.status === "active" && item.kind === "reminder" &&
      item.id === candidate.itemId && item.revision === candidate.expectedRevision &&
      namedDeleteTitleMatches(item.title, selectorTerms) &&
      (selectorDate ? item.scheduledDate === selectorDate : Boolean(item.dueAt && item.dueAt > now));
  }

  private isCurrentCalendarCandidate(
    event: CalendarEvent,
    calendar: CalendarReference,
    candidate: CalendarEventCandidate,
    selectorTerms: readonly string[],
    selectorDate: string | undefined,
    now: Date,
  ): boolean {
    return event.calendarId === candidate.calendarId && event.id === candidate.eventId &&
      event.status !== "cancelled" && event.etag.trim().length > 0 && event.etag === candidate.expectedEtag &&
      namedDeleteTitleMatches(event.summary, selectorTerms) &&
      (selectorDate
        ? isNamedDeleteCalendarEventForDate(event, calendar, selectorDate)
        : isNamedDeleteCalendarEventFuture(event, calendar, now));
  }
}

function candidateLabel(candidate: NamedDeleteCandidate): string {
  switch (candidate.domain) {
    case "legacy_task":
      return `Task: ${candidate.title} — ${safeTimestamp(candidate.dueAt)}`;
    case "scheduled_reminder":
      return `Reminder: ${candidate.title} — ${safeDate(candidate.scheduledDate, candidate.timeZone)}`;
    case "calendar_event":
      return `Calendar event: ${candidate.summary} on ${candidate.calendarSummary} — ${safeCalendarStart(candidate)}`;
  }
}

function safeTimestamp(value: string): string {
  try {
    return formatDiscordTimestamp(new Date(value));
  } catch {
    return "scheduled time";
  }
}

function safeDate(value: string, timeZone: string): string {
  try {
    return formatDiscordDate(value, timeZone);
  } catch {
    return value;
  }
}

function safeCalendarStart(candidate: CalendarEventCandidate): string {
  try {
    const event: CalendarEvent = {
      attendees: [],
      calendarId: candidate.calendarId,
      end: candidate.end,
      etag: candidate.expectedEtag,
      id: candidate.eventId,
      ...(candidate.recurrence ? { recurrence: candidate.recurrence } : {}),
      ...(candidate.recurringEventId ? { recurringEventId: candidate.recurringEventId } : {}),
      start: candidate.start,
      status: "confirmed",
      summary: candidate.summary,
    };
    return formatEventStart(event, candidate.calendarTimeZone);
  } catch {
    return "scheduled time";
  }
}
