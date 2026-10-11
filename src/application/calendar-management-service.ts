import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  calendarCapabilities,
  getCalendarTemplate,
  listCalendarTemplates,
  normalizeCalendarColor,
  normalizeCalendarDescription,
  normalizeCalendarName,
  resolveCalendarCreationDetails,
  type CalendarListSettingsPatch,
  type CalendarMetadataPatch,
  type CalendarTemplate,
  type CalendarTemplateInput,
  type ManagedCalendar,
} from "../domain/calendar-management.js";
import type {
  CalendarManagementGateway,
  CalendarMigrationEvent,
  CreateManagedCalendarInput,
  UpdateManagedCalendarInput,
} from "../google/calendar-api.js";
import type {
  CalendarMigrationEventRecord,
  CalendarMigrationJob,
  CalendarMigrationJobStatus,
} from "../persistence/state-repository.js";

export interface CalendarManagementStateRepository {
  createCalendarMigrationJob(input: {
    destinationCalendarId: string;
    destinationCalendarName: string;
    id: string;
    now: Date;
    ownerId: string;
    sourceCalendarId: string;
    sourceCalendarName: string;
  }): void;
  getCalendarMigrationJob(input: { id: string; ownerId: string }): CalendarMigrationJob | undefined;
  listCalendarMigrationEvents(input: { jobId: string }): readonly CalendarMigrationEventRecord[];
  recordAudit(input: {
    actionType: string;
    actorId: string;
    details?: Record<string, unknown>;
    status: "failed" | "succeeded";
  }): void;
  remapReminderReferences(input: {
    destinationCalendarId: string;
    destinationEventId: string;
    sourceCalendarId: string;
    sourceEventId: string;
  }): void;
  updateCalendarMigrationJob(input: {
    completedAt?: Date;
    failureReason?: string;
    id: string;
    now: Date;
    ownerId: string;
    status: CalendarMigrationJobStatus;
  }): void;
  upsertCalendarMigrationEvent(input: {
    destinationEventId?: string;
    failureReason?: string;
    jobId: string;
    now: Date;
    sourceEventId: string;
    status: "failed" | "moved" | "pending" | "unsupported";
  }): void;
}

export interface CalendarManagementServiceOptions {
  readonly gateway: CalendarManagementGateway;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly onCalendarStateChanged?: () => void;
  readonly ownerId: string;
  readonly stateRepository: CalendarManagementStateRepository;
  readonly timeZone?: string;
}

export interface CalendarDeletionPreview {
  readonly destinations: readonly ManagedCalendar[];
  readonly source: ManagedCalendar;
}

export interface CalendarMigrationStatus {
  readonly events: readonly CalendarMigrationEventRecord[];
  readonly job: CalendarMigrationJob;
}

export class CalendarManagementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CalendarManagementError";
  }
}

const MOVABLE_EVENT_TYPES = new Set(["default", ""]);

export class CalendarManagementService {
  private readonly now: () => Date;

  public constructor(private readonly options: CalendarManagementServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public listTemplates(): readonly CalendarTemplate[] {
    return listCalendarTemplates();
  }

  public async listCalendars(): Promise<readonly ManagedCalendar[]> {
    const calendars = await this.options.gateway.listManagedCalendars();
    return [...calendars].sort((first, second) => {
      if (first.isPrimary !== second.isPrimary) {
        return first.isPrimary ? -1 : 1;
      }
      return first.summary.localeCompare(second.summary, undefined, { sensitivity: "base" }) ||
        first.id.localeCompare(second.id);
    });
  }

  public async createCalendar(input: CalendarTemplateInput = {}): Promise<ManagedCalendar> {
    const details = resolveCalendarCreationDetails(input);
    const request: CreateManagedCalendarInput = {
      backgroundColor: details.backgroundColor,
      description: details.description,
      foregroundColor: details.foregroundColor,
      name: details.name,
      ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
    };
    try {
      const created = await this.options.gateway.createManagedCalendar(request);
      this.audit("calendar_create", {
        calendarId: created.id,
        name: created.summary,
        templateId: details.templateId,
      }, "succeeded");
      this.options.onCalendarStateChanged?.();
      return created;
    } catch (error: unknown) {
      this.audit("calendar_create", { name: details.name, templateId: details.templateId }, "failed");
      throw error;
    }
  }

  public async updateCalendar(
    calendarId: string,
    input: { readonly color?: string; readonly description?: string; readonly name?: string },
  ): Promise<ManagedCalendar> {
    const calendar = await this.requireCalendar(calendarId);
    this.requireMetadataAccess(calendar);
    const metadata: CalendarMetadataPatch = {
      ...(input.description !== undefined ? { description: normalizeCalendarDescription(input.description) } : {}),
      ...(input.name !== undefined ? { name: normalizeCalendarName(input.name) } : {}),
    };
    const listSettings: CalendarListSettingsPatch = input.color
      ? (() => {
        const backgroundColor = normalizeCalendarColor(input.color);
        return { backgroundColor, foregroundColor: foregroundColorForSafe(backgroundColor) };
      })()
      : {};
    if (Object.keys(metadata).length === 0 && Object.keys(listSettings).length === 0) {
      throw new CalendarManagementError("At least one calendar field must be provided");
    }

    const request: UpdateManagedCalendarInput = {
      calendarId,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(Object.keys(listSettings).length > 0 ? { listSettings } : {}),
    };
    try {
      const updated = await this.options.gateway.updateManagedCalendar(request);
      this.audit("calendar_update", { calendarId }, "succeeded");
      this.options.onCalendarStateChanged?.();
      return updated;
    } catch (error: unknown) {
      this.audit("calendar_update", { calendarId }, "failed");
      throw error;
    }
  }

  public async setCalendarVisibility(
    calendarId: string,
    input: { readonly hidden?: boolean; readonly selected?: boolean },
  ): Promise<ManagedCalendar> {
    const calendar = await this.requireCalendar(calendarId);
    this.requireMetadataAccess(calendar);
    if (input.hidden === undefined && input.selected === undefined) {
      throw new CalendarManagementError("A visibility value must be provided");
    }
    const updated = await this.options.gateway.updateManagedCalendar({
      calendarId,
      listSettings: input,
    });
    this.audit("calendar_visibility_update", { calendarId, ...input }, "succeeded");
    this.options.onCalendarStateChanged?.();
    return updated;
  }

  public async previewCalendarDeletion(calendarId: string): Promise<CalendarDeletionPreview> {
    const calendars = await this.listCalendars();
    const source = this.findCalendar(calendars, calendarId);
    this.requireDeletable(source);
    const destinations = calendars.filter((candidate) =>
      candidate.id !== source.id && candidate.canManageEvents && !candidate.hidden,
    );
    if (destinations.length === 0) {
      throw new CalendarManagementError("No writable destination calendar is available");
    }
    return { destinations, source };
  }

  public async startCalendarDeletion(input: {
    destinationCalendarId: string;
    sourceCalendarId: string;
  }): Promise<CalendarMigrationStatus> {
    const preview = await this.previewCalendarDeletion(input.sourceCalendarId);
    const destination = preview.destinations.find((candidate) => candidate.id === input.destinationCalendarId);
    if (!destination) {
      throw new CalendarManagementError("Select one of the available destination calendars");
    }
    const jobId = randomUUID();
    const now = this.now();
    this.options.stateRepository.createCalendarMigrationJob({
      destinationCalendarId: destination.id,
      destinationCalendarName: destination.summary,
      id: jobId,
      now,
      ownerId: this.options.ownerId,
      sourceCalendarId: preview.source.id,
      sourceCalendarName: preview.source.summary,
    });
    this.audit("calendar_delete_migration_start", {
      destinationCalendarId: destination.id,
      jobId,
      sourceCalendarId: preview.source.id,
    }, "succeeded");
    return this.getMigrationStatus(jobId);
  }

  public async runCalendarDeletion(jobId: string): Promise<CalendarMigrationStatus> {
    const initial = this.requireMigration(jobId);
    if (initial.job.status === "completed" || initial.job.status === "cancelled") {
      return initial;
    }
    const now = this.now();
    this.options.stateRepository.updateCalendarMigrationJob({
      id: jobId,
      now,
      ownerId: this.options.ownerId,
      status: "running",
    });

    try {
      const calendars = await this.listCalendars();
      const source = this.findCalendar(calendars, initial.job.sourceCalendarId);
      const destination = this.findCalendar(calendars, initial.job.destinationCalendarId);
      this.requireDeletable(source);
      if (!destination.canManageEvents || destination.hidden || destination.id === source.id) {
        throw new CalendarManagementError("The selected destination calendar is no longer writable");
      }

      const existingRecords = new Map(
        this.options.stateRepository.listCalendarMigrationEvents({ jobId }).map((record) => [record.sourceEventId, record]),
      );
      const events = await this.options.gateway.listMigrationEvents({ calendarId: source.id });
      for (const event of events) {
        const prior = existingRecords.get(event.id);
        if (prior?.status === "moved") {
          continue;
        }
        if (!isMovableEvent(event)) {
          this.options.stateRepository.upsertCalendarMigrationEvent({
            failureReason: unsupportedEventReason(event),
            jobId,
            now: this.now(),
            sourceEventId: event.id,
            status: "unsupported",
          });
          throw new CalendarManagementError(`Event ${event.summary} cannot be moved safely`);
        }

        this.options.stateRepository.upsertCalendarMigrationEvent({
          jobId,
          now: this.now(),
          sourceEventId: event.id,
          status: "pending",
        });
        try {
          const moved = await this.options.gateway.moveCalendarEvent({
            destinationCalendarId: destination.id,
            eventId: event.id,
            sendUpdates: event.hasExternalGuests ? "all" : "none",
            sourceCalendarId: source.id,
          });
          this.options.stateRepository.remapReminderReferences({
            destinationCalendarId: destination.id,
            destinationEventId: moved.id,
            sourceCalendarId: source.id,
            sourceEventId: event.id,
          });
          this.options.stateRepository.upsertCalendarMigrationEvent({
            destinationEventId: moved.id,
            jobId,
            now: this.now(),
            sourceEventId: event.id,
            status: "moved",
          });
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : "Google rejected the event move";
          this.options.stateRepository.upsertCalendarMigrationEvent({
            failureReason: reason,
            jobId,
            now: this.now(),
            sourceEventId: event.id,
            status: "failed",
          });
          throw new CalendarManagementError(`Could not move ${event.summary}: ${reason}`);
        }
      }

      const remaining = await this.options.gateway.listMigrationEvents({ calendarId: source.id });
      if (remaining.length > 0) {
        throw new CalendarManagementError("The source calendar still contains events; it was not deleted");
      }
      const latestCalendars = await this.listCalendars();
      const latestSource = this.findCalendar(latestCalendars, source.id);
      this.requireDeletable(latestSource);
      await this.options.gateway.deleteManagedCalendar(latestSource.id);
      this.options.stateRepository.updateCalendarMigrationJob({
        completedAt: this.now(),
        id: jobId,
        now: this.now(),
        ownerId: this.options.ownerId,
        status: "completed",
      });
      this.audit("calendar_delete_migration", {
        destinationCalendarId: destination.id,
        jobId,
        sourceCalendarId: source.id,
      }, "succeeded");
      this.options.onCalendarStateChanged?.();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "Calendar migration failed";
      this.options.stateRepository.updateCalendarMigrationJob({
        failureReason: reason,
        id: jobId,
        now: this.now(),
        ownerId: this.options.ownerId,
        status: "failed",
      });
      this.audit("calendar_delete_migration", { jobId, reason }, "failed");
      this.options.logger?.error({ error, jobId }, "Calendar migration failed");
    }

    return this.getMigrationStatus(jobId);
  }

  public async resumeCalendarDeletion(jobId: string): Promise<CalendarMigrationStatus> {
    const status = this.requireMigration(jobId);
    if (status.job.status !== "failed" && status.job.status !== "pending") {
      return status;
    }
    return this.runCalendarDeletion(jobId);
  }

  public getMigrationStatus(jobId: string): CalendarMigrationStatus {
    return this.requireMigration(jobId);
  }

  private async requireCalendar(calendarId: string): Promise<ManagedCalendar> {
    const calendars = await this.listCalendars();
    return this.findCalendar(calendars, calendarId);
  }

  private findCalendar(calendars: readonly ManagedCalendar[], calendarId: string): ManagedCalendar {
    const calendar = calendars.find((candidate) => candidate.id === calendarId);
    if (!calendar) {
      throw new CalendarManagementError("The selected calendar is no longer accessible");
    }
    return calendar;
  }

  private requireMetadataAccess(calendar: ManagedCalendar): void {
    if (!calendar.canManageMetadata) {
      throw new CalendarManagementError(`The ${calendar.summary} calendar cannot have its settings changed`);
    }
  }

  private requireDeletable(calendar: ManagedCalendar): void {
    if (calendar.isPrimary) {
      throw new CalendarManagementError("The primary calendar cannot be deleted");
    }
    if (!calendar.canDelete) {
      throw new CalendarManagementError(`The ${calendar.summary} calendar cannot be deleted`);
    }
  }

  private requireMigration(jobId: string): CalendarMigrationStatus {
    const job = this.options.stateRepository.getCalendarMigrationJob({ id: jobId, ownerId: this.options.ownerId });
    if (!job) {
      throw new CalendarManagementError("That calendar migration does not exist or has expired");
    }
    return {
      events: this.options.stateRepository.listCalendarMigrationEvents({ jobId }),
      job,
    };
  }

  private audit(actionType: string, details: Record<string, unknown>, status: "failed" | "succeeded"): void {
    this.options.stateRepository.recordAudit({ actionType, actorId: this.options.ownerId, details, status });
  }
}

function isMovableEvent(event: CalendarMigrationEvent): boolean {
  return MOVABLE_EVENT_TYPES.has(event.eventType ?? "") && !event.locked && event.status !== "cancelled";
}

function unsupportedEventReason(event: CalendarMigrationEvent): string {
  if (event.locked) {
    return "The event is locked by Google Calendar";
  }
  if (event.eventType && event.eventType !== "default") {
    return `The ${event.eventType} event type cannot be moved`;
  }
  return "The event cannot be moved";
}

function foregroundColorForSafe(backgroundColor: string): string {
  const normalized = backgroundColor.slice(1);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * (linear[0] ?? 0)) + (0.7152 * (linear[1] ?? 0)) + (0.0722 * (linear[2] ?? 0));
  return luminance > 0.179 ? "#000000" : "#FFFFFF";
}
