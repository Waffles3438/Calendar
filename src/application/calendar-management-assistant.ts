import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  CalendarManagementError,
  type CalendarManagementService,
  type CalendarMigrationStatus,
} from "./calendar-management-service.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import { normalizeCalendarName } from "../domain/calendar-management.js";
import type { PendingAction } from "../persistence/state-repository.js";
import type { PendingActionInstruction, PendingActionMessageHandler } from "./pending-action.js";

interface CalendarDeleteSelection {
  readonly destinationCalendarIds: readonly string[];
  readonly kind: "calendar_delete_selection";
  readonly sourceCalendarId: string;
  readonly sourceCalendarName: string;
}

interface CalendarDeleteConfirmation {
  readonly destinationCalendarId: string;
  readonly destinationCalendarName: string;
  readonly kind: "calendar_delete_confirmation";
  readonly sourceCalendarId: string;
  readonly sourceCalendarName: string;
}

type CalendarManagementPendingAction = CalendarDeleteConfirmation | CalendarDeleteSelection;

export interface CalendarManagementAssistantOptions {
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly service: CalendarManagementService;
  readonly stateRepository: {
    consumePendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
    createPendingAction(input: { expiresAt: Date; id: string; ownerId: string; payload: unknown }): void;
    getPendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
  };
  readonly pendingActionTtlMilliseconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPendingCalendarManagementAction(value: unknown): value is CalendarManagementPendingAction {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "calendar_delete_selection") {
    return typeof value.sourceCalendarId === "string" &&
      typeof value.sourceCalendarName === "string" &&
      Array.isArray(value.destinationCalendarIds) &&
      value.destinationCalendarIds.every((id) => typeof id === "string");
  }
  return value.kind === "calendar_delete_confirmation" &&
    typeof value.destinationCalendarId === "string" &&
    typeof value.destinationCalendarName === "string" &&
    typeof value.sourceCalendarId === "string" &&
    typeof value.sourceCalendarName === "string";
}

export class CalendarManagementAssistant implements PendingActionMessageHandler {
  private readonly now: () => Date;
  private readonly pendingActionTtlMilliseconds: number;

  public constructor(private readonly options: CalendarManagementAssistantOptions) {
    this.now = options.now ?? (() => new Date());
    this.pendingActionTtlMilliseconds = options.pendingActionTtlMilliseconds ?? 10 * 60 * 1_000;
  }

  public canHandlePendingAction(payload: unknown): boolean {
    return isPendingCalendarManagementAction(payload);
  }

  public async handlePendingAction(
    message: OwnerDirectMessage,
    instruction: PendingActionInstruction,
  ): Promise<boolean> {
    if (message.authorId !== this.options.ownerId) {
      return false;
    }
    const pending = this.options.stateRepository.getPendingAction({
      id: instruction.actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!pending || !isPendingCalendarManagementAction(pending.payload)) {
      return false;
    }

    if (instruction.kind === "cancel") {
      this.options.stateRepository.consumePendingAction({
        id: instruction.actionId,
        now: this.now(),
        ownerId: this.options.ownerId,
      });
      await message.reply("Cancelled. No calendar change was made.");
      return true;
    }

    if (pending.payload.kind === "calendar_delete_selection") {
      if (instruction.kind !== "choose") {
        await message.reply("That action needs a destination number. Reply choose <action-id> <number>.");
        return true;
      }
      await this.handleDestinationSelection(message, instruction.actionId, instruction.choice, pending);
      return true;
    }

    if (instruction.kind !== "confirm") {
      await message.reply(`Reply confirm ${instruction.actionId} to begin the migration, or cancel ${instruction.actionId} to stop.`);
      return true;
    }
    await this.handleDeleteConfirmation(message, instruction.actionId);
    return true;
  }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    if (message.authorId !== this.options.ownerId) {
      return;
    }
    const content = message.content.trim();
    if (/^(?:calendars|list\s+calendars)$/iu.test(content)) {
      await this.listCalendars(message);
      return;
    }

    const resume = /^resume\s+calendar\s+migration\s+([a-f0-9-]+)$/iu.exec(content);
    if (resume?.[1]) {
      await this.resumeMigration(message, resume[1]);
      return;
    }

    const add = /^(?:add|create)\s+calendar(?:\s+([a-z0-9-]+))?(?:\s+name\s+(.+?))?(?:\s+color\s+(#[0-9a-f]{6}))?(?:\s+description\s+(.+))?$/iu.exec(content);
    if (add) {
      await this.addCalendar(message, add[1], add[2], add[3], add[4]);
      return;
    }

    const visibility = /^(show|hide)\s+calendar\s+(.+)$/iu.exec(content);
    if (visibility?.[1] && visibility[2]) {
      await this.changeVisibility(message, visibility[1].toLocaleLowerCase() === "hide", visibility[2]);
      return;
    }

    const edit = /^edit\s+calendar\s+(.+?)\s+name\s+(.+?)(?:\s+color\s+(#[0-9a-f]{6}))?(?:\s+description\s+(.+))?$/iu.exec(content);
    if (edit?.[1] && edit[2]) {
      await this.editCalendar(message, edit[1], edit[2], edit[3], edit[4]);
      return;
    }

    const deleteCommand = /^(?:delete|remove)\s+calendar\s+(.+)$/iu.exec(content);
    if (deleteCommand?.[1]) {
      await this.beginDelete(message, deleteCommand[1]);
      return;
    }

    await message.reply("Calendar management commands: calendars; add calendar [template]; edit calendar <name> name <new name>; show/hide calendar <name>; delete calendar <name>.");
  }

  private async listCalendars(message: OwnerDirectMessage): Promise<void> {
    try {
      const calendars = await this.options.service.listCalendars();
      if (calendars.length === 0) {
        await message.reply("No Google calendars were found.");
        return;
      }
      await message.reply(calendars.map((calendar, index) => {
        const marker = calendar.selected && !calendar.hidden ? "☑" : "☐";
        const flags = [
          ...(calendar.isPrimary ? ["primary"] : []),
          ...(calendar.readOnly ? ["read-only"] : []),
          ...(calendar.hidden ? ["hidden"] : []),
        ];
        return `${index + 1}. ${marker} ${calendar.summary}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}${calendar.backgroundColor ? ` ${calendar.backgroundColor}` : ""}`;
      }).join("\n"));
    } catch (error: unknown) {
      await this.fail(message, error, "I could not list the Google calendars.");
    }
  }

  private async addCalendar(
    message: OwnerDirectMessage,
    templateId: string | undefined,
    name: string | undefined,
    color: string | undefined,
    description: string | undefined,
  ): Promise<void> {
    try {
      const created = await this.options.service.createCalendar({
        ...(color ? { color } : {}),
        ...(description ? { description } : {}),
        ...(name ? { name } : {}),
        ...(templateId ? { templateId } : {}),
      });
      await message.reply(`Created calendar ${created.summary}.`);
    } catch (error: unknown) {
      await this.fail(message, error, "I could not create that calendar.");
    }
  }

  private async editCalendar(
    message: OwnerDirectMessage,
    currentName: string,
    name: string,
    color: string | undefined,
    description: string | undefined,
  ): Promise<void> {
    try {
      const calendar = await this.resolveCalendar(currentName);
      const updated = await this.options.service.updateCalendar(calendar.id, {
        ...(color ? { color } : {}),
        ...(description ? { description } : {}),
        name: normalizeCalendarName(name),
      });
      await message.reply(`Updated calendar ${updated.summary}.`);
    } catch (error: unknown) {
      await this.fail(message, error, "I could not update that calendar.");
    }
  }

  private async changeVisibility(message: OwnerDirectMessage, hidden: boolean, name: string): Promise<void> {
    try {
      const calendar = await this.resolveCalendar(name);
      const updated = await this.options.service.setCalendarVisibility(calendar.id, {
        hidden,
        selected: !hidden,
      });
      await message.reply(`${updated.summary} is now ${hidden ? "hidden" : "visible"}.`);
    } catch (error: unknown) {
      await this.fail(message, error, "I could not change that calendar's visibility.");
    }
  }

  private async beginDelete(message: OwnerDirectMessage, name: string): Promise<void> {
    try {
      const calendar = await this.resolveCalendar(name);
      const preview = await this.options.service.previewCalendarDeletion(calendar.id);
      const actionId = randomUUID();
      const payload: CalendarDeleteSelection = {
        destinationCalendarIds: preview.destinations.map((destination) => destination.id),
        kind: "calendar_delete_selection",
        sourceCalendarId: preview.source.id,
        sourceCalendarName: preview.source.summary,
      };
      this.options.stateRepository.createPendingAction({
        expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
        id: actionId,
        ownerId: this.options.ownerId,
        payload,
      });
      await message.reply(`Deleting ${preview.source.summary} will move its supported events first. Choose an existing destination:\n${preview.destinations.map((destination, index) => `${index + 1}. ${destination.summary}`).join("\n")}\nReply choose ${actionId} <number>, or cancel ${actionId}.`);
    } catch (error: unknown) {
      await this.fail(message, error, "I could not prepare that calendar deletion.");
    }
  }

  private async handleDestinationSelection(
    message: OwnerDirectMessage,
    actionId: string,
    choice: number,
    pending: PendingAction,
  ): Promise<void> {
    if (!isPendingCalendarManagementAction(pending.payload) || pending.payload.kind !== "calendar_delete_selection") {
      await message.reply("That destination selection is invalid or has expired.");
      return;
    }
    const destinationId = pending.payload.destinationCalendarIds[choice - 1];
    if (!destinationId) {
      await message.reply("That destination number is not available. Choose a number from the list.");
      return;
    }
    try {
      const calendars = await this.options.service.listCalendars();
      const destination = calendars.find((calendar) => calendar.id === destinationId);
      if (!destination || destination.hidden || !destination.canManageEvents) {
        await message.reply("That destination calendar is no longer available. Please start the deletion again.");
        return;
      }
      const consumed = this.options.stateRepository.consumePendingAction({
        id: actionId,
        now: this.now(),
        ownerId: this.options.ownerId,
      });
      if (!consumed) {
        await message.reply("That destination selection is invalid or has expired.");
        return;
      }
      const confirmationId = randomUUID();
      const confirmation: CalendarDeleteConfirmation = {
        destinationCalendarId: destination.id,
        destinationCalendarName: destination.summary,
        kind: "calendar_delete_confirmation",
        sourceCalendarId: pending.payload.sourceCalendarId,
        sourceCalendarName: pending.payload.sourceCalendarName,
      };
      this.options.stateRepository.createPendingAction({
        expiresAt: new Date(this.now().valueOf() + this.pendingActionTtlMilliseconds),
        id: confirmationId,
        ownerId: this.options.ownerId,
        payload: confirmation,
      });
      await message.reply(`Review: move supported events from ${confirmation.sourceCalendarName} to ${confirmation.destinationCalendarName}, then delete the source calendar. Guest notifications may be sent. Reply confirm ${confirmationId} to continue or cancel ${confirmationId}.`);
    } catch (error: unknown) {
      await this.fail(message, error, "I could not verify that destination calendar. Please try again.");
    }
  }

  private async handleDeleteConfirmation(message: OwnerDirectMessage, actionId: string): Promise<void> {
    const pending = this.options.stateRepository.consumePendingAction({
      id: actionId,
      now: this.now(),
      ownerId: this.options.ownerId,
    });
    if (!pending || !isPendingCalendarManagementAction(pending.payload) || pending.payload.kind !== "calendar_delete_confirmation") {
      await message.reply("That confirmation is invalid or has expired.");
      return;
    }
    try {
      const started = await this.options.service.startCalendarDeletion({
        destinationCalendarId: pending.payload.destinationCalendarId,
        sourceCalendarId: pending.payload.sourceCalendarId,
      });
      const result = await this.options.service.runCalendarDeletion(started.job.id);
      await message.reply(migrationReply(result));
    } catch (error: unknown) {
      await this.fail(message, error, "I could not start that calendar migration.");
    }
  }

  private async resumeMigration(message: OwnerDirectMessage, jobId: string): Promise<void> {
    try {
      const result = await this.options.service.resumeCalendarDeletion(jobId);
      await message.reply(migrationReply(result));
    } catch (error: unknown) {
      await this.fail(message, error, "I could not resume that calendar migration.");
    }
  }

  private async resolveCalendar(name: string) {
    const normalized = name.trim().toLocaleLowerCase();
    const calendars = await this.options.service.listCalendars();
    const matches = calendars.filter((calendar) =>
      [calendar.summary, calendar.summaryOverride].filter(Boolean).some((candidate) => candidate?.trim().toLocaleLowerCase() === normalized),
    );
    if (matches.length !== 1) {
      throw new CalendarManagementError(matches.length === 0
        ? `I could not find a calendar named ${name}.`
        : `More than one calendar matches ${name}. Use its exact Google calendar name.`);
    }
    const match = matches[0];
    if (!match) {
      throw new CalendarManagementError(`I could not find a calendar named ${name}.`);
    }
    return match;
  }

  private async fail(message: OwnerDirectMessage, error: unknown, fallback: string): Promise<void> {
    this.options.logger?.error({ error }, "Discord calendar management command failed");
    await message.reply(error instanceof CalendarManagementError ? error.message : fallback);
  }
}

function migrationReply(status: { readonly job: CalendarMigrationStatus["job"] }): string {
  if (status.job.status === "completed") {
    return `Deleted ${status.job.sourceCalendarName} after moving its supported events to ${status.job.destinationCalendarName}.`;
  }
  return `Migration ${status.job.status}: ${status.job.failureReason ?? "the source calendar was kept and can be resumed"}. Job ${status.job.id}.`;
}
