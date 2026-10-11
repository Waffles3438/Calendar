import { describe, expect, it, vi } from "vitest";

import type { CalendarManagementAssistant } from "../src/application/calendar-management-assistant.js";
import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { PendingAction } from "../src/persistence/state-repository.js";

const ownerId = "123456789012345678";
const otherOwnerId = "987654321098765432";

function message(content: string, authorId = ownerId): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId,
    content,
    id: "calendar-management-router-message",
    replies,
    reply: async (reply) => {
      replies.push(reply);
    },
  };
}

function managementAssistant(overrides: Record<string, unknown> = {}): CalendarManagementAssistant {
  return {
    canHandlePendingAction: vi.fn(() => false),
    handle: vi.fn(async () => undefined),
    handlePendingAction: vi.fn(async () => false),
    ...overrides,
  } as unknown as CalendarManagementAssistant;
}

function pendingAction(payload: unknown): PendingAction {
  const now = new Date("2026-08-23T12:00:00.000Z");
  return {
    createdAt: now,
    expiresAt: new Date(now.valueOf() + 60_000),
    id: "deadbeef",
    ownerId,
    payload,
  };
}

describe("OwnerCommandRouter calendar-management routing", () => {
  it("routes calendar-management commands before NLP and legacy Calendar handlers", async () => {
    const management = managementAssistant();
    const planner = { plan: vi.fn(async () => undefined) };
    const calendar = { handle: vi.fn(async () => undefined) };
    const router = new OwnerCommandRouter({
      calendarAssistant: calendar,
      calendarManagementAssistant: management,
      naturalLanguagePlanner: planner,
      ownerId,
      scheduleAssistant: { handle: vi.fn(async () => false) },
      stateRepository: {},
    });
    const input = message("add calendar classes");

    await router.handle(input);

    expect(management.handle).toHaveBeenCalledWith(expect.objectContaining({ content: input.content }));
    expect(planner.plan).not.toHaveBeenCalled();
    expect(calendar.handle).not.toHaveBeenCalled();
    expect(input.replies).toEqual([]);
  });

  it("routes pending calendar actions before every ordinary handler", async () => {
    const management = managementAssistant({
      canHandlePendingAction: vi.fn(() => true),
      handlePendingAction: vi.fn(async () => true),
    });
    const planner = { plan: vi.fn(async () => undefined) };
    const schedule = {
      canHandlePendingAction: vi.fn(() => false),
      handle: vi.fn(async () => false),
      handlePendingAction: vi.fn(async () => false),
    };
    const calendar = { handle: vi.fn(async () => undefined) };
    const getPendingAction = vi.fn(() => pendingAction({
      destinationCalendarIds: ["destination-id"],
      kind: "calendar_delete_selection",
      sourceCalendarId: "source-id",
      sourceCalendarName: "Source",
    }));
    const router = new OwnerCommandRouter({
      calendarAssistant: calendar,
      calendarManagementAssistant: management,
      naturalLanguagePlanner: planner,
      ownerId,
      scheduleAssistant: schedule,
      stateRepository: { getPendingAction },
    });
    const input = message("choose deadbeef 1");

    await router.handle(input);

    expect(getPendingAction).toHaveBeenCalledWith({
      id: "deadbeef",
      now: expect.any(Date),
      ownerId,
    });
    expect(management.handlePendingAction).toHaveBeenCalledWith(
      expect.objectContaining({ content: input.content }),
      { actionId: "deadbeef", choice: 1, kind: "choose" },
    );
    expect(planner.plan).not.toHaveBeenCalled();
    expect(schedule.handle).not.toHaveBeenCalled();
    expect(calendar.handle).not.toHaveBeenCalled();
  });

  it("rejects unauthorized direct calls without reading state or replying", async () => {
    const management = managementAssistant();
    const getPendingAction = vi.fn();
    const router = new OwnerCommandRouter({
      calendarManagementAssistant: management,
      ownerId,
      stateRepository: { getPendingAction },
    });
    const input = message("calendars", otherOwnerId);

    await router.handle(input);

    expect(getPendingAction).not.toHaveBeenCalled();
    expect(management.handle).not.toHaveBeenCalled();
    expect(input.replies).toEqual([]);
  });

  it("fails closed when management syntax is used without the management assistant", async () => {
    const planner = { plan: vi.fn(async () => undefined) };
    const calendar = { handle: vi.fn(async () => undefined) };
    const router = new OwnerCommandRouter({
      calendarAssistant: calendar,
      naturalLanguagePlanner: planner,
      ownerId,
      stateRepository: {},
    });
    const input = message("delete calendar Source");

    await router.handle(input);

    expect(input.replies).toEqual(["Google Calendar management is not configured for this bot."]);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(calendar.handle).not.toHaveBeenCalled();
  });
});
