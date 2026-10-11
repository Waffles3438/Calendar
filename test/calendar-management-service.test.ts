import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CalendarManagementService,
  type CalendarManagementStateRepository,
} from "../src/application/calendar-management-service.js";
import type {
  CalendarManagementGateway,
  CalendarMigrationEvent,
  CreateManagedCalendarInput,
  MoveCalendarEventInput,
  UpdateManagedCalendarInput,
} from "../src/google/calendar-api.js";
import type { ManagedCalendar } from "../src/domain/calendar-management.js";
import { AppStateRepository } from "../src/persistence/state-repository.js";

const ownerId = "123456789012345678";
const otherOwnerId = "987654321098765432";
const now = new Date("2026-08-23T12:00:00.000Z");

const openRepositories: AppStateRepository[] = [];

afterEach(() => {
  for (const repository of openRepositories.splice(0)) {
    repository.close();
  }
});

function managedCalendar(id: string, overrides: Partial<ManagedCalendar> = {}): ManagedCalendar {
  return {
    accessRole: "owner",
    backgroundColor: "#4EA7D7",
    canDelete: true,
    canManageEvents: true,
    canManageMetadata: true,
    foregroundColor: "#FFFFFF",
    hidden: false,
    id,
    isPrimary: false,
    readOnly: false,
    selected: true,
    summary: id,
    timeZone: "America/Toronto",
    ...overrides,
  };
}

function migrationEvent(id: string, overrides: Partial<CalendarMigrationEvent> = {}): CalendarMigrationEvent {
  return {
    calendarId: "source",
    etag: `etag-${id}`,
    eventType: "default",
    hasExternalGuests: false,
    id,
    locked: false,
    status: "confirmed",
    summary: id,
    ...overrides,
  };
}

class FakeCalendarManagementGateway implements CalendarManagementGateway {
  public calendars: ManagedCalendar[] = [];
  public migrationEvents: CalendarMigrationEvent[] = [];
  public readonly createdInputs: CreateManagedCalendarInput[] = [];
  public readonly updatedInputs: UpdateManagedCalendarInput[] = [];
  public readonly moveCalls: MoveCalendarEventInput[] = [];
  public readonly deletedCalendarIds: string[] = [];
  public listManagedCalls = 0;
  public failMoveEventId: string | undefined;
  public retainMovedEvents = false;
  public createdCalendar: ManagedCalendar | undefined;
  public updatedCalendar: ManagedCalendar | undefined;

  public async listManagedCalendars(): Promise<readonly ManagedCalendar[]> {
    this.listManagedCalls += 1;
    return [...this.calendars];
  }

  public async createManagedCalendar(input: CreateManagedCalendarInput): Promise<ManagedCalendar> {
    this.createdInputs.push(input);
    return this.createdCalendar ?? managedCalendar("created");
  }

  public async updateManagedCalendar(input: UpdateManagedCalendarInput): Promise<ManagedCalendar> {
    this.updatedInputs.push(input);
    return this.updatedCalendar ?? managedCalendar(input.calendarId);
  }

  public async deleteManagedCalendar(calendarId: string): Promise<void> {
    this.deletedCalendarIds.push(calendarId);
    this.calendars = this.calendars.filter((calendar) => calendar.id !== calendarId);
  }

  public async listMigrationEvents(input: { calendarId: string }): Promise<readonly CalendarMigrationEvent[]> {
    return this.migrationEvents.filter((event) => event.calendarId === input.calendarId);
  }

  public async moveCalendarEvent(input: MoveCalendarEventInput): Promise<CalendarMigrationEvent> {
    this.moveCalls.push(input);
    if (input.eventId === this.failMoveEventId) {
      throw new Error(`move failed for ${input.eventId}`);
    }
    const index = this.migrationEvents.findIndex((event) =>
      event.id === input.eventId && event.calendarId === input.sourceCalendarId,
    );
    const event = this.migrationEvents[index];
    if (!event) {
      throw new Error(`event ${input.eventId} was not found`);
    }
    if (!this.retainMovedEvents) {
      this.migrationEvents.splice(index, 1);
    }
    return {
      ...event,
      calendarId: input.destinationCalendarId,
      id: `moved-${event.id}`,
    };
  }
}

function createState(): {
  audits: Parameters<AppStateRepository["recordAudit"]>[0][];
  remaps: Parameters<AppStateRepository["remapReminderReferences"]>[0][];
  repository: AppStateRepository;
  state: CalendarManagementStateRepository;
} {
  const repository = new AppStateRepository({
    databasePath: ":memory:",
    encryptionSecret: "calendar-management-tests".repeat(3),
  });
  openRepositories.push(repository);
  const audits: Parameters<AppStateRepository["recordAudit"]>[0][] = [];
  const remaps: Parameters<AppStateRepository["remapReminderReferences"]>[0][] = [];
  const state: CalendarManagementStateRepository = {
    createCalendarMigrationJob: (input) => repository.createCalendarMigrationJob(input),
    getCalendarMigrationJob: (input) => repository.getCalendarMigrationJob(input),
    listCalendarMigrationEvents: (input) => repository.listCalendarMigrationEvents(input),
    recordAudit: (input) => {
      audits.push(input);
      repository.recordAudit(input);
    },
    remapReminderReferences: (input) => {
      remaps.push(input);
      repository.remapReminderReferences(input);
    },
    updateCalendarMigrationJob: (input) => repository.updateCalendarMigrationJob(input),
    upsertCalendarMigrationEvent: (input) => repository.upsertCalendarMigrationEvent(input),
  };
  return { audits, remaps, repository, state };
}

function createService(
  gateway: FakeCalendarManagementGateway,
  state: CalendarManagementStateRepository,
  onCalendarStateChanged = vi.fn(),
  serviceOwnerId = ownerId,
): CalendarManagementService {
  return new CalendarManagementService({
    gateway,
    now: () => now,
    onCalendarStateChanged,
    ownerId: serviceOwnerId,
    stateRepository: state,
    timeZone: "America/Toronto",
  });
}

describe("CalendarManagementService", () => {
  it("sorts calendars and only offers safe writable destinations", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [
      managedCalendar("source", { summary: "Source", canDelete: true }),
      managedCalendar("hidden-destination", { hidden: true, summary: "Hidden destination" }),
      managedCalendar("read-only", {
        accessRole: "reader",
        canDelete: false,
        canManageEvents: false,
        canManageMetadata: false,
        readOnly: true,
        summary: "Read only",
      }),
      managedCalendar("primary", {
        canDelete: false,
        isPrimary: true,
        summary: "Primary",
      }),
      managedCalendar("destination", { summary: "Destination" }),
    ];
    const { state } = createState();
    const service = createService(gateway, state);

    await expect(service.previewCalendarDeletion("primary")).rejects.toThrow(/primary calendar cannot be deleted/i);
    await expect(service.previewCalendarDeletion("read-only")).rejects.toThrow(/cannot be deleted/i);

    const listed = await service.listCalendars();
    expect(listed.map((calendar) => calendar.id)).toEqual([
      "primary",
      "destination",
      "hidden-destination",
      "read-only",
      "source",
    ]);

    const preview = await service.previewCalendarDeletion("source");
    expect(preview.destinations.map((calendar) => calendar.id)).toEqual(["primary", "destination"]);

    gateway.calendars = [
      managedCalendar("source", { summary: "Source", canDelete: true }),
      managedCalendar("hidden-destination", { hidden: true }),
      managedCalendar("read-only", {
        canDelete: false,
        canManageEvents: false,
        canManageMetadata: false,
        readOnly: true,
      }),
    ];
    await expect(service.previewCalendarDeletion("source")).rejects.toThrow(/no writable destination/i);
  });

  it("normalizes shared create, metadata, and visibility mutations and invalidates state", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [managedCalendar("owner-calendar", { summary: "Original" })];
    gateway.createdCalendar = managedCalendar("created", { summary: "Coursework" });
    gateway.updatedCalendar = managedCalendar("owner-calendar", { summary: "Renamed" });
    const { audits, state } = createState();
    const onCalendarStateChanged = vi.fn();
    const service = createService(gateway, state, onCalendarStateChanged);

    await expect(service.createCalendar({
      description: "Course schedule",
      name: "Coursework",
      templateId: "classes",
    })).resolves.toMatchObject({ id: "created", summary: "Coursework" });
    expect(gateway.createdInputs[0]).toMatchObject({
      backgroundColor: "#7770BA",
      description: "Course schedule",
      name: "Coursework",
      timeZone: "America/Toronto",
    });

    await expect(service.updateCalendar("owner-calendar", {
      color: "#FFFFFF",
      description: "Renamed description",
      name: "Renamed",
    })).resolves.toMatchObject({ id: "owner-calendar", summary: "Renamed" });
    expect(gateway.updatedInputs[0]).toEqual({
      calendarId: "owner-calendar",
      listSettings: { backgroundColor: "#FFFFFF", foregroundColor: "#000000" },
      metadata: { description: "Renamed description", name: "Renamed" },
    });

    await service.setCalendarVisibility("owner-calendar", { hidden: true, selected: false });
    expect(gateway.updatedInputs[1]).toEqual({
      calendarId: "owner-calendar",
      listSettings: { hidden: true, selected: false },
    });
    expect(onCalendarStateChanged).toHaveBeenCalledTimes(3);
    expect(audits.map((audit) => audit.actionType)).toEqual([
      "calendar_create",
      "calendar_update",
      "calendar_visibility_update",
    ]);
  });

  it("migrates supported events, remaps reminders, notifies guests, and deletes only after verification", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [
      managedCalendar("source", { summary: "Old calendar" }),
      managedCalendar("destination", { summary: "New calendar" }),
    ];
    gateway.migrationEvents = [
      migrationEvent("event-1", { summary: "Private event" }),
      migrationEvent("event-2", { hasExternalGuests: true, summary: "Guest event" }),
    ];
    const { audits, remaps, repository, state } = createState();
    const onCalendarStateChanged = vi.fn();
    const service = createService(gateway, state, onCalendarStateChanged);

    repository.setReminderOverride({
      calendarId: "source",
      eventId: "event-1",
      minutesBefore: 15,
    });
    repository.setReminderOverride({
      calendarId: "source",
      eventId: "event-1",
      minutesBefore: 30,
      occurrenceStart: "2026-08-24T13:00:00.000Z",
    });
    repository.recordReminderDelivery({
      deliveryKey: "source:event-1:2026-08-24T13:00:00.000Z:15",
      eventId: "event-1",
      scheduledFor: "2026-08-24T12:45:00.000Z",
    });
    repository.recordReminderDelivery({
      deliveryKey: "other-calendar:event-1:2026-08-24T13:00:00.000Z:15",
      eventId: "event-1",
      scheduledFor: "2026-08-24T12:45:00.000Z",
    });

    const started = await service.startCalendarDeletion({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });
    expect(started.job.status).toBe("pending");

    const result = await service.runCalendarDeletion(started.job.id);

    expect(result.job.status).toBe("completed");
    expect(result.job.sourceCalendarName).toBe("Old calendar");
    expect(result.job.destinationCalendarName).toBe("New calendar");
    expect(result.events).toEqual([
      expect.objectContaining({
        destinationEventId: "moved-event-1",
        sourceEventId: "event-1",
        status: "moved",
      }),
      expect.objectContaining({
        destinationEventId: "moved-event-2",
        sourceEventId: "event-2",
        status: "moved",
      }),
    ]);
    expect(gateway.moveCalls.map((call) => ({ eventId: call.eventId, sendUpdates: call.sendUpdates }))).toEqual([
      { eventId: "event-1", sendUpdates: "none" },
      { eventId: "event-2", sendUpdates: "all" },
    ]);
    expect(gateway.deletedCalendarIds).toEqual(["source"]);
    expect(remaps).toHaveLength(2);
    expect(onCalendarStateChanged).toHaveBeenCalledTimes(1);
    expect(audits.map((audit) => ({ actionType: audit.actionType, status: audit.status }))).toEqual([
      { actionType: "calendar_delete_migration_start", status: "succeeded" },
      { actionType: "calendar_delete_migration", status: "succeeded" },
    ]);

    expect(repository.getReminderOverride({ calendarId: "source", eventId: "event-1" })).toBeUndefined();
    expect(repository.getReminderOverride({ calendarId: "destination", eventId: "moved-event-1" })).toBe(15);
    expect(repository.getReminderOverride({
      calendarId: "destination",
      eventId: "moved-event-1",
      occurrenceStart: "2026-08-24T13:00:00.000Z",
    })).toBe(30);
    expect(repository.hasReminderDelivery("source:event-1:2026-08-24T13:00:00.000Z:15")).toBe(false);
    expect(repository.hasReminderDelivery("destination:moved-event-1:2026-08-24T13:00:00.000Z:15")).toBe(true);
    expect(repository.hasReminderDelivery("other-calendar:event-1:2026-08-24T13:00:00.000Z:15")).toBe(true);

    const listCallsAfterCompletion = gateway.listManagedCalls;
    await expect(service.runCalendarDeletion(started.job.id)).resolves.toMatchObject({
      job: { status: "completed" },
    });
    expect(gateway.listManagedCalls).toBe(listCallsAfterCompletion);
  });

  it("records unsupported events and never deletes the source calendar", async () => {
    const cases: readonly {
      readonly event: CalendarMigrationEvent;
      readonly reason: RegExp;
    }[] = [
        { event: migrationEvent("locked", { locked: true }), reason: /locked by Google/i },
        { event: migrationEvent("focus-time", { eventType: "focusTime" }), reason: /focusTime event type/i },
        { event: migrationEvent("cancelled", { status: "cancelled" }), reason: /cannot be moved/i },
      ];

    for (const testCase of cases) {
      const gateway = new FakeCalendarManagementGateway();
      gateway.calendars = [managedCalendar("source"), managedCalendar("destination")];
      gateway.migrationEvents = [testCase.event];
      const { state } = createState();
      const service = createService(gateway, state);
      const started = await service.startCalendarDeletion({
        destinationCalendarId: "destination",
        sourceCalendarId: "source",
      });

      const result = await service.runCalendarDeletion(started.job.id);

      expect(result.job.status).toBe("failed");
      expect(result.job.failureReason).toMatch(/cannot be moved safely/i);
      expect(result.events).toEqual([
        expect.objectContaining({
          failureReason: expect.stringMatching(testCase.reason),
          sourceEventId: testCase.event.id,
          status: "unsupported",
        }),
      ]);
      expect(gateway.moveCalls).toHaveLength(0);
      expect(gateway.deletedCalendarIds).toHaveLength(0);
    }
  });

  it("keeps the source calendar after a move failure and resumes only unfinished events", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [managedCalendar("source"), managedCalendar("destination")];
    gateway.migrationEvents = [
      migrationEvent("event-1"),
      migrationEvent("event-2", { hasExternalGuests: true }),
    ];
    gateway.failMoveEventId = "event-2";
    const { audits, state } = createState();
    const service = createService(gateway, state);
    const started = await service.startCalendarDeletion({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });

    const failed = await service.runCalendarDeletion(started.job.id);
    expect(failed.job.status).toBe("failed");
    expect(gateway.deletedCalendarIds).toHaveLength(0);
    expect(failed.events).toEqual([
      expect.objectContaining({ sourceEventId: "event-1", status: "moved" }),
      expect.objectContaining({ sourceEventId: "event-2", status: "failed" }),
    ]);

    gateway.failMoveEventId = undefined;
    const resumed = await service.resumeCalendarDeletion(started.job.id);

    expect(resumed.job.status).toBe("completed");
    expect(gateway.moveCalls.map((call) => call.eventId)).toEqual(["event-1", "event-2", "event-2"]);
    expect(gateway.deletedCalendarIds).toEqual(["source"]);
    expect(audits.filter((audit) => audit.actionType === "calendar_delete_migration").map((audit) => audit.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("does not delete when the source still contains events after the move phase", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [managedCalendar("source"), managedCalendar("destination")];
    gateway.migrationEvents = [migrationEvent("event-1")];
    gateway.retainMovedEvents = true;
    const { state } = createState();
    const service = createService(gateway, state);
    const started = await service.startCalendarDeletion({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });

    const result = await service.runCalendarDeletion(started.job.id);

    expect(result.job.status).toBe("failed");
    expect(result.job.failureReason).toMatch(/still contains events/i);
    expect(gateway.deletedCalendarIds).toHaveLength(0);
  });

  it("revalidates the destination after confirmation and rejects a destination hidden meanwhile", async () => {
    const gateway = new FakeCalendarManagementGateway();
    const destination = managedCalendar("destination");
    gateway.calendars = [managedCalendar("source"), destination];
    const { state } = createState();
    const service = createService(gateway, state);
    const started = await service.startCalendarDeletion({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });
    gateway.calendars = [managedCalendar("source"), { ...destination, hidden: true }];

    const result = await service.runCalendarDeletion(started.job.id);

    expect(result.job.status).toBe("failed");
    expect(result.job.failureReason).toMatch(/no longer writable/i);
    expect(gateway.moveCalls).toHaveLength(0);
    expect(gateway.deletedCalendarIds).toHaveLength(0);
  });

  it("binds migration status to the owner", async () => {
    const gateway = new FakeCalendarManagementGateway();
    gateway.calendars = [managedCalendar("source"), managedCalendar("destination")];
    const { state } = createState();
    const service = createService(gateway, state);
    const started = await service.startCalendarDeletion({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });
    const otherOwnerService = createService(gateway, state, vi.fn(), otherOwnerId);

    expect(() => otherOwnerService.getMigrationStatus(started.job.id)).toThrow(/does not exist or has expired/i);
  });
});
