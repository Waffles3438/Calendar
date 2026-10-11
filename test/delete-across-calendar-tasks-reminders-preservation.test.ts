import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarAssistant } from "../src/application/calendar-assistant.js";
import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type {
  CalendarEvent,
  CalendarReference,
} from "../src/domain/calendar.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  ListCalendarEventsInput,
  SplitRecurringEventInput,
  TruncateRecurringEventInput,
  UpdateCalendarEventInput,
} from "../src/google/calendar-api.js";
import { createLogger } from "../src/logger.js";
import { AppStateRepository } from "../src/persistence/state-repository.js";
import {
  parseNaturalLanguageAction,
  validateNaturalLanguageAction,
  type NaturalLanguageAction,
} from "../src/nlp/natural-language-action.js";
import { ScheduleAssistant } from "../src/scheduling/schedule-assistant.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";
import { LocalTaskAssistant } from "../src/tasks/local-task-assistant.js";

const ownerId = "123456789012345678";
const otherOwnerId = "987654321098765432";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");
let messageNumber = 0;

function message(content: string, authorId = ownerId): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  messageNumber += 1;
  return {
    authorId,
    content,
    id: `preservation-${messageNumber}`,
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

function actionId(reply: string, command: "choose" | "confirm" = "confirm"): string {
  const id = new RegExp(`${command} ([a-f0-9-]+)`, "iu").exec(reply)?.[1];
  if (!id) {
    throw new Error(`Expected ${command} action id in: ${reply}`);
  }
  return id;
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2026-08-21T16:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    etag: "event-etag-1",
    id: "event-1",
    start: { dateTime: "2026-08-21T15:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    status: "confirmed",
    summary: "Team meeting",
    ...overrides,
  };
}

class PreservationCalendarGateway implements CalendarGateway {
  public calendars: CalendarReference[] = [
    { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone: "America/New_York" },
    { id: "secondary", isPrimary: false, readOnly: false, summary: "Secondary", timeZone: "America/New_York" },
  ];
  public events: CalendarEvent[] = [];
  public hiddenEvents: CalendarEvent[] = [];
  public readonly createCalls: CreateCalendarEventInput[] = [];
  public readonly deleteCalls: DeleteCalendarEventInput[] = [];
  public readonly listCalendarCalls: number[] = [];
  public readonly listEventCalls: ListCalendarEventsInput[] = [];
  public readonly splitCalls: SplitRecurringEventInput[] = [];
  public readonly truncateCalls: TruncateRecurringEventInput[] = [];
  public readonly updateCalls: UpdateCalendarEventInput[] = [];
  public failListCalendars = false;
  public failListEvents = false;

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    this.listCalendarCalls.push(1);
    if (this.failListCalendars) {
      throw new Error("Calendar list unavailable");
    }
    return this.calendars;
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    this.listEventCalls.push(input);
    if (this.failListEvents) {
      throw new Error("Calendar event read unavailable");
    }
    return this.events.filter((event) => event.calendarId === input.calendarId);
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const event = [...this.events, ...this.hiddenEvents].find(
      (candidate) => candidate.calendarId === input.calendarId && candidate.id === input.eventId,
    );
    if (!event) {
      throw new Error("Calendar event not found");
    }
    return event;
  }

  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    this.createCalls.push(input);
    const created = calendarEvent({
      calendarId: input.calendarId,
      end: input.end,
      etag: `created-etag-${this.createCalls.length}`,
      id: `created-event-${this.createCalls.length}`,
      recurrence: input.recurrence,
      start: input.start,
      summary: input.summary,
    });
    this.events.push(created);
    return created;
  }

  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    this.updateCalls.push(input);
    const current = await this.getEvent({ calendarId: input.calendarId, eventId: input.eventId });
    const updated: CalendarEvent = {
      ...current,
      ...input.patch,
      etag: `${current.etag}-updated`,
    };
    this.replace(updated);
    return updated;
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    this.deleteCalls.push(input);
    this.events = this.events.filter((event) => event.id !== input.eventId);
    this.hiddenEvents = this.hiddenEvents.filter((event) => event.id !== input.eventId);
  }

  public async splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent> {
    this.splitCalls.push(input);
    const created = calendarEvent({
      attendees: input.patch.attendees ?? input.master.attendees,
      calendarId: input.calendarId,
      end: input.patch.end ?? input.targetOccurrence.end,
      etag: "split-etag",
      id: "split-event",
      recurrence: input.master.recurrence,
      start: input.patch.start ?? input.targetOccurrence.start,
      summary: input.patch.summary ?? input.master.summary,
    });
    this.events.push(created);
    return created;
  }

  public async truncateRecurringEvent(input: TruncateRecurringEventInput): Promise<void> {
    this.truncateCalls.push(input);
  }

  private replace(updated: CalendarEvent): void {
    const eventIndex = this.events.findIndex((event) => event.id === updated.id);
    if (eventIndex >= 0) {
      this.events[eventIndex] = updated;
      return;
    }
    const hiddenIndex = this.hiddenEvents.findIndex((event) => event.id === updated.id);
    if (hiddenIndex >= 0) {
      this.hiddenEvents[hiddenIndex] = updated;
    }
  }
}

function createLocalAssistant(state: AppStateRepository): LocalTaskAssistant {
  return new LocalTaskAssistant({
    logger: createLogger("silent"),
    now: () => now,
    ownerId,
    stateRepository: state,
    timeZone,
  });
}

function createScheduleAssistant(
  schedules: SchedulingRepository,
  state: AppStateRepository,
  gateway?: PreservationCalendarGateway,
): ScheduleAssistant {
  return new ScheduleAssistant({
    ...(gateway ? { calendarGateway: gateway } : {}),
    logger: createLogger("silent"),
    now: () => now,
    ownerId,
    schedulingRepository: schedules,
    stateRepository: state,
    timeZone,
  });
}

function createCalendarAssistant(
  gateway: PreservationCalendarGateway,
  state: AppStateRepository,
): CalendarAssistant {
  return new CalendarAssistant({
    calendarGateway: gateway,
    logger: createLogger("silent"),
    now: () => now,
    ownerId,
    stateRepository: state,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("delete-across-calendar-tasks-reminders preservation baseline", () => {
  /**
   * Observation captured on the unfixed router: each action below went to the
   * same existing assistant entry point and did not invoke a cross-domain
   * resolver. These are deliberately outside delete_task/single with a title.
   */
  it.each([
    {
      action: { action: "delete_task", date: "2026-08-18", scope: "today" } as const,
      expected: "local",
      label: "unified today deletion",
    },
    {
      action: { action: "delete_task", scope: "all" } as const,
      expected: "local",
      label: "unified all deletion",
    },
    {
      action: { action: "complete_task", selector: { title: "call plumber" } } as const,
      expected: "local",
      label: "unified task completion",
    },
    {
      action: { action: "list_tasks" } as const,
      expected: "local",
      label: "unified task listing",
    },
    {
      action: {
        action: "create_task_or_reminder",
        date: "2026-08-19",
        scheduleKind: "reminder",
        startTime: "18:00",
        title: "call dentist",
      } as const,
      expected: "schedule",
      label: "unified reminder creation",
    },
    {
      action: {
        action: "cleanup_schedule",
        mode: "bulk",
        targetKinds: ["task", "reminder", "event"],
        terms: [],
        title: "all scheduled items",
      } as const,
      expected: "schedule",
      label: "explicit schedule cleanup",
    },
    {
      action: {
        action: "delete_calendar_event",
        selector: { date: "2026-08-21", summary: "planning" },
      } as const,
      expected: "calendar",
      label: "explicit Calendar deletion",
    },
  ] as const)("preserves the unfixed route for $label", async ({ action, expected }) => {
    const local = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguage: vi.fn(async () => undefined),
      handleNaturalLanguageAction: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
      isTaskInput: vi.fn(() => false),
    };
    const schedule = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => false),
      handleNaturalLanguageAction: vi.fn(async () => true),
      handlePendingAction: vi.fn(async () => false),
    };
    const calendar = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguageAction: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
    };
    const router = new OwnerCommandRouter({
      calendarAssistant: calendar,
      localTaskAssistant: local,
      naturalLanguagePlanner: { plan: vi.fn(async () => action) },
      ownerId,
      scheduleAssistant: schedule,
      stateRepository: {},
      taskTimeZone: timeZone,
    });

    await router.handle(message("preservation route input"));

    expect(local.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "local" ? 1 : 0);
    expect(schedule.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "schedule" ? 1 : 0);
    expect(calendar.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "calendar" ? 1 : 0);
  });

  it("preserves a legacy-only single delete response when no scheduled reminder matches", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "y".repeat(48) });
    try {
      const task = state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "legacy-call-plumber",
        now,
        ownerId,
        timeZone,
        title: "Call plumber",
      });
      const router = new OwnerCommandRouter({
        localTaskAssistant: createLocalAssistant(state),
        naturalLanguagePlanner: {
          plan: async () => ({
            action: "delete_task" as const,
            scope: "single" as const,
            selector: { title: "call plumber" },
          }),
        },
        ownerId,
        scheduleAssistant: createScheduleAssistant(schedules, state),
        stateRepository: state,
        taskTimeZone: timeZone,
      });
      const request = message("delete call plumber");

      await router.handle(request);

      expect(request.replies).toEqual(["Cancelled local task: Call plumber. [Gemini]"]);
      expect(state.getLocalTask({ id: task.id, ownerId })).toMatchObject({ revision: 2, status: "cancelled" });
      expect(schedules.listActiveScheduledItems({ ownerId })).toEqual([]);
    } finally {
      schedules.close();
      state.close();
    }
  });

  it("retains deterministic fallback when the planner is unavailable and rejects malformed action variants", async () => {
    const local = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguage: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
      isTaskInput: vi.fn(() => true),
    };
    const planner = { plan: vi.fn(async () => undefined) };
    const router = new OwnerCommandRouter({
      localTaskAssistant: local,
      naturalLanguagePlanner: planner,
      ownerId,
      stateRepository: {},
    });

    await router.handle(message("tasks"));

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(local.handle).toHaveBeenCalledTimes(1);
    expect(local.handleNaturalLanguage).not.toHaveBeenCalled();

    const invalidValues: readonly unknown[] = [
      { action: "delete_task", scope: "single" },
      { action: "delete_task", date: "2026-08-18", scope: "all" },
      { action: "delete_task", scope: "today" },
      { action: "delete_task", scope: "all", selector: { title: "everything" } },
      { action: "delete_task", date: "2026-08-18", scope: "today", selector: { title: "today" } },
      { action: "not_a_supported_action" },
      { action: "list_tasks", tool: "delete everything" },
    ];
    for (const value of invalidValues) {
      expect(validateNaturalLanguageAction(value, { now, timeZone })).toBeUndefined();
    }
    expect(parseNaturalLanguageAction("not-json", { now, timeZone })).toBeUndefined();
  });

  it("preserves explicit local-task creation, listing, completion, cancellation, date scope, ambiguity, and owner isolation", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    try {
      const local = createLocalAssistant(state);
      const run = state.createLocalTask({
        dueAt: new Date("2026-08-19T22:00:00.000Z"),
        id: "legacy-run",
        now,
        ownerId,
        timeZone,
        title: "run",
      });
      const walk = state.createLocalTask({
        dueAt: new Date("2026-08-19T23:00:00.000Z"),
        id: "legacy-walk",
        now,
        ownerId,
        timeZone,
        title: "walk",
      });
      state.createLocalTask({
        dueAt: new Date("2026-08-20T22:00:00.000Z"),
        id: "foreign-run",
        now,
        ownerId: otherOwnerId,
        timeZone,
        title: "private foreign task",
      });

      const listing = message("tasks");
      await local.handle(listing);
      expect(listing.replies.join(" ")).toMatch(/Active local tasks/i);
      expect(listing.replies.join(" ")).toContain("run");
      expect(listing.replies.join(" ")).toContain("walk");

      const completion = message("done run");
      await local.handle(completion);
      expect(state.getLocalTask({ id: run.id, ownerId })).toMatchObject({ status: "completed", revision: 2 });

      const cancellation = message("delete task walk");
      await local.handle(cancellation);
      expect(state.getLocalTask({ id: walk.id, ownerId })).toMatchObject({ status: "cancelled", revision: 2 });

      const todayTask = state.createLocalTask({
        dueAt: new Date("2026-08-18T14:00:00.000Z"),
        id: "today-local",
        now,
        ownerId,
        timeZone,
        title: "today local",
      });
      const tomorrowTask = state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "tomorrow-local",
        now,
        ownerId,
        timeZone,
        title: "tomorrow local",
      });
      await local.handle(message("delete all tasks for today"));
      expect(state.getLocalTask({ id: todayTask.id, ownerId })).toMatchObject({ status: "cancelled" });
      expect(state.getLocalTask({ id: tomorrowTask.id, ownerId })).toMatchObject({ status: "active" });

      const firstAmbiguous = state.createLocalTask({
        dueAt: new Date("2026-08-20T14:00:00.000Z"),
        id: "ambiguous-one",
        now,
        ownerId,
        timeZone,
        title: "read",
      });
      const secondAmbiguous = state.createLocalTask({
        dueAt: new Date("2026-08-21T14:00:00.000Z"),
        id: "ambiguous-two",
        now,
        ownerId,
        timeZone,
        title: "read",
      });
      const ambiguous = message("done read");
      await local.handle(ambiguous);
      expect(ambiguous.replies[0]).toMatch(/multiple active local tasks/i);
      const choice = actionId(ambiguous.replies[0] ?? "", "choose");
      await local.handle(message(`choose ${choice} 1`));
      expect(state.getLocalTask({ id: firstAmbiguous.id, ownerId })).toMatchObject({ status: "completed" });
      expect(state.getLocalTask({ id: secondAmbiguous.id, ownerId })).toMatchObject({ status: "active" });

      const foreignRequest = message("delete task private foreign task");
      await local.handle(foreignRequest);
      expect(foreignRequest.replies.join(" ")).toMatch(/could not find an active local task/i);
      expect(state.getLocalTask({ id: "foreign-run", ownerId: otherOwnerId })).toMatchObject({ status: "active" });
    } finally {
      state.close();
    }
  });

  it("preserves explicit reminder cleanup, delete-all review, named cleanup, and recurring materialization", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "y".repeat(48) });
    try {
      const schedule = createScheduleAssistant(schedules, state);
      const dentist = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "dentist-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Call dentist",
      });
      const unrelated = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "doctor-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Call doctor",
      });

      await schedule.handle(message("delete reminder dentist"));
      expect(schedules.getScheduledItem({ id: dentist.id, ownerId })).toMatchObject({ status: "cancelled" });
      expect(schedules.getScheduledItem({ id: unrelated.id, ownerId })).toMatchObject({ status: "active" });

      const project = schedules.createScheduledItem({
        dueAt: new Date("2026-08-20T14:00:00.000Z"),
        id: "project-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-20",
        timeZone,
        title: "Project review",
      });
      const cleanup = message("delete project reminder");
      await schedule.handleNaturalLanguageAction(cleanup, {
        action: "cleanup_schedule",
        mode: "named",
        targetKinds: ["reminder"],
        terms: ["project"],
        title: "project",
      });
      expect(cleanup.replies[0]).toMatch(/Review matches/i);
      const cleanupId = actionId(cleanup.replies[0] ?? "");
      expect(schedules.getScheduledItem({ id: project.id, ownerId })).toMatchObject({ status: "active" });
      await schedule.handlePendingAction(message(`confirm ${cleanupId}`), { actionId: cleanupId, kind: "confirm" });
      expect(schedules.getScheduledItem({ id: project.id, ownerId })).toMatchObject({ status: "cancelled" });

      const allTask = schedules.createScheduledItem({
        id: "all-task",
        kind: "task",
        now,
        ownerId,
        scheduledDate: "2026-08-21",
        timeZone,
        title: "All-day task",
      });
      const allRequest = message("delete all tasks");
      await schedule.handle(allRequest);
      expect(allRequest.replies[0]).toMatch(/Review matches/i);
      const allId = actionId(allRequest.replies[0] ?? "");
      expect(schedules.getScheduledItem({ id: allTask.id, ownerId })).toMatchObject({ status: "active" });
      await schedule.handlePendingAction(message(`confirm ${allId}`), { actionId: allId, kind: "confirm" });
      expect(schedules.getScheduledItem({ id: allTask.id, ownerId })).toMatchObject({ status: "cancelled" });

      schedules.createScheduleSeries({
        id: "yoga-series",
        kind: "reminder",
        now,
        ownerId,
        recurrence: { frequency: "weekly", interval: 1, weekdays: [3] },
        startDate: "2026-08-19",
        startTime: "18:00",
        timeZone,
        title: "Yoga class",
      }, "2026-09-02");
      const occurrences = schedules.listActiveScheduledItems({
        ownerId,
        scheduledDateEarliest: "2026-08-19",
        scheduledDateLatest: "2026-09-02",
      }).filter((item) => item.seriesId === "yoga-series");
      expect(occurrences.map((item) => item.scheduledDate)).toEqual(["2026-08-19", "2026-08-26", "2026-09-02"]);
    } finally {
      schedules.close();
      state.close();
    }
  });

  it("preserves scheduled reminder timing, owner filtering, revision transitions, delivery retries, and history", () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "z".repeat(48) });
    try {
      const reminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-18T13:00:00.000Z"),
        id: "delivery-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-18",
        timeZone,
        title: "Delivery reminder",
      });
      schedules.createScheduledItem({
        dueAt: new Date("2026-08-18T13:00:00.000Z"),
        id: "foreign-delivery-reminder",
        kind: "reminder",
        now,
        ownerId: otherOwnerId,
        scheduledDate: "2026-08-18",
        timeZone,
        title: "Private other-owner reminder",
      });
      const scheduledFor = new Date("2026-08-18T13:00:00.000Z");
      const leaseExpiresAt = new Date("2026-08-18T13:05:00.000Z");
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "claim-1",
        itemId: reminder.id,
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor,
      })).toBe(true);
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "claim-2",
        itemId: reminder.id,
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor,
      })).toBe(false);
      schedules.releaseScheduledReminderClaim({ claimToken: "claim-1", itemId: reminder.id, scheduledFor });
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "claim-retry",
        itemId: reminder.id,
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor,
      })).toBe(true);
      expect(schedules.completeScheduledReminderDelivery({
        claimToken: "claim-retry",
        itemId: reminder.id,
        scheduledFor,
        sentAt: new Date("2026-08-18T13:01:00.000Z"),
      })).toBe(true);
      expect(schedules.completeScheduledReminderDelivery({
        claimToken: "claim-retry",
        itemId: reminder.id,
        scheduledFor,
        sentAt: new Date("2026-08-18T13:02:00.000Z"),
      })).toBe(false);
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "claim-after-history",
        itemId: reminder.id,
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor,
      })).toBe(false);
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "foreign-claim",
        itemId: "foreign-delivery-reminder",
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor,
      })).toBe(false);

      const revisionOne = schedules.getScheduledItem({ id: reminder.id, ownerId });
      expect(revisionOne?.revision).toBe(1);
      expect(schedules.cancelScheduledItem({
        expectedRevision: revisionOne!.revision,
        id: reminder.id,
        now: new Date("2026-08-18T14:00:00.000Z"),
        ownerId,
      })).toMatchObject({ status: "cancelled", revision: 2 });
      expect(schedules.tryClaimScheduledReminderDelivery({
        claimToken: "claim-after-cancel",
        itemId: reminder.id,
        leaseExpiresAt,
        now,
        ownerId,
        scheduledFor: new Date("2026-08-18T14:00:00.000Z"),
      })).toBe(false);
    } finally {
      schedules.close();
    }
  });

  it("preserves Calendar creation, attendee changes, reminder overrides, deletion, and guest notifications", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "a".repeat(48) });
    const gateway = new PreservationCalendarGateway();
    gateway.events = [calendarEvent()];
    try {
      const assistant = createCalendarAssistant(gateway, state);
      await assistant.handleNaturalLanguageAction(message("create lunch"), {
        action: "create_calendar_event",
        date: "2026-08-22",
        endTime: "16:00",
        startTime: "15:00",
        title: "Lunch",
      });
      expect(gateway.createCalls).toEqual([
        expect.objectContaining({ calendarId: "primary", sendUpdates: "none", summary: "Lunch" }),
      ]);

      const attendeeRequest = message("add guest");
      await assistant.handleNaturalLanguageAction(attendeeRequest, {
        action: "manage_calendar_attendees",
        change: { action: "add", emails: ["guest@example.com"] },
        selector: { date: "2026-08-21", summary: "meeting", time: "15:00" },
      });
      expect(attendeeRequest.replies[0]).toMatch(/confirm/i);
      const attendeeId = actionId(attendeeRequest.replies.join(" "));
      await assistant.handlePendingAction(message(`confirm ${attendeeId}`), { actionId: attendeeId, kind: "confirm" });
      expect(gateway.updateCalls).toContainEqual(expect.objectContaining({
        eventId: "event-1",
        patch: { attendees: [{ email: "guest@example.com" }] },
        sendUpdates: "all",
      }));

      const reminderRequest = message("set reminder");
      await assistant.handleNaturalLanguageAction(reminderRequest, {
        action: "set_calendar_reminder",
        minutesBefore: 30,
        selector: { date: "2026-08-21", summary: "meeting", time: "15:00" },
      });
      const reminderId = actionId(reminderRequest.replies.join(" "));
      await assistant.handlePendingAction(message(`confirm ${reminderId}`), { actionId: reminderId, kind: "confirm" });
      expect(state.getReminderOverride({ calendarId: "primary", eventId: "event-1" })).toBe(30);

      const deleteRequest = message("delete meeting");
      await assistant.handleNaturalLanguageAction(deleteRequest, {
        action: "delete_calendar_event",
        selector: { date: "2026-08-21", summary: "meeting", time: "15:00" },
      });
      const deleteId = actionId(deleteRequest.replies.join(" "));
      await assistant.handlePendingAction(message(`confirm ${deleteId}`), { actionId: deleteId, kind: "confirm" });
      expect(gateway.deleteCalls).toContainEqual(expect.objectContaining({
        eventId: "event-1",
        sendUpdates: "all",
      }));
    } finally {
      state.close();
    }
  });

  it("preserves Calendar pending confirmation, ETag, recurrence, writable-access, and fresh-read safety", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "b".repeat(48) });
    try {
      const staleGateway = new PreservationCalendarGateway();
      staleGateway.events = [calendarEvent({ attendees: [{ email: "guest@example.com", self: false }] })];
      const staleAssistant = createCalendarAssistant(staleGateway, state);
      const staleRequest = message("move guest meeting");
      await staleAssistant.handleNaturalLanguageAction(staleRequest, {
        action: "move_calendar_event",
        newStartTime: "16:00",
        selector: { date: "2026-08-21", summary: "meeting", time: "15:00" },
      });
      const staleId = actionId(staleRequest.replies.join(" "));
      staleGateway.events[0] = calendarEvent({
        attendees: [{ email: "guest@example.com", self: false }],
        etag: "changed-etag",
      });
      await staleAssistant.handlePendingAction(message(`confirm ${staleId}`), { actionId: staleId, kind: "confirm" });
      expect(staleGateway.updateCalls).toHaveLength(0);

      const recurringState = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "c".repeat(48) });
      const recurringGateway = new PreservationCalendarGateway();
      recurringGateway.events = [calendarEvent({ id: "occurrence", recurringEventId: "master" })];
      recurringGateway.hiddenEvents = [calendarEvent({
        etag: "master-etag",
        id: "master",
        recurrence: ["RRULE:FREQ=WEEKLY"],
        start: { dateTime: "2026-08-21T15:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
      })];
      const recurringAssistant = createCalendarAssistant(recurringGateway, recurringState);
      const recurringRequest = message("delete this series occurrence");
      await recurringAssistant.handleNaturalLanguageAction(recurringRequest, {
        action: "delete_calendar_event",
        recurrenceScope: "all_future",
        selector: { date: "2026-08-21", summary: "meeting", time: "15:00" },
      });
      const recurringId = actionId(recurringRequest.replies.join(" "));
      recurringGateway.hiddenEvents[0] = { ...recurringGateway.hiddenEvents[0]!, etag: "changed-master-etag" };
      await recurringAssistant.handlePendingAction(message(`confirm ${recurringId}`), { actionId: recurringId, kind: "confirm" });
      expect(recurringGateway.truncateCalls).toHaveLength(0);
      recurringState.close();

      const readFailureState = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "d".repeat(48) });
      const readFailureGateway = new PreservationCalendarGateway();
      readFailureGateway.failListEvents = true;
      const readFailureAssistant = createCalendarAssistant(readFailureGateway, readFailureState);
      const readFailure = message("delete meeting");
      await readFailureAssistant.handleNaturalLanguageAction(readFailure, {
        action: "delete_calendar_event",
        selector: { date: "2026-08-21", summary: "meeting" },
      });
      expect(readFailureGateway.deleteCalls).toHaveLength(0);
      expect(readFailure.replies.join(" ")).toMatch(/could not complete|try again/i);
      readFailureState.close();

      const readOnlyState = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "e".repeat(48) });
      const readOnlyGateway = new PreservationCalendarGateway();
      readOnlyGateway.calendars[0] = { ...readOnlyGateway.calendars[0]!, readOnly: true };
      readOnlyGateway.events = [calendarEvent()];
      const readOnlyAssistant = createCalendarAssistant(readOnlyGateway, readOnlyState);
      const readOnly = message("delete meeting");
      await readOnlyAssistant.handleNaturalLanguageAction(readOnly, {
        action: "delete_calendar_event",
        selector: { date: "2026-08-21", summary: "meeting" },
      });
      expect(readOnlyGateway.deleteCalls).toHaveLength(0);
      expect(readOnly.replies.join(" ")).toMatch(/read-only/i);
      readOnlyState.close();
    } finally {
      state.close();
    }
  });

  it("preserves owner-bound, expired, malformed, and stale pending-action failure behavior", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "f".repeat(48) });
    try {
      state.createPendingAction({
        expiresAt: new Date(now.valueOf() + 1_000),
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerId,
        payload: { kind: "unknown_pending_kind" },
      });
      const malformedRouter = new OwnerCommandRouter({ ownerId, stateRepository: state });
      const malformed = message("confirm aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await malformedRouter.handle(malformed);
      expect(malformed.replies).toEqual(["That confirmation is invalid or has expired."]);

      state.createPendingAction({
        expiresAt: new Date(now.valueOf() + 1_000),
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ownerId: otherOwnerId,
        payload: { kind: "unknown_pending_kind" },
      });
      const ownerMismatchRouter = new OwnerCommandRouter({ ownerId, stateRepository: state });
      const ownerMismatch = message("confirm bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      await ownerMismatchRouter.handle(ownerMismatch);
      expect(ownerMismatch.replies).toEqual(["That confirmation is invalid or has expired."]);

      state.createPendingAction({
        expiresAt: new Date(now.valueOf() + 1_000),
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        ownerId,
        payload: { kind: "unknown_pending_kind" },
      });
      vi.setSystemTime(new Date(now.valueOf() + 2_000));
      const expiredRouter = new OwnerCommandRouter({ ownerId, stateRepository: state });
      const expired = message("confirm cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      await expiredRouter.handle(expired);
      expect(expired.replies).toEqual(["That confirmation is invalid or has expired."]);
    } finally {
      state.close();
    }
  });
});


describe("non-single and non-delete routing preservation matrix", () => {
  const routingFixtures = [
    {
      action: { action: "delete_task", date: "2026-08-18", scope: "today" } as const,
      expected: "local" as const,
      label: "a date-scoped today delete",
    },
    {
      action: { action: "delete_task", scope: "all" } as const,
      expected: "local" as const,
      label: "an all-task delete",
    },
    {
      action: {
        action: "cleanup_schedule",
        mode: "bulk",
        targetKinds: ["task", "reminder", "event"],
        terms: [],
        title: "all scheduled items",
      } as const,
      expected: "schedule" as const,
      label: "an explicit bulk schedule cleanup",
    },
    {
      action: {
        action: "delete_calendar_event",
        selector: { date: "2026-08-21", summary: "planning" },
      } as const,
      expected: "calendar" as const,
      label: "an explicit Calendar delete",
    },
    {
      action: { action: "list_tasks" } as const,
      expected: "local" as const,
      label: "a non-delete task action",
    },
    {
      action: {
        action: "create_task_or_reminder",
        date: "2026-08-19",
        scheduleKind: "reminder",
        startTime: "18:00",
        title: "call dentist",
      } as const,
      expected: "schedule" as const,
      label: "a non-delete reminder action",
    },
  ] as const;

  // **Validates: Requirements 3.4, 3.5, 3.8**
  it.each(routingFixtures)("keeps $label on its existing handler", async ({ action, expected }) => {
    const local = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguage: vi.fn(async () => undefined),
      handleNaturalLanguageAction: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
      isTaskInput: vi.fn(() => false),
    };
    const schedule = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => false),
      handleNaturalLanguageAction: vi.fn(async () => true),
      handlePendingAction: vi.fn(async () => false),
    };
    const calendar = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguageAction: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
    };
    const planner = { plan: vi.fn(async () => action) };
    const router = new OwnerCommandRouter({
      calendarAssistant: calendar,
      localTaskAssistant: local,
      naturalLanguagePlanner: planner,
      ownerId,
      scheduleAssistant: schedule,
      stateRepository: {},
      taskTimeZone: timeZone,
    });

    await router.handle(message("preservation route matrix input"));

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(local.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "local" ? 1 : 0);
    expect(schedule.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "schedule" ? 1 : 0);
    expect(calendar.handleNaturalLanguageAction).toHaveBeenCalledTimes(expected === "calendar" ? 1 : 0);
  });
});
