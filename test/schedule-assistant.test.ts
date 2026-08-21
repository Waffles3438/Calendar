import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { CalendarGateway } from "../src/google/calendar-api.js";
import { ScheduleAssistant, type SchedulePendingStateRepository } from "../src/scheduling/schedule-assistant.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: randomUUID(),
    replies,
    reply: async (response) => { replies.push(response); },
  };
}

function confirmationId(reply: string): string {
  const id = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
  if (!id) {
    throw new Error(`Expected confirmation id in: ${reply}`);
  }
  return id;
}

const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;

function fakeGateway(): CalendarGateway {
  const event = {
    attendees: [],
    calendarId: "team",
    end: { dateTime: "2026-08-18T15:00:00.000-04:00", kind: "timed" as const, timeZone },
    etag: "event-etag",
    id: "event-1",
    start: { dateTime: "2026-08-18T14:00:00.000-04:00", kind: "timed" as const, timeZone },
    status: "confirmed" as const,
    summary: "Planning meeting",
  };
  return {
    createEvent: async (input) => ({ ...event, ...input, id: "created" }),
    deleteEvent: async () => undefined,
    getEvent: async () => event,
    listCalendars: async () => [
      { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone },
      { id: "team", isPrimary: false, readOnly: false, summary: "Team", timeZone },
    ],
    listEvents: async ({ calendarId }) => calendarId === "team" ? [event] : [],
    splitRecurringEvent: async () => event,
    truncateRecurringEvent: async () => undefined,
    updateEvent: async () => event,
  };
}

describe("ScheduleAssistant agenda routing", () => {
  it("handles the exact today agenda phrase deterministically without invoking Gemini", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    schedules.createScheduledItem({
      id: "task-1",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-18",
      timeZone,
      title: "Buy cheese",
    });
    schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T13:00:00.000Z"),
      id: "reminder-1",
      kind: "reminder",
      now,
      ownerId,
      scheduledDate: "2026-08-18",
      timeZone,
      title: "Call dentist",
    });
    const pending = new Map<string, unknown>();
    const assistant = new ScheduleAssistant({
      calendarGateway: fakeGateway(),
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: {
        consumePendingAction: ({ id }) => {
          const payload = pending.get(id);
          pending.delete(id);
          return payload ? { payload } : undefined;
        },
        createPendingAction: ({ id, payload }) => pending.set(id, payload),
        getPendingAction: ({ id }) => {
          const payload = pending.get(id);
          return payload ? { payload } : undefined;
        },
      },
      timeZone,
    });
    const classifier = { classify: vi.fn() };
    const router = new OwnerCommandRouter({
      naturalLanguageClassifier: classifier,
      ownerId,
      scheduleAssistant: assistant,
      stateRepository: {},
      taskTimeZone: timeZone,
    });
    const input = message("What do i need to do today");

    await router.handle(input);

    const reply = input.replies.join("\n");
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(reply).toMatch(/Agenda for <t:\d+:D>:/u);
    expect(reply).toContain("Tasks:\n- Buy cheese");
    expect(reply).toMatch(/Events:\n- \[Team\] Planning meeting — <t:\d+:F>/u);
    expect(reply).toMatch(/Reminders:\n- Call dentist — <t:\d+:F>/u);
    expect(reply.indexOf("Tasks:")).toBeLessThan(reply.indexOf("Events:"));
    expect(reply.indexOf("Events:")).toBeLessThan(reply.indexOf("Reminders:"));
    schedules.close();
  });
});


describe("ScheduleAssistant Gemini response attribution", () => {
  it("labels a reply that accepts a Gemini schedule plan", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const pending = new Map<string, unknown>();
    const planner = {
      plan: vi.fn(async () => ({
        date: "2026-08-19",
        kind: "local" as const,
        scheduleKind: "task" as const,
        title: "Review report",
      })),
    };
    const scheduleAssistant = new ScheduleAssistant({
      commandPlanner: planner,
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: {
        consumePendingAction: ({ id }) => {
          const payload = pending.get(id);
          pending.delete(id);
          return payload ? { payload } : undefined;
        },
        createPendingAction: ({ id, payload }) => pending.set(id, payload),
        getPendingAction: ({ id }) => {
          const payload = pending.get(id);
          return payload ? { payload } : undefined;
        },
      },
      timeZone,
    });
    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant,
      stateRepository: {},
    });
    const input = message("Could you arrange a review report?");

    await router.handle(input);

    const replay = message(input.content);
    await router.handle(replay);

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(input.replies).toEqual([expect.stringMatching(/Created all-day task: Review report.* \[Gemini\]$/u)]);
    expect(replay.replies).toEqual([expect.stringMatching(/Created all-day task: Review report.* \[Gemini\]$/u)]);
    expect(schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    }).map((item) => item.title)).toEqual(["Review report", "Review report"]);
    schedules.close();
  });

  it("restores Gemini attribution for reviewed cleanup confirmations and cancellations", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const pending = new Map<string, unknown>();
    const pendingState = {
      consumePendingAction: ({ id }: { id: string }) => {
        const payload = pending.get(id);
        pending.delete(id);
        return payload === undefined ? undefined : { payload };
      },
      createPendingAction: ({ id, payload }: { id: string; payload: unknown }) => pending.set(id, payload),
      getPendingAction: ({ id }: { id: string }) => {
        const payload = pending.get(id);
        return payload === undefined
          ? undefined
          : {
            createdAt: now,
            expiresAt: new Date("2100-01-01T00:00:00.000Z"),
            id,
            ownerId,
            payload,
          };
      },
    };
    const planner = {
      plan: vi.fn(async () => ({
        kind: "cleanup" as const,
        mode: "bulk" as const,
        targetKinds: ["task"] as const,
        terms: [] as const,
        title: "all tasks",
      })),
    };
    const scheduleAssistant = new ScheduleAssistant({
      commandPlanner: planner,
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: pendingState,
      timeZone,
    });
    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant,
      stateRepository: pendingState,
    });
    const confirmedTask = schedules.createScheduledItem({
      id: "gemini-confirmed-task",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "Confirmed chore",
    });
    const firstRequest = message("Could you clean up my work queue?");

    await router.handle(firstRequest);
    const firstId = confirmationId(firstRequest.replies.join(" "));
    const confirmation = message(`confirm ${firstId}`);
    await router.handle(confirmation);

    expect(firstRequest.replies).toEqual([expect.stringMatching(/\[Gemini\]$/u)]);
    expect(confirmation.replies).toEqual(["Cancelled or deleted 1 scheduled item. [Gemini]"]);
    expect(schedules.getScheduledItem({ id: confirmedTask.id, ownerId })).toMatchObject({ status: "cancelled" });

    const cancelledTask = schedules.createScheduledItem({
      id: "gemini-cancelled-task",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "Cancelled chore",
    });
    const secondRequest = message("Could you clean up my work queue?");
    await router.handle(secondRequest);
    const secondId = confirmationId(secondRequest.replies.join(" "));
    const cancellation = message(`cancel ${secondId}`);
    await router.handle(cancellation);

    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(cancellation.replies).toEqual(["Cancelled. No scheduled items were changed. [Gemini]"]);
    expect(schedules.getScheduledItem({ id: cancelledTask.id, ownerId })).toMatchObject({ status: "active" });
    schedules.close();
  });

  it("treats legacy cleanup payloads without provenance as non-Gemini and rejects malformed provenance", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const pending = new Map<string, unknown>();
    const pendingState = {
      consumePendingAction: ({ id }: { id: string }) => {
        const payload = pending.get(id);
        pending.delete(id);
        return payload === undefined ? undefined : { payload };
      },
      createPendingAction: ({ id, payload }: { id: string; payload: unknown }) => pending.set(id, payload),
      getPendingAction: ({ id }: { id: string }) => {
        const payload = pending.get(id);
        return payload === undefined
          ? undefined
          : {
            createdAt: now,
            expiresAt: new Date("2100-01-01T00:00:00.000Z"),
            id,
            ownerId,
            payload,
          };
      },
    };
    const scheduleAssistant = new ScheduleAssistant({
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: pendingState,
      timeZone,
    });
    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant,
      stateRepository: pendingState,
    });
    const legacyTask = schedules.createScheduledItem({
      id: "legacy-cleanup-task",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "Legacy cleanup task",
    });
    const legacyId = "11111111-1111-4111-8111-111111111111";
    pending.set(legacyId, {
      calendarEvents: [],
      cleanupScope: "unscoped_future",
      items: [{ expectedRevision: legacyTask.revision, id: legacyTask.id }],
      kind: "schedule_cleanup",
      legacyItems: [],
      series: [],
    });

    const legacyConfirmation = message(`confirm ${legacyId}`);
    await router.handle(legacyConfirmation);

    expect(legacyConfirmation.replies).toEqual(["Cancelled or deleted 1 scheduled item."]);
    expect(schedules.getScheduledItem({ id: legacyTask.id, ownerId })).toMatchObject({ status: "cancelled" });

    const malformedTask = schedules.createScheduledItem({
      id: "malformed-cleanup-task",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "Malformed cleanup task",
    });
    const malformedId = "22222222-2222-4222-8222-222222222222";
    pending.set(malformedId, {
      calendarEvents: [],
      cleanupScope: "unscoped_future",
      items: [{ expectedRevision: malformedTask.revision, id: malformedTask.id }],
      kind: "schedule_cleanup",
      legacyItems: [],
      responseSource: "unsupported",
      series: [],
    });

    const malformedConfirmation = message(`confirm ${malformedId}`);
    await router.handle(malformedConfirmation);

    expect(malformedConfirmation.replies).toEqual(["That confirmation is invalid or has expired."]);
    expect(schedules.getScheduledItem({ id: malformedTask.id, ownerId })).toMatchObject({ status: "active" });
    schedules.close();
  });
});


describe("ScheduleAssistant legacy Calendar routing", () => {
  it("routes deterministic Calendar deletes before Gemini planning or classification", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const planner = { plan: vi.fn(async () => undefined) };
    const scheduleAssistant = new ScheduleAssistant({
      commandPlanner: planner,
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: {
        consumePendingAction: () => undefined,
        createPendingAction: () => undefined,
        getPendingAction: () => undefined,
      },
      timeZone,
    });
    const calendarHandle = vi.fn(async (): Promise<void> => undefined);
    const classifier = {
      classify: vi.fn(async () => ({ kind: "clarify" as const, reason: "ambiguous_domain" as const })),
    };
    const router = new OwnerCommandRouter({
      calendarAssistant: { handle: calendarHandle },
      naturalLanguageClassifier: classifier,
      ownerId,
      scheduleAssistant,
      stateRepository: {},
    });
    const input = message("delete the 3pm meeting on Friday");

    await router.handle(input);

    expect(planner.plan).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(calendarHandle).toHaveBeenCalledTimes(1);
    expect(calendarHandle).toHaveBeenCalledWith(expect.objectContaining({
      authorId: input.authorId,
      content: input.content,
      id: input.id,
    }));
    expect(input.replies).toEqual([]);
    schedules.close();
  });
});

describe("ScheduleAssistant unified action dry-run", () => {
  it("does not materialize or persist typed local actions in dry-run mode", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const assistant = new ScheduleAssistant({
      dryRun: true,
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: {
        consumePendingAction: () => undefined,
        createPendingAction: () => undefined,
        getPendingAction: () => undefined,
      },
      timeZone,
    });
    const input = message("remind me tomorrow at 6pm to call Mom");

    await assistant.handleNaturalLanguageAction(input, {
      action: "create_task_or_reminder",
      date: "2026-08-19",
      scheduleKind: "reminder",
      startTime: "18:00",
      title: "call Mom",
    });

    expect(input.replies).toEqual([expect.stringMatching(/Dry run/i)]);
    expect(schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    })).toHaveLength(0);
    schedules.close();
  });
});

describe("ScheduleAssistant model mutation safeguards", () => {
  function pendingState(
    pending: Map<string, unknown>,
    audits = vi.fn(),
  ): SchedulePendingStateRepository {
    return {
      consumePendingAction: ({ id }) => {
        const payload = pending.get(id);
        pending.delete(id);
        return payload === undefined ? undefined : { payload };
      },
      createPendingAction: ({ id, payload }) => pending.set(id, payload),
      getPendingAction: ({ id }) => {
        const payload = pending.get(id);
        return payload === undefined ? undefined : { payload };
      },
      recordAudit: audits,
    };
  }

  it("requires confirmation before creating a Gemini recurring local schedule and audits the write", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const pending = new Map<string, unknown>();
    const audits = vi.fn();
    const state = pendingState(pending, audits);
    const assistant = new ScheduleAssistant({
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: state,
      timeZone,
    });
    const request = message("Please remind me every day to stretch");

    await assistant.handleNaturalLanguageAction(request, {
      action: "create_task_or_reminder",
      date: "2026-08-19",
      recurrence: { frequency: "daily", interval: 1 },
      scheduleKind: "reminder",
      startTime: "18:00",
      title: "stretch",
    });

    expect(request.replies[0]).toMatch(/requires confirmation.*confirm [a-f0-9-]+/iu);
    expect(pending.size).toBe(1);
    expect(schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    })).toHaveLength(0);

    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant: assistant,
      stateRepository: state,
    });
    await router.handle(message(`confirm ${confirmationId(request.replies[0] ?? "")}`));

    expect(schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    }).length).toBeGreaterThan(0);
    expect(audits).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "schedule_create",
      status: "succeeded",
    }));
    schedules.close();
  });

  it("reviews a one-target Gemini named cleanup instead of deleting immediately", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const pending = new Map<string, unknown>();
    const state = pendingState(pending);
    const target = schedules.createScheduledItem({
      id: "named-cleanup-target",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "project notes",
    });
    const assistant = new ScheduleAssistant({
      logger,
      now: () => now,
      ownerId,
      schedulingRepository: schedules,
      stateRepository: state,
      timeZone,
    });

    const request = message("delete my project notes");
    await assistant.handleNaturalLanguageAction(request, {
      action: "cleanup_schedule",
      mode: "named",
      targetKinds: ["task"],
      terms: ["project"],
      title: "project notes",
    });

    expect(request.replies[0]).toMatch(/Review matches/iu);
    expect(pending.size).toBe(1);
    expect(schedules.getScheduledItem({ id: target.id, ownerId })).toMatchObject({ status: "active" });

    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant: assistant,
      stateRepository: state,
    });
    await router.handle(message(`confirm ${confirmationId(request.replies[0] ?? "")}`));

    expect(schedules.getScheduledItem({ id: target.id, ownerId })).toMatchObject({ status: "cancelled" });
    schedules.close();
  });
});

it("does not replay cached Gemini interpretations while the rollout is disabled", async () => {
  const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
  schedules.putInterpretation({
    command: {
      date: "2026-08-19",
      kind: "local",
      scheduleKind: "task",
      title: "cached task",
    },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    input: "hello cache",
    now,
    ownerId,
    source: "gemini",
  });
  const assistant = new ScheduleAssistant({
    geminiEnabled: false,
    logger,
    now: () => now,
    ownerId,
    schedulingRepository: schedules,
    stateRepository: {
      consumePendingAction: () => undefined,
      createPendingAction: () => undefined,
      getPendingAction: () => undefined,
    },
    timeZone,
  });

  await expect(assistant.handle(message("hello cache"))).resolves.toBe(false);
  expect(schedules.listActiveScheduledItems({ ownerId })).toHaveLength(0);
  schedules.close();
});