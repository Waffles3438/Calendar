import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  calendarDateTimeToDateTime,
  calendarDayBounds,
  createTimedEventDateTime,
  eventDurationMinutes,
  eventMatchesLocalTime,
  eventOccurrenceStart,
  formatEventStart,
} from "../calendar/event-time.js";
import { isFirstRecurringOccurrence } from "../calendar/recurrence.js";
import {
  hasExternalGuests,
  isRecurringEvent,
  type CalendarEvent,
  type CalendarEventAttendee,
  type CalendarEventPatch,
  type CalendarReference,
  type CalendarSendUpdates,
  type RecurrenceScope,
  type TimedEventDateTime,
} from "../domain/calendar.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import {
  isCalendarPreconditionFailure,
  type CalendarGateway,
} from "../google/calendar-api.js";
import type { CalendarCommandPlanner } from "../nlp/calendar-command-planner.js";
import {
  parseDeterministicCommand,
  type AttendeeChange,
  type EventQuery,
  type ParsedCalendarCommand,
} from "../nlp/deterministic-command-parser.js";
import { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";
import {
  evaluateMutationSafety,
  type MutationSafetyDecision,
  type SafetyWarning,
} from "../policy/mutation-policy.js";

export interface CalendarMessageHandler {
  handle(message: OwnerDirectMessage): Promise<void>;
}

export interface CalendarAssistantStateRepository {
  consumePendingAction(input: {
    id: string;
    now: Date;
    ownerId: string;
  }): { payload: unknown } | undefined;
  createPendingAction(input: {
    expiresAt: Date;
    id: string;
    ownerId: string;
    payload: unknown;
  }): void;
  getPendingAction(input: {
    id: string;
    now: Date;
    ownerId: string;
  }): { payload: unknown } | undefined;
  recordAudit(input: {
    actionType: string;
    actorId: string;
    details?: Record<string, unknown>;
    status: "failed" | "succeeded";
  }): void;
  setReminderOverride(input: {
    calendarId: string;
    eventId: string;
    minutesBefore: number;
    occurrenceStart?: string;
  }): void;
}

export interface CalendarAssistantOptions {
  readonly calendarGateway: CalendarGateway;
  readonly commandPlanner?: CalendarCommandPlanner;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly pendingActionTtlMilliseconds?: number;
  readonly stateRepository: CalendarAssistantStateRepository;
}

type CommandSource = "deterministic" | "gemini";
type TargetedCommand = Extract<
  ParsedCalendarCommand,
  { readonly kind: "delete" | "manage_attendees" | "set_reminder" | "update" }
>;
type MutationCommand = Exclude<TargetedCommand, { readonly kind: "set_reminder" }>;
type MutationOperation = "delete" | "manage_attendees" | "update";

interface CandidateSearchResult {
  readonly candidates: readonly CalendarEvent[];
  readonly confidence: number;
}

interface PendingSelection {
  readonly calendarId: string;
  readonly candidateIds: readonly string[];
  readonly command: TargetedCommand;
  readonly kind: "selection";
  readonly source: CommandSource;
  readonly timeZone: string;
}

interface PendingCreate {
  readonly calendarId: string;
  readonly end: TimedEventDateTime;
  readonly kind: "create";
  readonly source: "gemini";
  readonly start: TimedEventDateTime;
  readonly title: string;
  readonly warnings: readonly SafetyWarning[];
}

interface PendingReminder {
  readonly calendarId: string;
  readonly eventId: string;
  readonly expectedEtag: string;
  readonly kind: "reminder";
  readonly minutesBefore: number;
  readonly source: "gemini";
}

interface PendingMutation {
  readonly attendeeChange?: AttendeeChange;
  readonly calendarId: string;
  readonly eventDescription: string;
  readonly eventId: string;
  readonly expectedEtag: string;
  readonly expectedMasterEtag?: string;
  readonly kind: "mutation";
  readonly newStartTime?: string;
  readonly operation: MutationOperation;
  readonly recurrenceScope?: RecurrenceScope;
  readonly sendUpdates: CalendarSendUpdates;
  readonly source: CommandSource;
  readonly warnings: readonly SafetyWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCommandSource(value: unknown): value is CommandSource {
  return value === "deterministic" || value === "gemini";
}

function isRecurrenceScope(value: unknown): value is RecurrenceScope {
  return value === "all_future" || value === "series" || value === "this_instance";
}

function isSafetyWarning(value: unknown): value is SafetyWarning {
  return value === "calendar_conflict";
}

function isTimedEventDateTime(value: unknown): value is TimedEventDateTime {
  return isRecord(value) &&
    value.kind === "timed" &&
    typeof value.dateTime === "string" &&
    value.dateTime.trim().length > 0 &&
    typeof value.timeZone === "string" &&
    value.timeZone.trim().length > 0;
}

function isAttendeeChange(value: unknown): value is AttendeeChange {
  return isRecord(value) &&
    (value.action === "add" || value.action === "remove") &&
    Array.isArray(value.emails) &&
    value.emails.length > 0 &&
    value.emails.every((email) => typeof email === "string" && email.trim().length > 0);
}

function isEventQuery(value: unknown): value is EventQuery {
  return isRecord(value) &&
    typeof value.date === "string" &&
    value.date.trim().length > 0 &&
    (!("summary" in value) || value.summary === undefined || typeof value.summary === "string") &&
    (!("time" in value) || value.time === undefined || typeof value.time === "string") &&
    (typeof value.summary === "string" || typeof value.time === "string");
}

function isTargetedCommand(value: unknown): value is TargetedCommand {
  if (!isRecord(value) || !isEventQuery(value.selector)) {
    return false;
  }

  if (value.kind === "update") {
    return typeof value.newStartTime === "string" &&
      (!("recurrenceScope" in value) || value.recurrenceScope === undefined || isRecurrenceScope(value.recurrenceScope));
  }
  if (value.kind === "delete") {
    return !("recurrenceScope" in value) || value.recurrenceScope === undefined || isRecurrenceScope(value.recurrenceScope);
  }
  if (value.kind === "manage_attendees") {
    return isAttendeeChange(value.change) &&
      (!("recurrenceScope" in value) || value.recurrenceScope === undefined || isRecurrenceScope(value.recurrenceScope));
  }
  return value.kind === "set_reminder" &&
    typeof value.minutesBefore === "number" &&
    Number.isInteger(value.minutesBefore) &&
    value.minutesBefore > 0 &&
    value.minutesBefore <= MAX_REMINDER_MINUTES;
}

function isPendingSelection(value: unknown): value is PendingSelection {
  return (
    isRecord(value) &&
    value.kind === "selection" &&
    typeof value.calendarId === "string" &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.every((id) => typeof id === "string") &&
    isCommandSource(value.source) &&
    typeof value.timeZone === "string" &&
    isTargetedCommand(value.command)
  );
}

function isPendingCreate(value: unknown): value is PendingCreate {
  return isRecord(value) &&
    value.kind === "create" &&
    typeof value.calendarId === "string" &&
    isTimedEventDateTime(value.start) &&
    isTimedEventDateTime(value.end) &&
    value.source === "gemini" &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isSafetyWarning);
}

function isPendingReminder(value: unknown): value is PendingReminder {
  return isRecord(value) &&
    value.kind === "reminder" &&
    typeof value.calendarId === "string" &&
    typeof value.eventId === "string" &&
    typeof value.expectedEtag === "string" &&
    value.expectedEtag.trim().length > 0 &&
    typeof value.minutesBefore === "number" &&
    Number.isInteger(value.minutesBefore) &&
    value.minutesBefore > 0 &&
    value.minutesBefore <= MAX_REMINDER_MINUTES &&
    value.source === "gemini";
}

function isPendingMutation(value: unknown): value is PendingMutation {
  if (
    !isRecord(value) ||
    value.kind !== "mutation" ||
    typeof value.calendarId !== "string" ||
    typeof value.eventDescription !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.expectedEtag !== "string" ||
    (value.operation !== "delete" && value.operation !== "manage_attendees" && value.operation !== "update") ||
    (value.sendUpdates !== "all" && value.sendUpdates !== "none") ||
    !isCommandSource(value.source) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isSafetyWarning)
  ) {
    return false;
  }

  return (
    (!("recurrenceScope" in value) || value.recurrenceScope === undefined || isRecurrenceScope(value.recurrenceScope)) &&
    ((value.recurrenceScope === "all_future" || value.recurrenceScope === "series")
      ? typeof value.expectedMasterEtag === "string" && value.expectedMasterEtag.trim().length > 0
      : !("expectedMasterEtag" in value) || value.expectedMasterEtag === undefined) &&
    (!("newStartTime" in value) || value.newStartTime === undefined || typeof value.newStartTime === "string") &&
    (!("attendeeChange" in value) || value.attendeeChange === undefined || isAttendeeChange(value.attendeeChange))
  );
}

function eventDisplayName(event: CalendarEvent, timeZone: string): string {
  return `${event.summary} (${formatEventStart(event, timeZone)})`;
}

function summaryTerms(summary: string | undefined): readonly string[] {
  if (!summary) {
    return [];
  }

  const generic = new Set(["appointment", "event", "meeting", "the"]);
  return summary
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !generic.has(term));
}

function recurrenceScopeOf(command: MutationCommand): RecurrenceScope | undefined {
  return "recurrenceScope" in command ? command.recurrenceScope : undefined;
}

function hasUsableEtag(event: CalendarEvent): boolean {
  return event.etag.trim().length > 0;
}

function sameWarnings(first: readonly SafetyWarning[], second: readonly SafetyWarning[]): boolean {
  return first.length === second.length && first.every((warning) => second.includes(warning));
}

/** Executes deterministic commands only after calendar safety policy approval. */
export class CalendarAssistant implements CalendarMessageHandler {
  private readonly now: () => Date;
  private readonly pendingActionTtlMilliseconds: number;

  public constructor(private readonly options: CalendarAssistantOptions) {
    this.now = options.now ?? (() => new Date());
    this.pendingActionTtlMilliseconds = options.pendingActionTtlMilliseconds ?? 10 * 60 * 1_000;
  }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    try {
      const confirmation = /^confirm\s+([a-f0-9-]+)$/iu.exec(message.content.trim());
      if (confirmation?.[1]) {
        await this.handleConfirmation(message, confirmation[1]);
        return;
      }

      const cancellation = /^cancel\s+([a-f0-9-]+)$/iu.exec(message.content.trim());
      if (cancellation?.[1]) {
        await this.handleCancellation(message, cancellation[1]);
        return;
      }

      const selection = /^choose\s+([a-f0-9-]+)\s+(\d+)$/iu.exec(message.content.trim());
      if (selection?.[1] && selection[2]) {
        await this.handleSelection(message, selection[1], Number(selection[2]));
        return;
      }

      const primaryCalendar = await this.getPrimaryCalendar();
      const now = this.now();
      let command = parseDeterministicCommand(message.content, {
        now,
        timeZone: primaryCalendar.timeZone,
      });
      let source: CommandSource = "deterministic";

      if (command.kind === "clarify" &&
        command.reason === "unsupported_intent" &&
        this.options.commandPlanner) {
        try {
          const planned = await this.options.commandPlanner.plan({
            now,
            text: message.content,
            timeZone: primaryCalendar.timeZone,
          });
          if (planned && planned.kind !== "clarify") {
            command = planned;
            source = "gemini";
          }
        } catch {
          // Preserve the deterministic clarification if an injected planner is unavailable.
        }
      }

      await this.handleCommand(message, primaryCalendar, command, source);
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Calendar command failed");
      await message.reply("I could not complete that calendar request. Please try again or use /status.");
    }
  }

  private async handleCommand(
    message: OwnerDirectMessage,
    calendar: CalendarReference,
    command: ParsedCalendarCommand,
    source: CommandSource,
  ): Promise<void> {
    if (command.kind === "clarify") {
      await message.reply(command.message);
      return;
    }

    if (command.kind === "list") {
      await this.handleList(message, calendar, command.date);
      return;
    }

    if (calendar.readOnly) {
      await message.reply(`The ${calendar.summary} calendar is read-only, so I cannot make changes there.`);
      return;
    }

    if (command.kind === "create") {
      await this.handleCreate(message, calendar, command, source);
      return;
    }

    await this.handleTargetedCommand(message, calendar, command, source);
  }

  private async handleList(
    message: OwnerDirectMessage,
    calendar: CalendarReference,
    localDate: string,
  ): Promise<void> {
    const bounds = calendarDayBounds(localDate, calendar.timeZone);
    const events = await this.options.calendarGateway.listEvents({
      calendarId: calendar.id,
      ...bounds,
    });
    const activeEvents = events.filter((event) => event.status !== "cancelled");

    if (activeEvents.length === 0) {
      await message.reply(`Nothing is scheduled on ${localDate} in ${calendar.summary}.`);
      return;
    }

    await message.reply(
      `Schedule for ${localDate}:\n${activeEvents
        .map((event, index) => `${index + 1}. ${eventDisplayName(event, calendar.timeZone)}`)
        .join("\n")}`,
    );
  }

  private async handleCreate(
    message: OwnerDirectMessage,
    calendar: CalendarReference,
    command: Extract<ParsedCalendarCommand, { readonly kind: "create" }>,
    source: CommandSource,
  ): Promise<void> {
    const start = createTimedEventDateTime(command.date, command.startTime, calendar.timeZone);
    const startDateTime = calendarDateTimeToDateTime(start, calendar.timeZone);
    const end: TimedEventDateTime = {
      dateTime: startDateTime.plus({ minutes: command.durationMinutes }).toISO() ?? start.dateTime,
      kind: "timed",
      timeZone: calendar.timeZone,
    };
    const conflicts = await this.findConflicts(calendar, start, end);
    const decision = evaluateMutationSafety({
      ...(conflicts.length > 0 ? { hasCalendarConflict: true } : {}),
      operation: "create",
      ...(source === "gemini" ? { proposedByModel: true } : {}),
    });

    if (decision.disposition === "require_confirmation") {
      if (source !== "gemini") {
        throw new Error("A deterministic create unexpectedly required confirmation");
      }
      await this.queueCreateConfirmation(message, {
        calendarId: calendar.id,
        end,
        kind: "create",
        source,
        start,
        title: command.title,
        warnings: decision.warnings,
      }, decision);
      return;
    }

    const created = await this.options.calendarGateway.createEvent({
      calendarId: calendar.id,
      end,
      sendUpdates: "none",
      start,
      summary: command.title,
    });
    this.audit("create", { calendarId: calendar.id, eventId: created.id }, "succeeded");
    await message.reply(
      `Created ${eventDisplayName(created, calendar.timeZone)}.${this.conflictSuffix(decision.warnings)}`,
    );
  }

  private async executeCreate(
    message: OwnerDirectMessage,
    pending: PendingCreate,
    calendar: CalendarReference,
    confirmationAccepted: boolean,
  ): Promise<void> {
    try {
      if (calendar.readOnly) {
        this.audit("create", { calendarId: pending.calendarId, reason: "read_only" }, "failed");
        await message.reply(`The ${calendar.summary} calendar is now read-only, so no event was created.`);
        return;
      }

      const conflicts = await this.findConflicts(calendar, pending.start, pending.end);
      const decision = evaluateMutationSafety({
        ...(conflicts.length > 0 ? { hasCalendarConflict: true } : {}),
        operation: "create",
        proposedByModel: true,
      });
      if (decision.disposition !== "require_confirmation" || !confirmationAccepted) {
        this.audit("create", { calendarId: pending.calendarId, reason: "confirmation_required" }, "failed");
        await message.reply("This action requires confirmation before it can be applied.");
        return;
      }

      const created = await this.options.calendarGateway.createEvent({
        calendarId: pending.calendarId,
        end: pending.end,
        sendUpdates: "none",
        start: pending.start,
        summary: pending.title,
      });
      this.audit("create", { calendarId: pending.calendarId, eventId: created.id }, "succeeded");
      await message.reply(
        `Created ${eventDisplayName(created, calendar.timeZone)}.${this.conflictSuffix(decision.warnings)}`,
      );
    } catch (error: unknown) {
      this.audit("create", { calendarId: pending.calendarId }, "failed");
      this.options.logger.error({ error, calendarId: pending.calendarId }, "Calendar create failed");
      await message.reply("I could not safely create that calendar event. Please try again.");
    }
  }

  private async handleTargetedCommand(
    message: OwnerDirectMessage,
    calendar: CalendarReference,
    command: TargetedCommand,
    source: CommandSource,
    selectedEvent?: CalendarEvent,
  ): Promise<void> {
    if (calendar.readOnly) {
      await message.reply(`The ${calendar.summary} calendar is read-only, so I cannot make changes there.`);
      return;
    }

    const match = selectedEvent
      ? {
        candidates: selectedEvent.status === "cancelled" ? [] : [selectedEvent],
        confidence: selectedEvent.status === "cancelled" ? 0 : 0.99,
      }
      : await this.findCandidates(calendar, command.selector);
    const target = match.candidates.length === 1 ? match.candidates[0] : undefined;
    const patch = command.kind === "update" && target
      ? this.createTimePatch(target, command.newStartTime, calendar)
      : undefined;
    const conflicts = patch && target
      ? await this.findConflicts(calendar, patch.start, patch.end, target.id)
      : [];
    const scope = command.kind === "set_reminder" ? undefined : recurrenceScopeOf(command);
    const decision = evaluateMutationSafety({
      ...(conflicts.length > 0 ? { hasCalendarConflict: true } : {}),
      ...(command.kind === "manage_attendees" ? { introducesAttendees: command.change.action === "add" } : {}),
      match: {
        candidateCount: match.candidates.length,
        confidence: match.confidence,
      },
      operation: command.kind,
      ...(source === "gemini" ? { proposedByModel: true } : {}),
      ...(scope ? { recurrenceScope: scope } : {}),
      ...(target
        ? { target: { hasExternalGuests: hasExternalGuests(target), isRecurring: isRecurringEvent(target) } }
        : {}),
    });

    if (decision.disposition === "select_target") {
      await this.queueSelection(message, calendar, command, match.candidates, source);
      return;
    }

    if (decision.disposition === "require_clarification") {
      await message.reply(this.clarificationFor(decision));
      return;
    }

    if (!target) {
      await message.reply("I could not find a matching calendar event.");
      return;
    }

    if (command.kind === "set_reminder") {
      if (source === "gemini") {
        if (!hasUsableEtag(target)) {
          this.audit("set_reminder", { calendarId: calendar.id, eventId: target.id, reason: "missing_etag" }, "failed");
          await message.reply("I cannot safely prepare that reminder because Google did not provide a version marker. Please try again.");
          return;
        }
        await this.queueReminderConfirmation(message, {
          calendarId: calendar.id,
          eventId: target.id,
          expectedEtag: target.etag,
          kind: "reminder",
          minutesBefore: command.minutesBefore,
          source,
        }, decision);
        return;
      }

      this.options.stateRepository.setReminderOverride({
        calendarId: calendar.id,
        eventId: target.id,
        minutesBefore: command.minutesBefore,
        ...(isRecurringEvent(target) ? { occurrenceStart: eventOccurrenceStart(target) } : {}),
      });
      this.audit("set_reminder", { calendarId: calendar.id, eventId: target.id }, "succeeded");
      await message.reply(
        `I will remind you ${command.minutesBefore} minutes before ${eventDisplayName(target, calendar.timeZone)}.`,
      );
      return;
    }

    if (!hasUsableEtag(target)) {
      this.audit(command.kind, { calendarId: calendar.id, eventId: target.id, reason: "missing_etag" }, "failed");
      await message.reply("I cannot safely change that event because Google did not provide a version marker. Please try again.");
      return;
    }

    let expectedMasterEtag: string | undefined;
    if (scope && scope !== "this_instance") {
      if (!isRecurringEvent(target)) {
        await message.reply("That event is no longer recurring. Please repeat the request.");
        return;
      }
      const master = await this.options.calendarGateway.getEvent({
        calendarId: calendar.id,
        eventId: target.recurringEventId ?? target.id,
      });
      if (master.status === "cancelled" || !hasUsableEtag(master)) {
        await message.reply("The recurring series is no longer safely editable. Please repeat the request.");
        return;
      }
      expectedMasterEtag = master.etag;
    }

    const mutation = this.createMutationPayload(
      target,
      calendar,
      command,
      decision,
      source,
      expectedMasterEtag,
    );
    if (decision.disposition === "require_confirmation") {
      await this.queueConfirmation(message, mutation, decision);
      return;
    }

    await this.executeMutation(message, mutation, calendar, false);
  }

  private async handleConfirmation(message: OwnerDirectMessage, actionId: string): Promise<void> {
    const pending = this.options.stateRepository.consumePendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!pending) {
      await message.reply("That confirmation is invalid or has expired.");
      return;
    }

    if (isPendingMutation(pending.payload)) {
      const calendar = await this.getCalendar(pending.payload.calendarId);
      await this.executeMutation(message, pending.payload, calendar, true);
      return;
    }
    if (isPendingCreate(pending.payload)) {
      const calendar = await this.getCalendar(pending.payload.calendarId);
      await this.executeCreate(message, pending.payload, calendar, true);
      return;
    }
    if (isPendingReminder(pending.payload)) {
      const calendar = await this.getCalendar(pending.payload.calendarId);
      await this.executeReminder(message, pending.payload, calendar, true);
      return;
    }

    await message.reply("That confirmation is invalid or has expired.");
  }

  private async executeReminder(
    message: OwnerDirectMessage,
    pending: PendingReminder,
    calendar: CalendarReference,
    confirmationAccepted: boolean,
  ): Promise<void> {
    const auditDetails = { calendarId: pending.calendarId, eventId: pending.eventId };
    try {
      if (calendar.readOnly) {
        this.audit("set_reminder", { ...auditDetails, reason: "read_only" }, "failed");
        await message.reply(`The ${calendar.summary} calendar is now read-only, so no reminder was changed.`);
        return;
      }

      const latest = await this.options.calendarGateway.getEvent({
        calendarId: pending.calendarId,
        eventId: pending.eventId,
      });
      if (latest.status === "cancelled" || !hasUsableEtag(latest) || latest.etag !== pending.expectedEtag) {
        this.audit("set_reminder", { ...auditDetails, reason: "event_changed" }, "failed");
        await message.reply("That event changed since this reminder was prepared. Please repeat the request.");
        return;
      }

      const decision = evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.99 },
        operation: "set_reminder",
        proposedByModel: true,
        target: { hasExternalGuests: hasExternalGuests(latest), isRecurring: isRecurringEvent(latest) },
      });
      if (decision.disposition !== "require_confirmation" || !confirmationAccepted) {
        this.audit("set_reminder", { ...auditDetails, reason: "confirmation_required" }, "failed");
        await message.reply("This action requires confirmation before it can be applied.");
        return;
      }

      this.options.stateRepository.setReminderOverride({
        calendarId: pending.calendarId,
        eventId: pending.eventId,
        minutesBefore: pending.minutesBefore,
        ...(isRecurringEvent(latest) ? { occurrenceStart: eventOccurrenceStart(latest) } : {}),
      });
      this.audit("set_reminder", auditDetails, "succeeded");
      await message.reply(
        `I will remind you ${pending.minutesBefore} minutes before ${eventDisplayName(latest, calendar.timeZone)}.`,
      );
    } catch (error: unknown) {
      this.audit("set_reminder", auditDetails, "failed");
      this.options.logger.error({ error, ...auditDetails }, "Calendar reminder update failed");
      await message.reply("I could not safely set that reminder. Please try again.");
    }
  }

  private async handleCancellation(message: OwnerDirectMessage, actionId: string): Promise<void> {
    const pending = this.options.stateRepository.consumePendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    await message.reply(pending ? "Cancelled. No calendar change was made." : "That action is invalid or has expired.");
  }

  private async handleSelection(
    message: OwnerDirectMessage,
    actionId: string,
    choice: number,
  ): Promise<void> {
    const pending = this.options.stateRepository.getPendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!pending || !isPendingSelection(pending.payload)) {
      await message.reply("That selection is invalid or has expired.");
      return;
    }

    const eventId = pending.payload.candidateIds[choice - 1];
    if (!eventId) {
      await message.reply("That selection number is not available. Reply with a number from the list.");
      return;
    }

    const consumed = this.options.stateRepository.consumePendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!consumed || !isPendingSelection(consumed.payload)) {
      await message.reply("That selection is invalid or has expired.");
      return;
    }

    const calendar = await this.getCalendar(consumed.payload.calendarId);
    const selected = await this.options.calendarGateway.getEvent({
      calendarId: calendar.id,
      eventId,
    });
    await this.handleTargetedCommand(
      message,
      calendar,
      consumed.payload.command,
      consumed.payload.source,
      selected,
    );
  }

  private async getPrimaryCalendar(): Promise<CalendarReference> {
    const calendars = await this.options.calendarGateway.listCalendars();
    const primary = calendars.find((calendar) => calendar.isPrimary) ?? calendars[0];
    if (!primary) {
      throw new Error("No accessible Google calendars were found");
    }
    return primary;
  }

  private async getCalendar(calendarId: string): Promise<CalendarReference> {
    const calendars = await this.options.calendarGateway.listCalendars();
    const calendar = calendars.find((candidate) => candidate.id === calendarId);
    if (!calendar) {
      throw new Error("The selected calendar is no longer accessible");
    }
    return calendar;
  }

  private async findCandidates(
    calendar: CalendarReference,
    selector: EventQuery,
  ): Promise<CandidateSearchResult> {
    if (!selector.date) {
      return { candidates: [], confidence: 0 };
    }

    const events = await this.options.calendarGateway.listEvents({
      calendarId: calendar.id,
      ...calendarDayBounds(selector.date, calendar.timeZone),
    });
    let candidates = events.filter((event) => event.status !== "cancelled");
    const terms = summaryTerms(selector.summary);

    if (selector.time) {
      candidates = candidates.filter((event) =>
        eventMatchesLocalTime(event, selector.time ?? "", calendar.timeZone),
      );
    }

    if (terms.length > 0) {
      candidates = candidates.filter((event) => {
        const normalizedSummary = event.summary.toLowerCase();
        return terms.every((term) => normalizedSummary.includes(term));
      });
    }

    const hasSpecificSelector = Boolean(selector.time) || terms.length > 0;
    return {
      candidates,
      confidence: candidates.length === 1 ? (hasSpecificSelector ? 0.95 : 0.5) : candidates.length > 1 ? 0.5 : 0,
    };
  }

  private createTimePatch(
    event: CalendarEvent,
    newStartTime: string,
    calendar: CalendarReference,
  ): CalendarEventPatch {
    if (event.start.kind !== "timed" || event.end.kind !== "timed") {
      throw new Error("This all-day event needs a date and time before it can be rescheduled");
    }

    const localDate = calendarDateTimeToDateTime(event.start, calendar.timeZone).toFormat("yyyy-LL-dd");
    const start = createTimedEventDateTime(localDate, newStartTime, calendar.timeZone);
    const endDateTime = calendarDateTimeToDateTime(start, calendar.timeZone).plus({
      minutes: eventDurationMinutes(event, calendar.timeZone),
    });
    const endIso = endDateTime.toISO();
    if (!endIso) {
      throw new Error("Could not calculate the updated event end time");
    }

    return {
      end: { dateTime: endIso, kind: "timed", timeZone: calendar.timeZone },
      start,
    };
  }

  private createAttendeePatch(
    event: CalendarEvent,
    change: AttendeeChange,
  ): CalendarEventPatch | undefined {
    const requestedEmails = new Set(change.emails.map((email) => email.toLowerCase()));
    const existingByEmail = new Map(
      event.attendees.map((attendee) => [attendee.email.toLowerCase(), attendee] as const),
    );

    if (change.action === "add") {
      const additions = [...requestedEmails]
        .filter((email) => !existingByEmail.has(email))
        .map((email): CalendarEventAttendee => ({ email }));
      return additions.length > 0 ? { attendees: [...event.attendees, ...additions] } : undefined;
    }

    const selfRemoval = event.attendees.some(
      (attendee) => attendee.self && requestedEmails.has(attendee.email.toLowerCase()),
    );
    if (selfRemoval) {
      throw new Error("I will not remove the calendar owner from an event through chat.");
    }

    const attendees = event.attendees.filter(
      (attendee) => !requestedEmails.has(attendee.email.toLowerCase()),
    );
    return attendees.length < event.attendees.length ? { attendees } : undefined;
  }

  private createMutationPayload(
    event: CalendarEvent,
    calendar: CalendarReference,
    command: MutationCommand,
    decision: MutationSafetyDecision,
    source: CommandSource,
    expectedMasterEtag?: string,
  ): PendingMutation {
    const guestImpact = hasExternalGuests(event) || command.kind === "manage_attendees";
    const scope = recurrenceScopeOf(command);
    return {
      calendarId: calendar.id,
      eventDescription: eventDisplayName(event, calendar.timeZone),
      eventId: event.id,
      expectedEtag: event.etag,
      ...(expectedMasterEtag ? { expectedMasterEtag } : {}),
      kind: "mutation",
      operation: command.kind,
      ...(command.kind === "update" ? { newStartTime: command.newStartTime } : {}),
      ...(command.kind === "manage_attendees" ? { attendeeChange: command.change } : {}),
      ...(scope ? { recurrenceScope: scope } : {}),
      sendUpdates: guestImpact ? "all" : "none",
      source,
      warnings: decision.warnings,
    };
  }

  private async executeMutation(
    message: OwnerDirectMessage,
    mutation: PendingMutation,
    calendar: CalendarReference,
    confirmationAccepted: boolean,
  ): Promise<void> {
    const auditDetails = { calendarId: mutation.calendarId, eventId: mutation.eventId };
    try {
      if (calendar.readOnly) {
        await this.rejectMutation(message, mutation, "The selected calendar is now read-only, so no change was made.");
        return;
      }

      const latest = await this.options.calendarGateway.getEvent({
        calendarId: mutation.calendarId,
        eventId: mutation.eventId,
      });
      if (latest.status === "cancelled") {
        await this.rejectMutation(message, mutation, "That event was cancelled, so no change was made.");
        return;
      }
      if (!hasUsableEtag(latest)) {
        await this.rejectMutation(message, mutation, "Google did not provide a version marker for that event, so no change was made.");
        return;
      }
      if (latest.etag !== mutation.expectedEtag) {
        await this.rejectMutation(
          message,
          mutation,
          "That event changed since this action was prepared. Please repeat the request.",
        );
        return;
      }

      const scope = mutation.recurrenceScope;
      let master: CalendarEvent | undefined;
      if (scope && scope !== "this_instance") {
        if (!isRecurringEvent(latest)) {
          await this.rejectMutation(message, mutation, "That event is no longer recurring. Please repeat the request.");
          return;
        }
        master = await this.options.calendarGateway.getEvent({
          calendarId: mutation.calendarId,
          eventId: latest.recurringEventId ?? latest.id,
        });
        if (
          master.status === "cancelled" ||
          !hasUsableEtag(master) ||
          !mutation.expectedMasterEtag ||
          master.etag !== mutation.expectedMasterEtag
        ) {
          await this.rejectMutation(
            message,
            mutation,
            "That recurring series changed since this action was prepared. Please repeat the request.",
          );
          return;
        }
      }

      const allFutureBeginsSeries = Boolean(
        scope === "all_future" && master && isFirstRecurringOccurrence(master, latest, calendar.timeZone),
      );
      const writeTarget = (scope === "series" || allFutureBeginsSeries) && master ? master : latest;
      const safetyTarget = scope === "all_future" && master ? master : writeTarget;
      const patchTarget =
        scope === "all_future" && master && !allFutureBeginsSeries
          ? mutation.operation === "update" ? latest : master
          : writeTarget;
      const patch = mutation.operation === "delete"
        ? undefined
        : this.patchForMutation(mutation, patchTarget, calendar);
      if (mutation.operation !== "delete" && !patch) {
        await message.reply("That attendee change is already reflected on the event, so no calendar change was made.");
        return;
      }

      const conflictPatch = mutation.operation === "update"
        ? this.patchForMutation(mutation, latest, calendar)
        : undefined;
      const freshConflicts = conflictPatch
        ? await this.findConflicts(calendar, conflictPatch.start, conflictPatch.end, latest.id)
        : [];
      const freshDecision = evaluateMutationSafety({
        ...(mutation.attendeeChange ? { introducesAttendees: mutation.attendeeChange.action === "add" } : {}),
        ...(freshConflicts.length > 0 ? { hasCalendarConflict: true } : {}),
        match: { candidateCount: 1, confidence: 0.99 },
        operation: mutation.operation,
        ...(mutation.source === "gemini" ? { proposedByModel: true } : {}),
        ...(scope ? { recurrenceScope: scope } : {}),
        target: {
          hasExternalGuests: hasExternalGuests(safetyTarget),
          isRecurring: isRecurringEvent(safetyTarget),
        },
      });
      if (freshDecision.disposition === "require_clarification" || freshDecision.disposition === "select_target") {
        await this.rejectMutation(message, mutation, "That event no longer satisfies the safety checks. Please repeat the request.");
        return;
      }

      const refreshedMutation: PendingMutation = sameWarnings(mutation.warnings, freshDecision.warnings)
        ? mutation
        : { ...mutation, warnings: freshDecision.warnings };
      if (confirmationAccepted && !sameWarnings(mutation.warnings, freshDecision.warnings)) {
        await this.queueConfirmation(message, refreshedMutation, freshDecision);
        return;
      }
      if (freshDecision.disposition === "require_confirmation" && !confirmationAccepted) {
        await this.rejectMutation(message, refreshedMutation, "This action requires confirmation before it can be applied.");
        return;
      }

      const sendUpdates: CalendarSendUpdates =
        refreshedMutation.sendUpdates === "all" || hasExternalGuests(safetyTarget) || refreshedMutation.operation === "manage_attendees"
          ? "all"
          : "none";

      let resultingEvent: CalendarEvent | undefined;
      if (scope === "all_future" && master && !allFutureBeginsSeries) {
        if (refreshedMutation.operation === "delete") {
          await this.options.calendarGateway.truncateRecurringEvent({
            calendarId: refreshedMutation.calendarId,
            master,
            sendUpdates,
            targetOccurrence: latest,
          });
        } else if (patch) {
          resultingEvent = await this.options.calendarGateway.splitRecurringEvent({
            calendarId: refreshedMutation.calendarId,
            master,
            patch,
            sendUpdates,
            targetOccurrence: latest,
          });
        }
      } else if (refreshedMutation.operation === "delete") {
        await this.options.calendarGateway.deleteEvent({
          calendarId: refreshedMutation.calendarId,
          etag: writeTarget.etag,
          eventId: writeTarget.id,
          sendUpdates,
        });
      } else if (patch) {
        resultingEvent = await this.options.calendarGateway.updateEvent({
          calendarId: refreshedMutation.calendarId,
          etag: writeTarget.etag,
          eventId: writeTarget.id,
          patch,
          sendUpdates,
        });
      }

      this.audit(refreshedMutation.operation, auditDetails, "succeeded");
      await this.replyForMutation(message, refreshedMutation, resultingEvent ?? writeTarget, calendar.timeZone);
    } catch (error: unknown) {
      this.audit(mutation.operation, auditDetails, "failed");
      if (isCalendarPreconditionFailure(error)) {
        await message.reply("That event changed while I was applying the update. No further action was taken; please repeat the request.");
        return;
      }
      this.options.logger.error({ error, ...auditDetails }, "Calendar mutation failed");
      await message.reply("I could not safely complete that calendar change. Please review the event and try again.");
    }
  }

  private patchForMutation(
    mutation: PendingMutation,
    event: CalendarEvent,
    calendar: CalendarReference,
  ): CalendarEventPatch | undefined {
    if (mutation.operation === "update") {
      if (!mutation.newStartTime) {
        throw new Error("Missing requested event start time");
      }
      return this.createTimePatch(event, mutation.newStartTime, calendar);
    }
    if (mutation.operation === "manage_attendees") {
      if (!mutation.attendeeChange) {
        throw new Error("Missing attendee change");
      }
      return this.createAttendeePatch(event, mutation.attendeeChange);
    }
    return undefined;
  }

  private async replyForMutation(
    message: OwnerDirectMessage,
    mutation: PendingMutation,
    event: CalendarEvent,
    timeZone: string,
  ): Promise<void> {
    const scopeLabel =
      mutation.recurrenceScope === "all_future"
        ? "all future occurrences of "
        : mutation.recurrenceScope === "series"
          ? "the whole series "
          : "";
    if (mutation.operation === "delete") {
      await message.reply(`Deleted ${scopeLabel}${event.summary}.${this.conflictSuffix(mutation.warnings)}`);
      return;
    }
    if (mutation.operation === "manage_attendees") {
      const action = mutation.attendeeChange?.action === "remove" ? "Updated attendees for" : "Invited attendees to";
      await message.reply(`${action} ${scopeLabel}${eventDisplayName(event, timeZone)}.`);
      return;
    }
    await message.reply(
      `Moved ${scopeLabel}${event.summary} to ${formatEventStart(event, timeZone)}.${this.conflictSuffix(mutation.warnings)}`,
    );
  }

  private async rejectMutation(
    message: OwnerDirectMessage,
    mutation: PendingMutation,
    reply: string,
  ): Promise<void> {
    this.audit(mutation.operation, { calendarId: mutation.calendarId, eventId: mutation.eventId }, "failed");
    await message.reply(reply);
  }

  private async queueSelection(
    message: OwnerDirectMessage,
    calendar: CalendarReference,
    command: TargetedCommand,
    candidates: readonly CalendarEvent[],
    source: CommandSource,
  ): Promise<void> {
    if (candidates.length === 0) {
      await message.reply("I could not find a matching event. Please include its title or time.");
      return;
    }

    const id = randomUUID();
    const payload: PendingSelection = {
      calendarId: calendar.id,
      candidateIds: candidates.map((candidate) => candidate.id),
      command,
      kind: "selection",
      source,
      timeZone: calendar.timeZone,
    };
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload,
    });

    await message.reply(
      `I found multiple events. Reply choose ${id} followed by a number:\n${candidates
        .map((candidate, index) => `${index + 1}. ${eventDisplayName(candidate, calendar.timeZone)}`)
        .join("\n")}`,
    );
  }

  private async queueCreateConfirmation(
    message: OwnerDirectMessage,
    pending: PendingCreate,
    decision: MutationSafetyDecision,
  ): Promise<void> {
    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: pending,
    });

    const reason = decision.reasons.map((item) => item.replace(/_/gu, " ")).join(", ");
    await message.reply(
      `Review: create ${pending.title} at ${pending.start.dateTime}.${this.conflictSuffix(pending.warnings)} This action requires confirmation (${reason}). Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async queueReminderConfirmation(
    message: OwnerDirectMessage,
    pending: PendingReminder,
    decision: MutationSafetyDecision,
  ): Promise<void> {
    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: pending,
    });

    const reason = decision.reasons.map((item) => item.replace(/_/gu, " ")).join(", ");
    await message.reply(
      `Review: set a ${pending.minutesBefore}-minute local reminder. This action requires confirmation (${reason}). Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async queueConfirmation(
    message: OwnerDirectMessage,
    mutation: PendingMutation,
    decision: MutationSafetyDecision,
  ): Promise<void> {
    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
      id,
      ownerId: this.options.ownerId,
      payload: mutation,
    });

    const reason = decision.reasons
      .map((item) => item.replace(/_/gu, " "))
      .join(", ");
    const scope = mutation.recurrenceScope
      ? ` Scope: ${mutation.recurrenceScope.replace(/_/gu, " ")}.`
      : "";
    const notifications = mutation.sendUpdates === "all"
      ? " Guests will receive Calendar updates."
      : "";
    const conflict = this.conflictSuffix(mutation.warnings);
    await message.reply(
      `Review: ${mutation.operation.replace(/_/gu, " ")} ${mutation.eventDescription}.${scope}${notifications}${conflict} This action requires confirmation (${reason}). Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  private async findConflicts(
    calendar: CalendarReference,
    start: CalendarEventPatch["start"],
    end: CalendarEventPatch["end"],
    ignoredEventId?: string,
  ): Promise<readonly CalendarEvent[]> {
    if (!start || !end || start.kind !== "timed" || end.kind !== "timed") {
      return [];
    }

    const startDateTime = calendarDateTimeToDateTime(start, calendar.timeZone);
    const endDateTime = calendarDateTimeToDateTime(end, calendar.timeZone);
    const localDate = startDateTime.toFormat("yyyy-LL-dd");
    const events = await this.options.calendarGateway.listEvents({
      calendarId: calendar.id,
      ...calendarDayBounds(localDate, calendar.timeZone),
    });

    return events.filter((event) => {
      if (event.id === ignoredEventId || event.status === "cancelled" || event.start.kind !== "timed" || event.end.kind !== "timed") {
        return false;
      }
      const eventStart = calendarDateTimeToDateTime(event.start, calendar.timeZone);
      const eventEnd = calendarDateTimeToDateTime(event.end, calendar.timeZone);
      return eventStart < endDateTime && eventEnd > startDateTime;
    });
  }

  private clarificationFor(decision: MutationSafetyDecision): string {
    if (decision.reasons.includes("recurrence_scope_required")) {
      return "That is a recurring event. Specify whether you mean this occurrence, all future occurrences, or the whole series.";
    }
    if (decision.reasons.includes("target_not_found")) {
      return "I could not find an event matching every title and time detail you gave. Please check the details and try again.";
    }
    return "I could not identify a single event. Please include its title and time.";
  }

  private conflictSuffix(warnings: readonly SafetyWarning[]): string {
    return warnings.includes("calendar_conflict")
      ? " It overlaps another event on your calendar."
      : "";
  }

  private audit(
    actionType: string,
    details: Record<string, unknown>,
    status: "failed" | "succeeded",
  ): void {
    this.options.stateRepository.recordAudit({
      actionType,
      actorId: this.options.ownerId,
      details,
      status,
    });
  }
}
