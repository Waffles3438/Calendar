import { describe, expect, it, vi } from "vitest";

import {
  CalendarManagementAssistant,
} from "../src/application/calendar-management-assistant.js";
import type {
  CalendarManagementService,
  CalendarMigrationStatus,
} from "../src/application/calendar-management-service.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { ManagedCalendar } from "../src/domain/calendar-management.js";
import type {
  CalendarMigrationJobStatus,
  PendingAction,
} from "../src/persistence/state-repository.js";

const ownerId = "123456789012345678";
const otherOwnerId = "987654321098765432";
const now = new Date("2026-08-23T12:00:00.000Z");
let messageNumber = 0;

function message(content: string, authorId = ownerId): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  messageNumber += 1;
  return {
    authorId,
    content,
    id: `calendar-management-${messageNumber}`,
    replies,
    reply: async (reply) => {
      replies.push(reply);
    },
  };
}

function calendar(id: string, overrides: Partial<ManagedCalendar> = {}): ManagedCalendar {
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

function migrationStatus(status: CalendarManagementStatus, id = "job-1"): CalendarMigrationStatus {
  return {
    events: [],
    job: {
      ...(status === "completed" ? { completedAt: now } : {}),
      createdAt: now,
      destinationCalendarId: "destination-id",
      destinationCalendarName: "Destination",
      id,
      ownerId,
      sourceCalendarId: "source-id",
      sourceCalendarName: "Source",
      status,
      updatedAt: now,
    },
  };
}

type CalendarManagementStatus = CalendarMigrationJobStatus;

type PendingInput = {
  readonly expiresAt: Date;
  readonly id: string;
  readonly ownerId: string;
  readonly payload: unknown;
};

function pendingState() {
  const pending = new Map<string, PendingAction>();
  const createPendingAction = vi.fn((input: PendingInput) => {
    pending.set(input.id, {
      createdAt: now,
      expiresAt: input.expiresAt,
      id: input.id,
      ownerId: input.ownerId,
      payload: input.payload,
    });
  });
  const getPendingAction = vi.fn((input: { id: string; now: Date; ownerId: string }) => {
    const action = pending.get(input.id);
    if (!action || action.ownerId !== input.ownerId || action.expiresAt <= input.now) {
      return undefined;
    }
    return action;
  });
  const consumePendingAction = vi.fn((input: { id: string; now: Date; ownerId: string }) => {
    const action = getPendingAction(input);
    if (!action) {
      return undefined;
    }
    pending.delete(input.id);
    return action;
  });
  return {
    consumePendingAction,
    createPendingAction,
    getPendingAction,
    pending,
    state: { consumePendingAction, createPendingAction, getPendingAction },
  };
}

function fakeService() {
  return {
    createCalendar: vi.fn(),
    listCalendars: vi.fn(),
    previewCalendarDeletion: vi.fn(),
    resumeCalendarDeletion: vi.fn(),
    runCalendarDeletion: vi.fn(),
    setCalendarVisibility: vi.fn(),
    startCalendarDeletion: vi.fn(),
    updateCalendar: vi.fn(),
  };
}

function assistant(
  service: ReturnType<typeof fakeService>,
  state: ReturnType<typeof pendingState>,
): CalendarManagementAssistant {
  return new CalendarManagementAssistant({
    now: () => now,
    ownerId,
    service: service as unknown as CalendarManagementService,
    stateRepository: state.state,
  });
}

describe("CalendarManagementAssistant", () => {
  it("lists calendars with selection, visibility, capability, and color details", async () => {
    const service = fakeService();
    const state = pendingState();
    service.listCalendars.mockResolvedValue([
      calendar("primary", { isPrimary: true, summary: "Benny Wang" }),
      calendar("hidden", { hidden: true, selected: false, summary: "Hidden" }),
      calendar("read-only", { canManageEvents: false, readOnly: true, summary: "Read only" }),
    ]);
    const instance = assistant(service, state);
    const request = message("calendars");

    await instance.handle(request);

    expect(request.replies).toHaveLength(1);
    expect(request.replies[0]).toContain("1. ☑ Benny Wang (primary) #4EA7D7");
    expect(request.replies[0]).toContain("2. ☐ Hidden (hidden) #4EA7D7");
    expect(request.replies[0]).toContain("3. ☑ Read only (read-only) #4EA7D7");
  });

  it("delegates template creation, editing, and visibility commands deterministically", async () => {
    const service = fakeService();
    const state = pendingState();
    service.createCalendar.mockResolvedValue(calendar("created", { summary: "Coursework" }));
    service.listCalendars.mockResolvedValue([calendar("existing", { summary: "Original" })]);
    service.updateCalendar.mockResolvedValue(calendar("existing", { summary: "Renamed" }));
    service.setCalendarVisibility.mockResolvedValue(calendar("existing", { hidden: true, selected: false, summary: "Renamed" }));
    const instance = assistant(service, state);

    const createRequest = message("add calendar classes name Coursework color #abcdef description Course schedule");
    await instance.handle(createRequest);
    expect(service.createCalendar).toHaveBeenCalledWith({
      color: "#abcdef",
      description: "Course schedule",
      name: "Coursework",
      templateId: "classes",
    });
    expect(createRequest.replies).toEqual(["Created calendar Coursework."]);

    const defaultCreateRequest = message("create calendar");
    await instance.handle(defaultCreateRequest);
    expect(service.createCalendar).toHaveBeenLastCalledWith({});

    const editRequest = message("edit calendar Original name Renamed color #ffffff description Updated description");
    await instance.handle(editRequest);
    expect(service.updateCalendar).toHaveBeenCalledWith("existing", {
      color: "#ffffff",
      description: "Updated description",
      name: "Renamed",
    });
    expect(editRequest.replies).toEqual(["Updated calendar Renamed."]);

    service.listCalendars.mockResolvedValue([calendar("existing", { summary: "Renamed" })]);
    const hideRequest = message("hide calendar Renamed");
    await instance.handle(hideRequest);
    expect(service.setCalendarVisibility).toHaveBeenCalledWith("existing", { hidden: true, selected: false });
    expect(hideRequest.replies).toEqual(["Renamed is now hidden."]);
  });

  it("returns safe failure replies for list and creation errors", async () => {
    const service = fakeService();
    const state = pendingState();
    const instance = assistant(service, state);

    service.listCalendars.mockRejectedValueOnce(new Error("provider unavailable"));
    const listRequest = message("list calendars");
    await instance.handle(listRequest);
    expect(listRequest.replies).toEqual(["I could not list the Google calendars."]);

    service.createCalendar.mockRejectedValueOnce(new Error("provider unavailable"));
    const createRequest = message("add calendar");
    await instance.handle(createRequest);
    expect(createRequest.replies).toEqual(["I could not create that calendar."]);
  });

  it("requires destination selection before confirmation and then runs the migration", async () => {
    const service = fakeService();
    const state = pendingState();
    const source = calendar("source-id", { summary: "Source" });
    const destination = calendar("destination-id", { summary: "Destination" });
    service.listCalendars.mockResolvedValue([source, destination]);
    service.previewCalendarDeletion.mockResolvedValue({ destinations: [destination], source });
    service.startCalendarDeletion.mockResolvedValue(migrationStatus("pending"));
    service.runCalendarDeletion.mockResolvedValue(migrationStatus("completed"));
    const instance = assistant(service, state);

    const deleteRequest = message("delete calendar Source");
    await instance.handle(deleteRequest);

    expect(service.previewCalendarDeletion).toHaveBeenCalledWith("source-id");
    expect(state.createPendingAction).toHaveBeenCalledTimes(1);
    const selectionId = state.createPendingAction.mock.calls[0]?.[0].id;
    if (!selectionId) {
      throw new Error("Selection action was not persisted");
    }
    expect(deleteRequest.replies[0]).toContain(selectionId);
    expect(state.pending.get(selectionId ?? "")?.payload).toEqual({
      destinationCalendarIds: ["destination-id"],
      kind: "calendar_delete_selection",
      sourceCalendarId: "source-id",
      sourceCalendarName: "Source",
    });
    expect(deleteRequest.replies[0]).not.toContain("destination-id");

    const invalidChoice = message(`choose ${selectionId} 2`);
    await instance.handlePendingAction(invalidChoice, { actionId: selectionId, choice: 2, kind: "choose" });
    expect(invalidChoice.replies).toEqual(["That destination number is not available. Choose a number from the list."]);
    expect(state.pending.has(selectionId)).toBe(true);

    const selection = message(`choose ${selectionId} 1`);
    await instance.handlePendingAction(selection, { actionId: selectionId, choice: 1, kind: "choose" });
    const confirmationId = state.createPendingAction.mock.calls[1]?.[0].id;
    if (!confirmationId) {
      throw new Error("Confirmation action was not persisted");
    }
    expect(selection.replies[0]).toContain(confirmationId);
    expect(state.pending.has(selectionId)).toBe(false);
    expect(state.pending.get(confirmationId)?.payload).toEqual({
      destinationCalendarId: "destination-id",
      destinationCalendarName: "Destination",
      kind: "calendar_delete_confirmation",
      sourceCalendarId: "source-id",
      sourceCalendarName: "Source",
    });

    const confirmation = message(`confirm ${confirmationId}`);
    await instance.handlePendingAction(confirmation, { actionId: confirmationId, kind: "confirm" });
    expect(service.startCalendarDeletion).toHaveBeenCalledWith({
      destinationCalendarId: "destination-id",
      sourceCalendarId: "source-id",
    });
    expect(service.runCalendarDeletion).toHaveBeenCalledWith("job-1");
    expect(confirmation.replies).toEqual(["Deleted Source after moving its supported events to Destination."]);
  });

  it("preserves a pending selection on provider failure and rejects stale destinations", async () => {
    const service = fakeService();
    const state = pendingState();
    const instance = assistant(service, state);
    state.pending.set("selection-failure", {
      createdAt: now,
      expiresAt: new Date(now.valueOf() + 60_000),
      id: "selection-failure",
      ownerId,
      payload: {
        destinationCalendarIds: ["destination-id"],
        kind: "calendar_delete_selection",
        sourceCalendarId: "source-id",
        sourceCalendarName: "Source",
      },
    });
    service.listCalendars.mockRejectedValueOnce(new Error("provider unavailable"));

    const providerFailure = message("choose selection-failure 1");
    await instance.handlePendingAction(providerFailure, {
      actionId: "selection-failure",
      choice: 1,
      kind: "choose",
    });
    expect(providerFailure.replies).toEqual(["I could not verify that destination calendar. Please try again."]);
    expect(state.pending.has("selection-failure")).toBe(true);

    service.listCalendars.mockResolvedValueOnce([calendar("destination-id", { hidden: true })]);
    const staleDestination = message("choose selection-failure 1");
    await instance.handlePendingAction(staleDestination, {
      actionId: "selection-failure",
      choice: 1,
      kind: "choose",
    });
    expect(staleDestination.replies).toEqual(["That destination calendar is no longer available. Please start the deletion again."]);
    expect(state.pending.has("selection-failure")).toBe(true);
  });

  it("cancels pending actions, resumes migrations, and ignores unauthorized callers", async () => {
    const service = fakeService();
    const state = pendingState();
    service.resumeCalendarDeletion.mockResolvedValue(migrationStatus("failed", "job-2"));
    const instance = assistant(service, state);
    state.pending.set("cancel-me", {
      createdAt: now,
      expiresAt: new Date(now.valueOf() + 60_000),
      id: "cancel-me",
      ownerId,
      payload: {
        destinationCalendarIds: ["destination-id"],
        kind: "calendar_delete_selection",
        sourceCalendarId: "source-id",
        sourceCalendarName: "Source",
      },
    });

    const cancel = message("cancel cancel-me");
    await instance.handlePendingAction(cancel, { actionId: "cancel-me", kind: "cancel" });
    expect(cancel.replies).toEqual(["Cancelled. No calendar change was made."]);
    expect(state.pending.has("cancel-me")).toBe(false);
    expect(service.startCalendarDeletion).not.toHaveBeenCalled();

    const resume = message("resume calendar migration deadbeef");
    await instance.handle(resume);
    expect(service.resumeCalendarDeletion).toHaveBeenCalledWith("deadbeef");
    expect(resume.replies[0]).toContain("Migration failed:");
    expect(resume.replies[0]).toContain("job-2");

    const unauthorized = message("calendars", otherOwnerId);
    await instance.handle(unauthorized);
    expect(unauthorized.replies).toEqual([]);
    expect(service.listCalendars).not.toHaveBeenCalled();
  });
});
