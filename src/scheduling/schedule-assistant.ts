import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import type { Logger } from "pino";

import type { PendingActionInstruction, PendingActionMessageHandler } from "../application/pending-action.js";
import { markGeminiResponseUsed } from "../application/gemini-response-attribution.js";
import type { ScheduledReminderCandidate } from "../application/named-delete-resolver.js";
import { calendarDateTimeToDateTime } from "../calendar/event-time.js";
import { hasExternalGuests, isRecurringEvent, type CalendarEvent, type CalendarReference, type TimedEventDateTime } from "../domain/calendar.js";
import { formatDiscordDate, formatDiscordTimestamp } from "../discord/discord-timestamp.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { NaturalLanguageAction } from "../nlp/natural-language-action.js";
import type { CalendarGateway } from "../google/calendar-api.js";
import {
  MAX_BULK_LOCAL_TASK_CANCELLATIONS,
  type LocalTask,
  type LocalTaskCancellationTarget,
} from "../tasks/task-domain.js";
import { normalizeTaskSelectorTerms, titleMatchesTaskSelector } from "../tasks/task-selector.js";
import { validateLocalTaskDateTime } from "../tasks/task-time.js";
import { evaluateMutationSafety } from "../policy/mutation-policy.js";
import { AgendaService, type LegacyTaskAgendaReader } from "./agenda-service.js";
import { buildCalendarRRule } from "./recurrence.js";
import {
  isExecutableScheduleCommand,
  parseScheduleCommand,
  type ExecutableScheduleCommand,
  type ParsedScheduleCommand,
} from "./schedule-parser.js";
import {
  MAX_BULK_SCHEDULE_CANCELLATIONS,
  type ScheduleKind,
  type ScheduleRecurrence,
  type ScheduledItem,
} from "./schedule-domain.js";
import type { ScheduleCommandPlanner } from "./schedule-command-planner.js";
import { SchedulingRepository } from "./scheduling-repository.js";
import { normalizeTemporalAliases } from "./temporal.js";

const CACHE_TTL_DAYS = 90;
const MATERIALIZATION_HORIZON_DAYS = 400;
const CLEANUP_TTL_MILLISECONDS = 10 * 60 * 1_000;
const CLEANUP_LOOKAHEAD_YEARS = 5;
/** Matches StateRepository's bounded active-task page; a full page is rejected rather than silently truncated. */
const MAX_LEGACY_CLEANUP_SCAN_ITEMS = 10_000;

type CommandSource = "cache" | "deterministic" | "gemini" | "manual";

export interface SchedulePendingStateRepository {
  /** Optional legacy-task bulk APIs let reviewed cleanup include old local tasks. */
  cancelLocalTasks?(input: {
    now: Date;
    ownerId: string;
    tasks: readonly LocalTaskCancellationTarget[];
  }): readonly LocalTask[] | undefined;
  consumePendingAction(input: { id: string; now: Date; ownerId: string }): { payload: unknown } | undefined;
  createPendingAction(input: { expiresAt: Date; id: string; ownerId: string; payload: unknown }): void;
  getLocalTask?(input: { id: string; ownerId: string }): LocalTask | undefined;
  getPendingAction(input: { id: string; now: Date; ownerId: string }): { payload: unknown } | undefined;
  listActiveLocalTasks?(input: { limit?: number; ownerId: string }): readonly LocalTask[];
  recordAudit?(input: {
    actionType: string;
    actorId: string;
    details?: Record<string, unknown>;
    status: "failed" | "succeeded";
  }): void;
}

export interface ScheduleAssistantOptions {
  readonly calendarGateway?: CalendarGateway;
  readonly commandPlanner?: ScheduleCommandPlanner;
  readonly dryRun?: boolean;
  /** Disables replay and execution of legacy cached Gemini interpretations during rollout shutdown. */
  readonly geminiEnabled?: boolean;
  readonly legacyTaskReader?: LegacyTaskAgendaReader;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly schedulingRepository: SchedulingRepository;
  readonly stateRepository: SchedulePendingStateRepository;
  readonly timeZone: string;
}

interface PendingCleanupItem {
  readonly expectedRevision: number;
  readonly id: string;
}

interface PendingCleanupSeries extends PendingCleanupItem {
  readonly fromDate: string;
  readonly seriesId: string;
  readonly title: string;
}

type CleanupReviewScope = "date_scoped" | "unscoped_future";
type CalendarCleanupScope = "all_future" | "this_instance";

type CleanupResponseSource = "gemini" | "non_gemini";

interface PendingCleanupCalendarEvent {
  readonly calendarId: string;
  readonly etag: string;
  readonly eventId: string;
  readonly expectedMasterEtag?: string;
  readonly hasExternalGuests: boolean;
  readonly recurringEventId?: string;
  readonly scope: CalendarCleanupScope;
  readonly summary: string;
}

interface PendingScheduleCleanupFields {
  readonly calendarEvents: readonly PendingCleanupCalendarEvent[];
  readonly cleanupScope: CleanupReviewScope;
  readonly items: readonly PendingCleanupItem[];
  readonly kind: "schedule_cleanup";
  readonly legacyItems: readonly PendingCleanupItem[];
  readonly series: readonly PendingCleanupSeries[];
}

interface PendingScheduleCleanup extends PendingScheduleCleanupFields {
  readonly responseSource: CleanupResponseSource;
}

type PendingScheduleCreateCommand = Extract<ExecutableScheduleCommand, { readonly kind: "event" | "local" }>;

interface PendingScheduleCreate {
  readonly command: PendingScheduleCreateCommand;
  readonly kind: "schedule_create";
  readonly source: "gemini";
}

/** Accepts older reviewed cleanup payloads that safely omit only response attribution. */
interface PendingScheduleCleanupWire extends PendingScheduleCleanupFields {
  readonly responseSource?: CleanupResponseSource;
}

interface CalendarCleanupCandidate {
  readonly calendar: CalendarReference;
  readonly event: CalendarEvent;
  readonly expectedMasterEtag?: string;
  readonly hasExternalGuests: boolean;
  /** Cross-date events are presented for review but never auto-deleted by a date-scoped request. */
  readonly requiresConfirmation: boolean;
  readonly scope: CalendarCleanupScope;
}

interface LegacyCleanupCandidateSearch {
  readonly candidates: readonly LocalTask[];
  /** True when the repository page may have additional active tasks that were not inspected. */
  readonly mayBeTruncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPendingItem(value: unknown): value is PendingCleanupItem {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.expectedRevision === "number" && Number.isInteger(value.expectedRevision) && value.expectedRevision > 0;
}

function isPendingCleanupSeries(value: unknown): value is PendingCleanupSeries {
  return isPendingItem(value) && isRecord(value) &&
    typeof value.seriesId === "string" && value.seriesId.trim().length > 0 &&
    typeof value.fromDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.fromDate) &&
    typeof value.title === "string" && value.title.trim().length > 0;
}

function isPendingCleanupCalendarEvent(value: unknown): value is PendingCleanupCalendarEvent {
  return isRecord(value) &&
    typeof value.calendarId === "string" && value.calendarId.trim().length > 0 &&
    typeof value.eventId === "string" && value.eventId.trim().length > 0 &&
    typeof value.etag === "string" && value.etag.trim().length > 0 &&
    typeof value.summary === "string" && value.summary.trim().length > 0 &&
    typeof value.hasExternalGuests === "boolean" &&
    (value.scope === "all_future" || value.scope === "this_instance") &&
    (!("recurringEventId" in value) ||
      typeof value.recurringEventId === "string" && value.recurringEventId.trim().length > 0) &&
    (!("expectedMasterEtag" in value) ||
      typeof value.expectedMasterEtag === "string" && value.expectedMasterEtag.trim().length > 0) &&
    (value.scope !== "all_future" ||
      !("recurringEventId" in value) ||
      typeof value.expectedMasterEtag === "string" && value.expectedMasterEtag.trim().length > 0);
}

function isPendingCleanup(value: unknown): value is PendingScheduleCleanupWire {
  return isRecord(value) && value.kind === "schedule_cleanup" &&
    (value.cleanupScope === "date_scoped" || value.cleanupScope === "unscoped_future") &&
    (!("responseSource" in value) || value.responseSource === "gemini" || value.responseSource === "non_gemini") &&
    Array.isArray(value.items) && value.items.every(isPendingItem) &&
    Array.isArray(value.legacyItems) && value.legacyItems.every(isPendingItem) &&
    Array.isArray(value.series) && value.series.every(isPendingCleanupSeries) &&
    (value.cleanupScope !== "date_scoped" || value.series.length === 0) &&
    Array.isArray(value.calendarEvents) && value.calendarEvents.every((event) =>
      isPendingCleanupCalendarEvent(event) &&
      (value.cleanupScope === "date_scoped" ? event.scope === "this_instance" : event.scope === "all_future"),
    );
}

function parsePendingCleanup(value: unknown): PendingScheduleCleanup | undefined {
  if (!isPendingCleanup(value)) {
    return undefined;
  }
  return {
    ...value,
    responseSource: value.responseSource ?? "non_gemini",
  };
}

function isPendingScheduleCreate(value: unknown): value is PendingScheduleCreate {
  if (!isRecord(value) || value.kind !== "schedule_create" || value.source !== "gemini" ||
    !isExecutableScheduleCommand(value.command)) {
    return false;
  }
  return (value.command.kind === "local" || value.command.kind === "event") &&
    value.command.recurrence !== undefined;
}

/** Deterministic scheduler command handler with encrypted local state and safe reviews. */
export class ScheduleAssistant implements PendingActionMessageHandler {
  private readonly agenda: AgendaService;
  private readonly now: () => Date;

  public constructor(private readonly options: ScheduleAssistantOptions) {
    this.now = options.now ?? (() => new Date());
    this.agenda = new AgendaService({
      ...(options.calendarGateway ? { calendarGateway: options.calendarGateway } : {}),
      ...(options.legacyTaskReader ? { legacyTaskReader: options.legacyTaskReader } : {}),
      now: this.now,
      ownerId: options.ownerId,
      schedulingRepository: options.schedulingRepository,
      timeZone: options.timeZone,
    });
  }

  /** Returns false only when an existing command handler should receive the message. */
  public async handle(message: OwnerDirectMessage): Promise<boolean> {
    if (await this.tryCompleteScheduledItem(message)) {
      return true;
    }

    const now = this.now();
    const parsed = parseScheduleCommand(message.content, { now, timeZone: this.options.timeZone });
    if (parsed.kind === "unsupported") {
      if (shouldDeferToExistingHandler(message.content)) {
        return false;
      }
      const cached = this.options.geminiEnabled === false
        ? undefined
        : isCacheableInput(message.content)
          ? this.options.schedulingRepository.getInterpretation({
            input: message.content,
            now,
            ownerId: this.options.ownerId,
          })
          : undefined;
      if (cached && isExecutableScheduleCommand(cached.command)) {
        if (cached.source === "gemini") {
          markGeminiResponseUsed(message);
        }
        await this.execute(
          message,
          cached.command,
          "cache",
          cached.source === "gemini" ? "gemini" : "non_gemini",
        );
        return true;
      }
      if (this.options.geminiEnabled === false || !this.options.commandPlanner) {
        return false;
      }
      const planned = await this.options.commandPlanner.plan({
        now,
        text: message.content,
        timeZone: this.options.timeZone,
      });
      if (planned && isExecutableScheduleCommand(planned)) {
        markGeminiResponseUsed(message);
        await this.execute(message, planned, "gemini");
        return true;
      }
      this.options.schedulingRepository.putPendingManualCorrection({
        expiresAt: new Date(now.valueOf() + CLEANUP_TTL_MILLISECONDS),
        input: message.content,
        now,
        ownerId: this.options.ownerId,
      });
      await message.reply(
        "I could not safely interpret that request. Reply within 10 minutes using create, title, date, starttime, endtime or duration, optional recurrence, and optional calendar for events.",
      );
      return true;
    }
    if (parsed.kind === "clarify") {
      await message.reply(parsed.message);
      return true;
    }
    await this.execute(message, parsed, /^create\s*:/imu.test(message.content) ? "manual" : "deterministic");
    return true;
  }

  /** Executes a validated unified action without reparsing the model's output. */
  public async handleNaturalLanguageAction(
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, {
      action: "cleanup_schedule" | "create_calendar_event" | "create_task_or_reminder" | "delete_task" | "show_agenda";
    }>,
  ): Promise<boolean> {
    switch (action.action) {
      case "show_agenda":
        await this.execute(message, {
          date: action.date,
          endDate: action.endDate,
          kind: "agenda",
          range: action.range,
        }, "gemini");
        return true;
      case "cleanup_schedule":
        await this.execute(message, {
          ...(action.date ? { date: action.date } : {}),
          kind: "cleanup",
          mode: action.mode,
          targetKinds: action.targetKinds,
          terms: action.terms,
          title: action.title,
        }, "gemini");
        return true;
      case "delete_task":
        if (action.scope !== "single" || !action.selector) {
          return false;
        }
        return this.tryHandleNamedScheduledReminderDeletion(message, action);
      case "create_task_or_reminder":
        await this.execute(message, {
          date: action.date,
          ...(action.recurrence ? { recurrence: toScheduleRecurrence(action.recurrence) } : {}),
          kind: "local",
          scheduleKind: action.scheduleKind,
          ...(action.startTime ? { startTime: action.startTime } : {}),
          title: action.title,
        }, "gemini");
        return true;
      case "create_calendar_event":
        await this.execute(message, {
          ...(action.calendarName ? { calendarName: action.calendarName } : {}),
          date: action.date,
          ...(action.endDate ? { endDate: action.endDate } : {}),
          endTime: action.endTime,
          kind: "event",
          ...(action.recurrence ? { recurrence: toScheduleRecurrence(action.recurrence) } : {}),
          startTime: action.startTime,
          title: action.title,
        }, "gemini");
        return true;
    }
  }

  private async tryHandleNamedScheduledReminderDeletion(
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, { action: "delete_task" }>,
  ): Promise<boolean> {
    const selector = action.selector;
    if (!selector || !selector.title.trim()) {
      return false;
    }
    if (action.date && selector.date && action.date !== selector.date) {
      await message.reply("I could not safely review that deletion request. No changes were made; please try again.");
      return true;
    }
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item or calendar change was made; no confirmation was stored.");
      return true;
    }

    const now = this.now();
    const selectorDate = selector.date ?? action.date;
    const selectorTerms = normalizeTaskSelectorTerms(selector.title);
    const today = localDate(now, this.options.timeZone);
    const throughDate = DateTime.fromJSDate(now, { zone: this.options.timeZone })
      .plus({ years: CLEANUP_LOOKAHEAD_YEARS })
      .toFormat("yyyy-LL-dd");
    try {
      this.options.schedulingRepository.ensureOccurrencesThrough({
        now,
        ownerId: this.options.ownerId,
        throughDate,
      });
      const candidates = this.options.schedulingRepository.listActiveScheduledItems({
        kinds: ["reminder"],
        ownerId: this.options.ownerId,
        scheduledDateEarliest: selectorDate ?? today,
        scheduledDateLatest: selectorDate ?? throughDate,
      }).filter((item) =>
        item.ownerId === this.options.ownerId &&
        item.kind === "reminder" &&
        item.status === "active" &&
        titleMatchesTaskSelector(item.title, selectorTerms) &&
        (selectorDate
          ? item.scheduledDate === selectorDate
          : Boolean(item.dueAt && Number.isFinite(item.dueAt.valueOf()) && item.dueAt > now)),
      );

      if (candidates.length === 0) {
        return false;
      }

      await this.prepareCleanup(message, {
        ...(selectorDate ? { date: selectorDate } : {}),
        kind: "cleanup",
        mode: "named",
        targetKinds: ["reminder"],
        terms: selectorTerms,
        title: selector.title,
      }, "gemini", { includeLegacy: false });
      return true;
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not prepare named scheduled reminder deletion");
      await message.reply("I could not safely review every matching scheduled item. No changes were made; please try again.");
      return true;
    }
  }

  /**
   * Prepares the existing reviewed cleanup flow for one resolver-captured
   * reminder occurrence. A series identifier is deliberately not converted to
   * a series cancellation here.
   */
  public async handleResolvedNamedReminderCancellation(
    message: OwnerDirectMessage,
    candidate: ScheduledReminderCandidate,
    selectorDate?: string,
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item change was made; no confirmation was stored.");
      return;
    }

    const pending: PendingScheduleCleanup = {
      calendarEvents: [],
      cleanupScope: selectorDate ? "date_scoped" : "unscoped_future",
      items: [{ expectedRevision: candidate.expectedRevision, id: candidate.itemId }],
      kind: "schedule_cleanup",
      legacyItems: [],
      responseSource: "gemini",
      series: [],
    };
    if (!candidate.seriesId && !candidate.occurrenceKey) {
      await this.executeCleanup(message, pending);
      return;
    }

    const id = randomUUID();
    try {
      this.options.stateRepository.createPendingAction({
        expiresAt: new Date(this.now().valueOf() + CLEANUP_TTL_MILLISECONDS),
        id,
        ownerId: this.options.ownerId,
        payload: pending,
      });
    } catch (error: unknown) {
      this.options.logger.error({ error: error instanceof Error ? error.name : "unknown" }, "Could not prepare named reminder cancellation");
      await message.reply("I could not safely prepare that reminder cancellation. No changes were made; please try again.");
      return;
    }

    const when = candidate.dueAt
      ? formatDiscordTimestamp(new Date(candidate.dueAt))
      : formatDiscordDate(candidate.scheduledDate, candidate.timeZone);
    await message.reply(
      `Review: cancel reminder ${candidate.title} — ${when}. This action requires confirmation because it was model-proposed. Reply confirm ${id} to continue or cancel ${id} to stop.`,
    );
  }

  public canHandlePendingAction(payload: unknown): boolean {
    return parsePendingCleanup(payload) !== undefined || isPendingScheduleCreate(payload);
  }

  public async handlePendingAction(message: OwnerDirectMessage, instruction: PendingActionInstruction): Promise<boolean> {
    if (instruction.kind === "choose") {
      return false;
    }
    const pending = this.options.stateRepository.getPendingAction({
      id: instruction.actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    const cleanup = pending ? parsePendingCleanup(pending.payload) : undefined;
    const scheduleCreate = pending && isPendingScheduleCreate(pending.payload) ? pending.payload : undefined;
    if (!cleanup && !scheduleCreate) {
      return false;
    }
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item or calendar change was made.");
      return true;
    }
    if (cleanup?.responseSource === "gemini" || scheduleCreate) {
      markGeminiResponseUsed(message);
    }
    if (instruction.kind === "cancel") {
      this.options.stateRepository.consumePendingAction({
        id: instruction.actionId,
        now: this.now(),
        ownerId: this.options.ownerId,
      });
      await message.reply("Cancelled. No scheduled items were changed.");
      return true;
    }
    const consumed = this.options.stateRepository.consumePendingAction({
      id: instruction.actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    const consumedCleanup = consumed ? parsePendingCleanup(consumed.payload) : undefined;
    if (consumedCleanup) {
      if (consumedCleanup.responseSource === "gemini") {
        markGeminiResponseUsed(message);
      }
      await this.executeCleanup(message, consumedCleanup);
      return true;
    }
    const consumedScheduleCreate = consumed && isPendingScheduleCreate(consumed.payload)
      ? consumed.payload
      : undefined;
    if (!consumedScheduleCreate) {
      await message.reply("That confirmation is invalid or has expired.");
      return true;
    }
    markGeminiResponseUsed(message);
    await this.execute(message, consumedScheduleCreate.command, "gemini", "gemini", true);
    return true;
  }

  public async renderAgenda(date: string, endDate: string, range: "day" | "week"): Promise<string> {
    return this.agenda.render({ date, endDate, range });
  }

  private async tryCompleteScheduledItem(message: OwnerDirectMessage): Promise<boolean> {
    const match = /^done\s+([a-f0-9-]{36})$/iu.exec(message.content.trim());
    if (!match?.[1]) {
      return false;
    }
    const item = this.options.schedulingRepository.getScheduledItem({ id: match[1], ownerId: this.options.ownerId });
    if (!item || item.status !== "active") {
      return false;
    }
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item change was made.");
      return true;
    }
    const completed = this.options.schedulingRepository.completeScheduledItem({
      expectedRevision: item.revision,
      id: item.id,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!completed) {
      await message.reply("That scheduled item changed before it could be completed. Please try again.");
      return true;
    }
    this.options.stateRepository.recordAudit?.({
      actionType: "schedule_complete",
      actorId: this.options.ownerId,
      details: { itemId: completed.id },
      status: "succeeded",
    });
    await message.reply(`Completed ${completed.kind}: ${completed.title}.`);
    return true;
  }

  private async execute(
    message: OwnerDirectMessage,
    command: ExecutableScheduleCommand,
    source: CommandSource,
    cleanupResponseSource: CleanupResponseSource = source === "gemini" ? "gemini" : "non_gemini",
    confirmationAccepted = false,
  ): Promise<void> {
    switch (command.kind) {
      case "agenda":
        try {
          await message.reply(await this.agenda.render(command));
        } catch (error: unknown) {
          this.options.logger.error({ error }, "Could not render unified agenda");
          await message.reply("I could not safely retrieve the complete agenda. Please try again.");
        }
        return;
      case "cleanup":
        await this.prepareCleanup(message, command, cleanupResponseSource);
        return;
      case "local":
        await this.createLocal(message, command, source, confirmationAccepted);
        return;
      case "event":
        await this.createEvent(message, command, source, confirmationAccepted);
        return;
    }
  }

  private async createLocal(
    message: OwnerDirectMessage,
    command: Extract<ExecutableScheduleCommand, { readonly kind: "local" }>,
    source: CommandSource,
    confirmationAccepted: boolean,
  ): Promise<void> {
    const now = this.now();
    const today = localDate(now, this.options.timeZone);
    if (command.date < today) {
      await message.reply("Please choose today or a future date for a scheduled task or reminder.");
      return;
    }
    if (command.scheduleKind === "reminder" && !command.startTime) {
      await message.reply("Reminders need a start time.");
      return;
    }
    if (command.scheduleKind === "reminder" && command.startTime) {
      const validation = validateLocalTaskDateTime(command.date, command.startTime, this.options.timeZone);
      if (validation.kind !== "valid") {
        await message.reply("That reminder time is invalid or ambiguous in the configured local time zone.");
        return;
      }
      if (!command.recurrence && validation.value.toUTC().toJSDate() <= now) {
        await message.reply("Please choose a future reminder time.");
        return;
      }
    }

    if (command.recurrence && source === "gemini" && !confirmationAccepted) {
      await this.queueRecurringScheduleConfirmation(message, command);
      return;
    }

    if (this.options.dryRun) {
      await message.reply(
        `Dry run: would create ${command.scheduleKind} ${command.title}. No scheduled item or confirmation was stored.`,
      );
      return;
    }

    try {
      if (command.recurrence) {
        const through = DateTime.fromJSDate(now, { zone: this.options.timeZone })
          .plus({ days: MATERIALIZATION_HORIZON_DAYS })
          .toFormat("yyyy-LL-dd");
        const series = this.options.schedulingRepository.createScheduleSeries({
          id: randomUUID(),
          kind: command.scheduleKind,
          now,
          ownerId: this.options.ownerId,
          recurrence: command.recurrence,
          startDate: command.date,
          ...(command.startTime ? { startTime: command.startTime } : {}),
          timeZone: this.options.timeZone,
          title: command.title,
        }, through);
        this.options.stateRepository.recordAudit?.({
          actionType: "schedule_create",
          actorId: this.options.ownerId,
          details: { kind: series.kind, seriesId: series.id, recurring: true },
          status: "succeeded",
        });
        this.recordCache(source, message.content, command);
        await message.reply(
          `Created recurring ${command.scheduleKind}: ${series.title} starting ${formatDiscordDate(command.date, this.options.timeZone)}.`,
        );
        return;
      }
      let dueAt: Date | undefined;
      if (command.scheduleKind === "reminder" && command.startTime) {
        const validation = validateLocalTaskDateTime(command.date, command.startTime, this.options.timeZone);
        if (validation.kind !== "valid") {
          await message.reply("That reminder time is invalid or ambiguous in the configured local time zone.");
          return;
        }
        dueAt = validation.value.toUTC().toJSDate();
      }
      const item = this.options.schedulingRepository.createScheduledItem({
        ...(dueAt ? { dueAt } : {}),
        id: randomUUID(),
        kind: command.scheduleKind,
        now,
        ownerId: this.options.ownerId,
        scheduledDate: command.date,
        timeZone: this.options.timeZone,
        title: command.title,
      });
      this.options.stateRepository.recordAudit?.({
        actionType: "schedule_create",
        actorId: this.options.ownerId,
        details: { itemId: item.id, kind: item.kind, recurring: false },
        status: "succeeded",
      });
      this.recordCache(source, message.content, command);
      await message.reply(command.scheduleKind === "task"
        ? `Created all-day task: ${item.title} for ${formatDiscordDate(item.scheduledDate, item.timeZone)}.`
        : `Created reminder: ${item.title} at ${formatLocalDue(item, this.options.timeZone)}.`);
    } catch (error: unknown) {
      this.options.stateRepository.recordAudit?.({
        actionType: "schedule_create",
        actorId: this.options.ownerId,
        details: { kind: command.scheduleKind },
        status: "failed",
      });
      this.options.logger.error({ error }, "Could not create local schedule item");
      await message.reply("I could not create that task or reminder safely. Please try again.");
    }
  }

  private async createEvent(
    message: OwnerDirectMessage,
    command: Extract<ExecutableScheduleCommand, { readonly kind: "event" }>,
    source: CommandSource,
    confirmationAccepted: boolean,
  ): Promise<void> {
    if (!this.options.calendarGateway) {
      await message.reply("Google Calendar is not configured for this bot.");
      return;
    }
    try {
      const calendar = await this.resolveWritableCalendar(command.calendarName);
      if (!calendar) {
        await message.reply(command.calendarName
          ? `I could not find one writable calendar named ${command.calendarName}.`
          : "I could not find a writable primary calendar.");
        return;
      }
      const start = strictTimedEventDateTime(command.date, command.startTime, calendar.timeZone);
      const end = strictTimedEventDateTime(command.endDate ?? command.date, command.endTime, calendar.timeZone);
      if (!start || !end) {
        await message.reply("That event time is invalid or ambiguous in the selected calendar time zone.");
        return;
      }
      const startAt = DateTime.fromISO(start.dateTime);
      const endAt = DateTime.fromISO(end.dateTime);
      if (endAt <= startAt) {
        await message.reply("The event end time must be after its start time.");
        return;
      }
      if (!command.recurrence && startAt.toJSDate() <= this.now()) {
        await message.reply("Please choose a future event time.");
        return;
      }
      const conflicts = await this.findCalendarConflicts(calendar, start, end);
      const decision = evaluateMutationSafety({
        ...(conflicts.length > 0 ? { hasCalendarConflict: true } : {}),
        operation: "create",
        ...(source === "gemini" ? { allowModelAutoExecution: true, proposedByModel: true } : {}),
      });
      if (decision.disposition !== "proceed") {
        await message.reply("This calendar creation needs an additional safety review. Please use the existing calendar command flow.");
        return;
      }
      if (this.options.dryRun) {
        await message.reply(
          `Dry run: would create ${command.title} at ${formatDiscordTimestamp(startAt.toUTC().toJSDate())}. No calendar change was made.${decision.warnings.includes("calendar_conflict") ? " It overlaps another event on that calendar." : ""}`,
        );
        return;
      }
      if (command.recurrence && source === "gemini" && !confirmationAccepted) {
        await this.queueRecurringScheduleConfirmation(message, command);
        return;
      }
      const event = await this.options.calendarGateway.createEvent({
        calendarId: calendar.id,
        end,
        ...(command.recurrence ? { recurrence: [buildCalendarRRule(command.recurrence)] } : {}),
        sendUpdates: "none",
        start,
        summary: command.title,
      });
      this.options.stateRepository.recordAudit?.({
        actionType: "schedule_event_create",
        actorId: this.options.ownerId,
        details: { calendarId: calendar.id, eventId: event.id },
        status: "succeeded",
      });
      this.recordCache(source, message.content, command);
      await message.reply(
        `Created event: ${event.summary} on ${calendar.summary}.${conflicts.length > 0 ? " It overlaps another event on that calendar." : ""}`,
      );
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not create scheduled calendar event");
      await message.reply("I could not safely create that calendar event. Please check the date, times, and calendar.");
    }
  }

  private async queueRecurringScheduleConfirmation(
    message: OwnerDirectMessage,
    command: PendingScheduleCreateCommand,
  ): Promise<void> {
    const id = randomUUID();
    this.options.stateRepository.createPendingAction({
      expiresAt: new Date(this.now().valueOf() + CLEANUP_TTL_MILLISECONDS),
      id,
      ownerId: this.options.ownerId,
      payload: {
        command,
        kind: "schedule_create",
        source: "gemini",
      } satisfies PendingScheduleCreate,
    });
    const description = command.kind === "event"
      ? `recurring calendar event ${command.title}`
      : `recurring ${command.scheduleKind} ${command.title}`;
    await message.reply(
      `Creating ${description} requires confirmation. Reply confirm ${id} to create it or cancel ${id} to stop.`,
    );
  }

  private cleanupTargetCount(input: {
    readonly calendarEvents: readonly unknown[];
    readonly items: readonly unknown[];
    readonly legacyItems: readonly unknown[];
    readonly series: readonly unknown[];
  }): number {
    return input.items.length + input.series.length + input.legacyItems.length + input.calendarEvents.length;
  }

  private async prepareCleanup(
    message: OwnerDirectMessage,
    command: Extract<ExecutableScheduleCommand, { readonly kind: "cleanup" }>,
    responseSource: CleanupResponseSource,
    options: { readonly includeLegacy?: boolean } = {},
  ): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item or calendar change was made; no confirmation was stored.");
      return;
    }
    const now = this.now();
    const today = localDate(now, this.options.timeZone);
    const includeLegacy = options.includeLegacy ?? true;
    try {
      this.options.schedulingRepository.ensureOccurrencesThrough({
        now,
        ownerId: this.options.ownerId,
        throughDate: DateTime.fromJSDate(now, { zone: this.options.timeZone }).plus({ years: CLEANUP_LOOKAHEAD_YEARS }).toFormat("yyyy-LL-dd"),
      });
      const localKinds = command.targetKinds.filter((kind): kind is ScheduleKind => kind === "task" || kind === "reminder");
      const local = localKinds.length === 0
        ? []
        : this.options.schedulingRepository.listActiveScheduledItems({
          kinds: localKinds,
          ownerId: this.options.ownerId,
          scheduledDateEarliest: command.date ?? today,
          scheduledDateLatest: command.date ?? "9999-12-31",
        }).filter((item) =>
          titleIncludesTerms(item.title, command.terms) &&
          (command.date !== undefined || isStrictlyFutureLocalCleanupCandidate(item, now)),
        );
      const localSingles = command.date ? local : local.filter((item) => !item.seriesId);
      const series = command.date ? [] : uniqueSeries(local);
      const legacySearch: LegacyCleanupCandidateSearch = includeLegacy
        ? this.findLegacyCleanupCandidates(command, now)
        : { candidates: [], mayBeTruncated: false };
      const legacy = legacySearch.candidates;
      const calendarEvents = await this.findCalendarCleanupCandidates(command, now);
      const targetCount = this.cleanupTargetCount({
        calendarEvents,
        items: localSingles,
        legacyItems: legacy,
        series,
      });
      if (targetCount > MAX_BULK_SCHEDULE_CANCELLATIONS ||
        localSingles.length > MAX_BULK_SCHEDULE_CANCELLATIONS ||
        legacy.length > MAX_BULK_LOCAL_TASK_CANCELLATIONS || legacySearch.mayBeTruncated) {
        await message.reply(
          `I found more than ${MAX_BULK_SCHEDULE_CANCELLATIONS} matching scheduled items. Narrow the request before deleting them; no changes were made.`,
        );
        return;
      }
      if (targetCount === 0) {
        const targets = command.targetKinds.length === 1 ? `${command.targetKinds[0]}s` : "tasks, reminders, or events";
        const scope = command.date
          ? ` for ${formatDiscordDate(command.date, this.options.timeZone)}`
          : command.mode === "bulk" ? "" : ` related to ${command.title}`;
        await message.reply(`I found no ${command.date ? "active" : "future active"} ${targets}${scope}.`);
        return;
      }

      const payload: PendingScheduleCleanup = {
        calendarEvents: calendarEvents.map((candidate) => ({
          calendarId: candidate.calendar.id,
          etag: candidate.event.etag,
          eventId: candidate.event.id,
          ...(candidate.expectedMasterEtag ? { expectedMasterEtag: candidate.expectedMasterEtag } : {}),
          hasExternalGuests: candidate.hasExternalGuests,
          ...(candidate.event.recurringEventId ? { recurringEventId: candidate.event.recurringEventId } : {}),
          scope: candidate.scope,
          summary: candidate.event.summary,
        })),
        cleanupScope: command.date ? "date_scoped" : "unscoped_future",
        items: localSingles.map((item) => ({ expectedRevision: item.revision, id: item.id })),
        kind: "schedule_cleanup",
        legacyItems: legacy.map((item) => ({ expectedRevision: item.revision, id: item.id })),
        responseSource,
        series,
      };
      const deleteImmediately = responseSource !== "gemini" && targetCount === 1 &&
        (command.mode === "named" || command.mode === "bulk" && command.date !== undefined) &&
        series.length === 0 &&
        !calendarEvents.some((candidate) =>
          candidate.requiresConfirmation || candidate.hasExternalGuests ||
          candidate.scope === "all_future" && Boolean(candidate.event.recurringEventId),
        );
      if (deleteImmediately) {
        await this.executeCleanup(message, payload);
        return;
      }

      const id = randomUUID();
      this.options.stateRepository.createPendingAction({
        expiresAt: new Date(now.valueOf() + CLEANUP_TTL_MILLISECONDS),
        id,
        ownerId: this.options.ownerId,
        payload,
      });
      const lines = [
        ...localSingles.map((item) => `- ${item.kind}: ${item.title} (${formatScheduledItemDate(item, this.options.timeZone)})`),
        ...series.map((item) => `- recurring ${item.title} (all future occurrences from ${formatDiscordDate(item.fromDate, this.options.timeZone)})`),
        ...legacy.map((item) => `- legacy reminder: ${item.title} (${formatLegacyDue(item, this.options.timeZone)})`),
        ...calendarEvents.map((candidate) => `- calendar event: ${candidate.event.summary} on ${candidate.calendar.summary}${candidate.hasExternalGuests ? " (guests will be notified)" : ""}${candidate.requiresConfirmation ? " (spans multiple dates)" : ""}`),
      ];
      const scope = command.date ? ` for ${formatDiscordDate(command.date, this.options.timeZone)}` : ` for ${command.title}`;
      await message.reply(
        `Review matches${scope}:\n${lines.join("\n")}\nReply confirm ${id} to delete/cancel these items or cancel ${id} to stop.`,
      );
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not prepare reviewed schedule cleanup");
      await message.reply("I could not safely review every matching scheduled item. No changes were made; please try again.");
    }
  }

  private async executeCleanup(message: OwnerDirectMessage, pending: PendingScheduleCleanup): Promise<void> {
    if (this.options.dryRun) {
      await message.reply("Dry run: no scheduled item or calendar change was made.");
      return;
    }
    const targetCount = this.cleanupTargetCount(pending);
    if (targetCount > MAX_BULK_SCHEDULE_CANCELLATIONS) {
      this.options.logger.error({ targetCount }, "Refused oversized reviewed schedule cleanup");
      await message.reply(
        `I found more than ${MAX_BULK_SCHEDULE_CANCELLATIONS} matching scheduled items. Narrow the request before deleting them; no changes were made.`,
      );
      return;
    }

    const now = this.now();
    const requiresFutureEligibility = pending.cleanupScope === "unscoped_future";
    let cancelled = 0;
    let failed = 0;

    try {
      if (pending.items.length > 0) {
        if (requiresFutureEligibility && !this.arePendingScheduledItemsStillFuture(pending.items, now)) {
          failed += pending.items.length;
        } else {
          const result = this.options.schedulingRepository.cancelScheduledItems({
            now,
            ownerId: this.options.ownerId,
            targets: pending.items,
          });
          if (result) {
            cancelled += result.length;
          } else {
            failed += pending.items.length;
          }
        }
      }
    } catch (error: unknown) {
      this.options.logger.error({ error }, "Could not cancel reviewed scheduled items");
      failed += pending.items.length;
    }

    for (const series of pending.series) {
      try {
        if (requiresFutureEligibility && !this.isPendingSeriesAnchorStillFuture(series, now)) {
          failed += 1;
          continue;
        }
        const count = this.options.schedulingRepository.cancelScheduleSeries({
          anchor: { expectedRevision: series.expectedRevision, id: series.id },
          fromDate: series.fromDate,
          now,
          ownerId: this.options.ownerId,
          seriesId: series.seriesId,
        });
        cancelled += count;
        if (count === 0) {
          failed += 1;
        }
      } catch (error: unknown) {
        this.options.logger.error({ error, seriesId: series.seriesId }, "Could not cancel reviewed schedule series");
        failed += 1;
      }
    }

    if (pending.legacyItems.length > 0) {
      if (!this.options.stateRepository.cancelLocalTasks) {
        failed += pending.legacyItems.length;
      } else if (requiresFutureEligibility && !this.arePendingLegacyItemsStillFuture(pending.legacyItems, now)) {
        failed += pending.legacyItems.length;
      } else {
        try {
          const result = this.options.stateRepository.cancelLocalTasks({
            now,
            ownerId: this.options.ownerId,
            tasks: pending.legacyItems,
          });
          if (result) {
            cancelled += result.length;
          } else {
            failed += pending.legacyItems.length;
          }
        } catch (error: unknown) {
          this.options.logger.error({ error }, "Could not cancel reviewed legacy local tasks");
          failed += pending.legacyItems.length;
        }
      }
    }

    for (const target of pending.calendarEvents) {
      const result = await this.executeCalendarCleanupTarget(target, now, requiresFutureEligibility);
      if (result) {
        cancelled += 1;
      } else {
        failed += 1;
      }
    }

    this.options.stateRepository.recordAudit?.({
      actionType: "schedule_cleanup",
      actorId: this.options.ownerId,
      details: { cancelled, failed },
      status: failed === 0 ? "succeeded" : "failed",
    });
    await message.reply(
      failed === 0
        ? `Cancelled or deleted ${cancelled} scheduled item${cancelled === 1 ? "" : "s"}.`
        : `Cancelled or deleted ${cancelled} item${cancelled === 1 ? "" : "s"}; ${failed} item${failed === 1 ? "" : "s"} changed or could not be removed.`,
    );
  }

  private arePendingScheduledItemsStillFuture(items: readonly PendingCleanupItem[], now: Date): boolean {
    return items.every((target) => {
      const item = this.options.schedulingRepository.getScheduledItem({
        id: target.id,
        ownerId: this.options.ownerId,
      });
      return Boolean(
        item &&
        item.status === "active" &&
        item.revision === target.expectedRevision &&
        isStrictlyFutureLocalCleanupCandidate(item, now),
      );
    });
  }

  private isPendingSeriesAnchorStillFuture(series: PendingCleanupSeries, now: Date): boolean {
    const anchor = this.options.schedulingRepository.getScheduledItem({
      id: series.id,
      ownerId: this.options.ownerId,
    });
    return Boolean(
      anchor &&
      anchor.status === "active" &&
      anchor.revision === series.expectedRevision &&
      isStrictlyFutureLocalCleanupCandidate(anchor, now),
    );
  }

  private arePendingLegacyItemsStillFuture(items: readonly PendingCleanupItem[], now: Date): boolean {
    const stateRepository = this.options.stateRepository;
    const getLocalTask = stateRepository.getLocalTask;
    if (!getLocalTask) {
      return false;
    }
    return items.every((target) => {
      const item = getLocalTask.call(stateRepository, { id: target.id, ownerId: this.options.ownerId });
      return Boolean(
        item &&
        item.status === "active" &&
        item.revision === target.expectedRevision &&
        item.dueAt > now,
      );
    });
  }

  private async executeCalendarCleanupTarget(
    target: PendingCleanupCalendarEvent,
    now: Date,
    requiresFutureEligibility: boolean,
  ): Promise<boolean> {
    if (!this.options.calendarGateway) {
      return false;
    }
    try {
      const calendars = await this.options.calendarGateway.listCalendars();
      const calendar = calendars.find((candidate) => candidate.id === target.calendarId);
      if (!calendar || calendar.readOnly) {
        return false;
      }
      const latest = await this.options.calendarGateway.getEvent({ calendarId: target.calendarId, eventId: target.eventId });
      if (latest.status === "cancelled" || !hasUsableEtag(latest) || latest.etag !== target.etag) {
        return false;
      }
      if (requiresFutureEligibility && !isFutureCalendarCleanupCandidate(latest, calendar, now)) {
        return false;
      }
      const scope = target.scope;
      if (isRecurringEvent(latest)) {
        if (!target.recurringEventId || latest.recurringEventId !== target.recurringEventId) {
          return false;
        }
        if (scope === "all_future") {
          if (!target.expectedMasterEtag) {
            return false;
          }
          const master = await this.options.calendarGateway.getEvent({
            calendarId: target.calendarId,
            eventId: target.recurringEventId,
          });
          if (master.status === "cancelled" || master.id !== target.recurringEventId || !isRecurringEvent(master) ||
            !hasUsableEtag(master) || master.etag !== target.expectedMasterEtag) {
            return false;
          }
          await this.options.calendarGateway.truncateRecurringEvent({
            calendarId: target.calendarId,
            master,
            sendUpdates: hasExternalGuests(master) || hasExternalGuests(latest) ? "all" : "none",
            targetOccurrence: latest,
          });
        } else {
          await this.options.calendarGateway.deleteEvent({
            calendarId: target.calendarId,
            etag: latest.etag,
            eventId: latest.id,
            sendUpdates: hasExternalGuests(latest) ? "all" : "none",
          });
        }
        return true;
      }
      if (target.recurringEventId || target.expectedMasterEtag) {
        return false;
      }
      await this.options.calendarGateway.deleteEvent({
        calendarId: target.calendarId,
        etag: latest.etag,
        eventId: latest.id,
        sendUpdates: hasExternalGuests(latest) ? "all" : "none",
      });
      return true;
    } catch (error: unknown) {
      this.options.logger.error({ error, eventId: target.eventId }, "Could not complete reviewed calendar cleanup");
      return false;
    }
  }

  private findLegacyCleanupCandidates(
    command: Extract<ExecutableScheduleCommand, { readonly kind: "cleanup" }>,
    now: Date,
  ): LegacyCleanupCandidateSearch {
    // Legacy LocalTask rows always carry a due instant and are presented as reminders.
    if (!this.options.stateRepository.listActiveLocalTasks || !command.targetKinds.includes("reminder")) {
      return { candidates: [], mayBeTruncated: false };
    }
    const activeItems = this.options.stateRepository.listActiveLocalTasks({
      limit: MAX_LEGACY_CLEANUP_SCAN_ITEMS,
      ownerId: this.options.ownerId,
    });
    return {
      candidates: activeItems.filter((item) =>
        titleIncludesTerms(item.title, command.terms) &&
        (command.date ? localDate(item.dueAt, item.timeZone) === command.date : item.dueAt > now),
      ),
      mayBeTruncated: activeItems.length >= MAX_LEGACY_CLEANUP_SCAN_ITEMS,
    };
  }

  private async findCalendarCleanupCandidates(
    command: Extract<ExecutableScheduleCommand, { readonly kind: "cleanup" }>,
    now: Date,
  ): Promise<readonly CalendarCleanupCandidate[]> {
    if (!this.options.calendarGateway || !command.targetKinds.includes("event")) {
      return [];
    }
    const scope: CalendarCleanupScope = command.date ? "this_instance" : "all_future";
    const calendars = (await this.options.calendarGateway.listCalendars()).filter((calendar) => !calendar.readOnly);
    const results = await Promise.all(calendars.map(async (calendar) => {
      const dayStart = command.date ? DateTime.fromISO(command.date, { zone: calendar.timeZone }).startOf("day") : undefined;
      const dayEnd = dayStart?.plus({ days: 1 });
      const events = await this.options.calendarGateway!.listEvents({
        calendarId: calendar.id,
        timeMax: dayEnd?.toUTC().toISO() ?? DateTime.fromJSDate(now, { zone: "utc" }).plus({ years: CLEANUP_LOOKAHEAD_YEARS }).toISO() ?? "",
        timeMin: dayStart?.toUTC().toISO() ?? now.toISOString(),
      });
      return events
        .filter((event) => event.status !== "cancelled" && hasUsableEtag(event) && titleIncludesTerms(event.summary, command.terms))
        .filter((event) => {
          if (!command.date) {
            return isFutureCalendarCleanupCandidate(event, calendar, now);
          }
          if (!dayStart || !dayEnd) {
            return false;
          }
          if (event.start.kind === "all_day") {
            return event.start.date <= command.date && event.end.kind === "all_day" && event.end.date > command.date;
          }
          const eventStart = calendarDateTimeToDateTime(event.start, calendar.timeZone).toMillis();
          const eventEnd = calendarDateTimeToDateTime(event.end, calendar.timeZone).toMillis();
          return eventStart < dayEnd.toMillis() && eventEnd > dayStart.toMillis();
        })
        .map((event) => ({
          calendar,
          event,
          requiresConfirmation: Boolean(
            command.date && dayStart && dayEnd &&
            crossesDateScopedCalendarBoundary(event, calendar, dayStart, dayEnd),
          ),
          scope,
        }));
    }));
    const deduplicated = new Map<string, {
      calendar: CalendarReference;
      event: CalendarEvent;
      requiresConfirmation: boolean;
      scope: CalendarCleanupScope;
    }>();
    for (const candidate of results.flat()) {
      const key = candidate.scope === "this_instance"
        ? `${candidate.calendar.id}:${candidate.event.id}`
        : `${candidate.calendar.id}:${candidate.event.recurringEventId ?? candidate.event.id}`;
      const previous = deduplicated.get(key);
      if (!previous || eventStartMillis(candidate.event, candidate.calendar.timeZone) < eventStartMillis(previous.event, previous.calendar.timeZone)) {
        deduplicated.set(key, candidate);
      }
    }

    const reviewed: CalendarCleanupCandidate[] = [];
    for (const candidate of deduplicated.values()) {
      let master: CalendarEvent | undefined;
      if (candidate.scope === "all_future" && candidate.event.recurringEventId) {
        master = await this.options.calendarGateway.getEvent({
          calendarId: candidate.calendar.id,
          eventId: candidate.event.recurringEventId,
        });
        if (master.status === "cancelled" || !hasUsableEtag(master)) {
          throw new Error("A recurring cleanup target no longer has a usable series version marker");
        }
      }
      reviewed.push({
        calendar: candidate.calendar,
        event: candidate.event,
        ...(master ? { expectedMasterEtag: master.etag } : {}),
        hasExternalGuests: hasExternalGuests(master ?? candidate.event),
        requiresConfirmation: candidate.requiresConfirmation,
        scope: candidate.scope,
      });
    }
    return reviewed;
  }

  private async resolveWritableCalendar(name: string | undefined): Promise<CalendarReference | undefined> {
    if (!this.options.calendarGateway) {
      return undefined;
    }
    const calendars = await this.options.calendarGateway.listCalendars();
    if (!name) {
      return calendars.find((calendar) => calendar.isPrimary && !calendar.readOnly) ??
        calendars.find((calendar) => !calendar.readOnly);
    }
    const normalized = normalizeCalendarName(name);
    const matches = calendars.filter((calendar) => !calendar.readOnly && normalizeCalendarName(calendar.summary) === normalized);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async findCalendarConflicts(
    calendar: CalendarReference,
    start: TimedEventDateTime,
    end: TimedEventDateTime,
  ): Promise<readonly CalendarEvent[]> {
    if (!this.options.calendarGateway) {
      return [];
    }
    const requestedStart = DateTime.fromISO(start.dateTime);
    const requestedEnd = DateTime.fromISO(end.dateTime);
    const events = await this.options.calendarGateway.listEvents({
      calendarId: calendar.id,
      timeMax: end.dateTime,
      timeMin: start.dateTime,
    });
    return events.filter((event) => {
      if (event.status === "cancelled" || event.start.kind !== "timed" || event.end.kind !== "timed") {
        return false;
      }
      const eventStart = DateTime.fromISO(event.start.dateTime);
      const eventEnd = DateTime.fromISO(event.end.dateTime);
      return eventStart < requestedEnd && eventEnd > requestedStart;
    });
  }

  private recordCache(source: CommandSource, input: string, command: ExecutableScheduleCommand): void {
    if (source !== "manual" && source !== "gemini" || source === "gemini" && this.options.geminiEnabled === false) {
      return;
    }
    const now = this.now();
    const cacheInput = source === "manual"
      ? this.options.schedulingRepository.consumePendingManualCorrection({ now, ownerId: this.options.ownerId })
      : input;
    if (!cacheInput || !isCacheableInput(cacheInput)) {
      return;
    }
    try {
      this.options.schedulingRepository.putInterpretation({
        command,
        expiresAt: new Date(now.valueOf() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1_000),
        input: cacheInput,
        now,
        ownerId: this.options.ownerId,
        source: source === "gemini" ? "gemini" : "manual",
      });
    } catch (error: unknown) {
      // A cache failure must not turn a completed owner request into a failed one.
      this.options.logger.error({ error }, "Could not persist schedule interpretation cache entry");
    }
  }
}

function toScheduleRecurrence(value: {
  readonly frequency: ScheduleRecurrence["frequency"];
  readonly interval: number;
  readonly weekdays?: readonly number[] | undefined;
}): ScheduleRecurrence {
  return {
    frequency: value.frequency,
    interval: value.interval,
    ...(value.weekdays ? { weekdays: value.weekdays } : {}),
  };
}

function strictTimedEventDateTime(date: string, time: string, timeZone: string): TimedEventDateTime | undefined {
  const validation = validateLocalTaskDateTime(date, time, timeZone);
  if (validation.kind !== "valid") {
    return undefined;
  }
  const dateTime = validation.value.toISO();
  return dateTime ? { dateTime, kind: "timed", timeZone } : undefined;
}

function localDate(value: Date, timeZone: string): string {
  return DateTime.fromJSDate(value, { zone: timeZone }).toFormat("yyyy-LL-dd");
}

function formatLocalDue(item: ScheduledItem, timeZone: string): string {
  return item.dueAt
    ? formatDiscordTimestamp(item.dueAt)
    : formatDiscordDate(item.scheduledDate, item.timeZone || timeZone);
}

function formatLegacyDue(item: LocalTask, _timeZone: string): string {
  return formatDiscordTimestamp(item.dueAt);
}

function formatScheduledItemDate(item: ScheduledItem, timeZone: string): string {
  return item.dueAt
    ? formatDiscordTimestamp(item.dueAt)
    : formatDiscordDate(item.scheduledDate, item.timeZone || timeZone);
}

function uniqueSeries(items: readonly ScheduledItem[]): readonly PendingCleanupSeries[] {
  const series = new Map<string, PendingCleanupSeries>();
  for (const item of items) {
    if (!item.seriesId) {
      continue;
    }
    const existing = series.get(item.seriesId);
    if (!existing || item.scheduledDate < existing.fromDate) {
      series.set(item.seriesId, {
        expectedRevision: item.revision,
        fromDate: item.scheduledDate,
        id: item.id,
        seriesId: item.seriesId,
        title: item.title,
      });
    }
  }
  return [...series.values()];
}

function hasUsableEtag(event: CalendarEvent): boolean {
  return event.etag.trim().length > 0;
}

function titleIncludesTerms(title: string, terms: readonly string[]): boolean {
  const normalized = title.toLocaleLowerCase();
  return terms.every((term) => normalized.includes(term.toLocaleLowerCase()));
}

function eventStartMillis(event: CalendarEvent, timeZone: string): number {
  return calendarDateTimeToDateTime(event.start, timeZone).toMillis();
}

function crossesDateScopedCalendarBoundary(
  event: CalendarEvent,
  calendar: CalendarReference,
  dayStart: DateTime,
  dayEnd: DateTime,
): boolean {
  if (event.start.kind === "all_day") {
    return event.end.kind !== "all_day" ||
      event.start.date !== dayStart.toFormat("yyyy-LL-dd") ||
      event.end.date !== dayEnd.toFormat("yyyy-LL-dd");
  }
  if (event.end.kind !== "timed") {
    return true;
  }
  const eventStart = calendarDateTimeToDateTime(event.start, calendar.timeZone).toMillis();
  const eventEnd = calendarDateTimeToDateTime(event.end, calendar.timeZone).toMillis();
  return eventStart < dayStart.toMillis() || eventEnd > dayEnd.toMillis();
}

function isStrictlyFutureLocalCleanupCandidate(item: ScheduledItem, now: Date): boolean {
  if (item.kind === "task") {
    return item.scheduledDate > localDate(now, item.timeZone);
  }
  return Boolean(item.dueAt && item.dueAt > now);
}

function isFutureCalendarCleanupCandidate(event: CalendarEvent, calendar: CalendarReference, now: Date): boolean {
  if (event.start.kind === "all_day") {
    return event.start.date > localDate(now, event.start.timeZone || calendar.timeZone);
  }
  return calendarDateTimeToDateTime(event.start, calendar.timeZone).toJSDate() > now;
}

function normalizeCalendarName(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function isDeferredLegacyCalendarDelete(content: string): boolean {
  const value = normalizeTemporalAliases(content).trim().toLocaleLowerCase();
  return /^delete\s+(?:the\s+)?(?:\d|[a-z])/u.test(value) && /\b(?:meeting|appointment|event)\b/u.test(value);
}

function shouldDeferToExistingHandler(content: string): boolean {
  const value = normalizeTemporalAliases(content).trim().toLocaleLowerCase();
  return /^(?:tasks?|list\s+tasks?)$/u.test(value) ||
    /^(?:done|complete\s+task|cancel\s+task|delete\s+task|delete\s+all\s+tasks?)\b/u.test(value) ||
    /^remind\s+me\s+in\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?)\s+to\b/u.test(value) ||
    /^remind\s+me\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?)\s+before\b/u.test(value) ||
    /^(?:show|list|view)\s+(?:me\s+)?(?:my\s+)?calendar\b/u.test(value) ||
    isDeferredLegacyCalendarDelete(content) ||
    /^(?:change|move|reschedule)\b/u.test(value);
}

function isCacheableInput(value: string): boolean {
  // Resolved relative phrases would become stale after midnight or the next week.
  const normalized = normalizeTemporalAliases(value);
  return !/\b(?:today|tomorrow|this\s+week|next\s+week|next\s+(?:mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))\b/iu.test(normalized) &&
    !/\bin\s+\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\b/iu.test(normalized) &&
    !/\b(?:mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/iu.test(normalized);
}
