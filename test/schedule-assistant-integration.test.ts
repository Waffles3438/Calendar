import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { CalendarEvent, CalendarReference } from "../src/domain/calendar.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  SplitRecurringEventInput,
  TruncateRecurringEventInput,
  UpdateCalendarEventInput,
} from "../src/google/calendar-api.js";
import {
  MAX_BULK_LOCAL_TASK_CANCELLATIONS,
  type LocalTask,
} from "../src/tasks/task-domain.js";
import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import { ScheduleAssistant } from "../src/scheduling/schedule-assistant.js";
import { MAX_BULK_SCHEDULE_CANCELLATIONS } from "../src/scheduling/schedule-domain.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: `message-${replies.length}`,
    replies,
    reply: async (response) => { replies.push(response); },
  };
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "team",
    end: { dateTime: "2026-08-19T11:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    etag: "event-etag",
    id: "event-1",
    start: { dateTime: "2026-08-19T10:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    status: "confirmed",
    summary: "Yoga class",
    ...overrides,
  };
}

class FakeGateway implements CalendarGateway {
  public readonly calendars: CalendarReference[] = [
    { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone },
    { id: "team", isPrimary: false, readOnly: false, summary: "Team", timeZone: "America/New_York" },
  ];
  public readonly createCalls: CreateCalendarEventInput[] = [];
  public readonly deleteCalls: DeleteCalendarEventInput[] = [];
  public readonly truncateCalls: TruncateRecurringEventInput[] = [];
  public events: CalendarEvent[] = [];
  public masters: CalendarEvent[] = [];

  public async listCalendars(): Promise<readonly CalendarReference[]> { return this.calendars; }
  public async listEvents(input: { calendarId: string }): Promise<readonly CalendarEvent[]> {
    return this.events.filter((event) => event.calendarId === input.calendarId);
  }
  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const found = [...this.events, ...this.masters].find((event) => event.calendarId === input.calendarId && event.id === input.eventId);
    if (!found) {
      throw new Error("not found");
    }
    return found;
  }
  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    this.createCalls.push(input);
    const created = calendarEvent({
      calendarId: input.calendarId,
      end: input.end,
      etag: `created-${this.createCalls.length}`,
      id: `created-${this.createCalls.length}`,
      recurrence: input.recurrence,
      start: input.start,
      summary: input.summary,
    });
    this.events.push(created);
    return created;
  }
  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    this.deleteCalls.push(input);
    this.events = this.events.filter((event) => event.id !== input.eventId);
  }
  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    const current = await this.getEvent({ calendarId: input.calendarId, eventId: input.eventId });
    return { ...current, ...input.patch, etag: `${current.etag}-updated` };
  }
  public async splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent> {
    return calendarEvent({ id: "split", summary: input.patch.summary ?? input.master.summary });
  }
  public async truncateRecurringEvent(input: TruncateRecurringEventInput): Promise<void> {
    this.truncateCalls.push(input);
  }
}

class FakeState {
  public readonly legacy = new Map<string, LocalTask>();
  public readonly pending = new Map<string, { expiresAt: Date; payload: unknown }>();

  public createPendingAction(input: { expiresAt: Date; id: string; ownerId: string; payload: unknown }): void {
    this.pending.set(input.id, { expiresAt: input.expiresAt, payload: input.payload });
  }
  public getPendingAction(input: { id: string; now: Date; ownerId: string }) {
    const pending = this.pending.get(input.id);
    return pending && pending.expiresAt > input.now ? { payload: pending.payload } : undefined;
  }
  public consumePendingAction(input: { id: string; now: Date; ownerId: string }) {
    const pending = this.getPendingAction(input);
    if (pending) {
      this.pending.delete(input.id);
    }
    return pending;
  }
  public getLocalTask(input: { id: string; ownerId: string }): LocalTask | undefined {
    const task = this.legacy.get(input.id);
    return task?.ownerId === input.ownerId ? task : undefined;
  }
  public listActiveLocalTasks(): readonly LocalTask[] {
    return [...this.legacy.values()].filter((task) => task.status === "active");
  }
  public cancelLocalTasks(input: { now: Date; ownerId: string; tasks: readonly { expectedRevision: number; id: string }[] }): readonly LocalTask[] | undefined {
    const selected = input.tasks.map((target) => this.legacy.get(target.id));
    if (selected.some((task, index) => !task || task.status !== "active" || task.revision !== input.tasks[index]?.expectedRevision)) {
      return undefined;
    }
    return selected.flatMap((task) => {
      if (!task) {
        return [];
      }
      const updated: LocalTask = { ...task, cancelledAt: input.now, revision: task.revision + 1, status: "cancelled", updatedAt: input.now };
      this.legacy.set(updated.id, updated);
      return [updated];
    });
  }
  public recordAudit = vi.fn();
}

function assistant(input: {
  gateway?: FakeGateway;
  now?: () => Date;
  planner?: { calls: number; plan: () => Promise<undefined> };
  schedules: SchedulingRepository;
  state?: FakeState;
}): ScheduleAssistant {
  return new ScheduleAssistant({
    ...(input.gateway ? { calendarGateway: input.gateway } : {}),
    ...(input.planner ? { commandPlanner: { plan: input.planner.plan } } : {}),
    logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    now: input.now ?? (() => now),
    ownerId,
    schedulingRepository: input.schedules,
    stateRepository: input.state ?? new FakeState(),
    timeZone,
  });
}

function confirmationId(reply: string): string {
  const id = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
  if (!id) {
    throw new Error(`Expected confirmation id in: ${reply}`);
  }
  return id;
}

describe("ScheduleAssistant integration", () => {
  it("creates all-day tasks, timed reminders, and a strict named-calendar event", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const gateway = new FakeGateway();
    const instance = assistant({ gateway, schedules });

    const taskRequest = message("Create task buy cheese tomorrow");
    const reminderRequest = message("Remind me call dentist tomorrow at 6pm");
    await instance.handle(taskRequest);
    await instance.handle(reminderRequest);
    await instance.handle(message("Schedule planning tomorrow at 9am for 1 hr in Team calendar"));

    expect(taskRequest.replies.join(" ")).toMatch(/Created all-day task: buy cheese for <t:\d+:D>/u);
    expect(taskRequest.replies.join(" ")).not.toContain("2026-08-19");
    expect(reminderRequest.replies.join(" ")).toMatch(/Created reminder: call dentist at <t:\d+:F>/u);
    const records = schedules.listActiveScheduledItems({ ownerId, scheduledDateEarliest: "2026-08-19", scheduledDateLatest: "2026-08-19" });
    expect(records.map((item) => [item.kind, item.title])).toEqual([["task", "buy cheese"], ["reminder", "call dentist"]]);
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]).toMatchObject({
      calendarId: "team",
      end: { dateTime: "2026-08-19T10:00:00.000-04:00", timeZone: "America/New_York" },
      start: { dateTime: "2026-08-19T09:00:00.000-04:00", timeZone: "America/New_York" },
      summary: "planning",
    });
    schedules.close();
  });

  it("rejects ambiguous named calendars and completes new scheduled reminders by their durable id", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const gateway = new FakeGateway();
    gateway.calendars.push({ id: "team-duplicate", isPrimary: false, readOnly: false, summary: "TEAM", timeZone });
    const instance = assistant({ gateway, schedules });
    const event = message("Schedule planning tomorrow at 9am for 1 hr in Team calendar");

    await instance.handle(event);
    expect(gateway.createCalls).toHaveLength(0);
    expect(event.replies.join(" ")).toMatch(/could not find one writable calendar/i);

    const item = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T13:00:00.000Z"), id: "11111111-1111-4111-8111-111111111111", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Buy cheese",
    });
    const done = message(`done ${item.id}`);
    await instance.handle(done);
    expect(schedules.getScheduledItem({ id: item.id, ownerId })?.status).toBe("completed");
    expect(done.replies.join(" ")).toMatch(/Completed reminder/i);
    schedules.close();
  });

  it("persists manual correction context across an assistant restart and reuses its encrypted cache", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const planner = { calls: 0, plan: async () => { planner.calls += 1; return undefined; } };
    const first = assistant({ planner, schedules, state });
    const unknown = message("Please arrange an abstract thing");

    await first.handle(unknown);
    expect(planner.calls).toBe(1);
    expect(unknown.replies.join(" ")).toMatch(/Reply within 10 minutes/i);

    const afterRestart = assistant({ planner, schedules, state });
    await afterRestart.handle(message(["create: task", "title: Prepare report", "date: 2026-08-20"].join("\n")));
    const replay = message("Please arrange an abstract thing");
    await afterRestart.handle(replay);

    expect(planner.calls).toBe(1);
    expect(schedules.listActiveScheduledItems({ ownerId, scheduledDateEarliest: "2026-08-20", scheduledDateLatest: "2026-08-20" })
      .map((item) => item.title)).toEqual(["Prepare report", "Prepare report"]);
    schedules.close();
  });

  it("reviews future local, legacy, and recurring Calendar cleanup then fails closed on a stale series master", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    schedules.createScheduleSeries({
      id: "series-yoga", kind: "task", now, ownerId, recurrence: { frequency: "weekly", interval: 1, weekdays: [3] },
      startDate: "2026-08-19", timeZone, title: "Yoga class",
    }, "2026-09-30");
    const state = new FakeState();
    state.legacy.set("legacy-yoga", {
      createdAt: now, dueAt: new Date("2026-08-20T14:00:00.000Z"), id: "legacy-yoga", ownerId, revision: 1,
      status: "active", timeZone, title: "Yoga legacy reminder", updatedAt: now,
    });
    const gateway = new FakeGateway();
    const occurrence = calendarEvent({
      attendees: [{ email: "guest@example.com", self: false }],
      etag: "occurrence-etag",
      id: "yoga-occurrence",
      recurringEventId: "yoga-master",
    });
    gateway.events = [occurrence];
    gateway.masters = [calendarEvent({
      attendees: [{ email: "guest@example.com", self: false }], calendarId: "team", etag: "master-etag", id: "yoga-master",
      recurrence: ["RRULE:FREQ=WEEKLY"], summary: "Yoga class",
    })];
    const instance = assistant({ gateway, schedules, state });
    const request = message("My yoga classes ended");

    await instance.handle(request);
    expect(request.replies.join(" ")).toMatch(/guests will be notified/i);
    const id = confirmationId(request.replies.join(" "));
    gateway.masters[0] = { ...gateway.masters[0]!, etag: "changed-master-etag" };

    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(gateway.truncateCalls).toHaveLength(0);
    expect(state.legacy.get("legacy-yoga")?.status).toBe("cancelled");
    expect(schedules.listActiveScheduledItems({ ownerId, scheduledDateEarliest: "2026-08-19", scheduledDateLatest: "2026-09-30" })).toEqual([]);
    schedules.close();
  });
});


describe("ScheduleAssistant regression coverage", () => {
  it("retains relative hour and minute schedules as timed reminders with rounded instants", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const instance = assistant({ schedules });
    const hourRequest = message("Schedule focus in 1 hr");
    const minuteRequest = message("Schedule stretch in 30 mins");

    await instance.handle(hourRequest);
    await instance.handle(minuteRequest);

    const records = schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-18",
      scheduledDateLatest: "2026-08-18",
    });
    expect(records).toHaveLength(2);
    expect(records.find((item) => item.title === "focus")).toMatchObject({
      dueAt: new Date("2026-08-18T13:00:00.000Z"),
      kind: "reminder",
      scheduledDate: "2026-08-18",
      title: "focus",
    });
    expect(records.find((item) => item.title === "stretch")).toMatchObject({
      dueAt: new Date("2026-08-18T12:30:00.000Z"),
      kind: "reminder",
      scheduledDate: "2026-08-18",
      title: "stretch",
    });
    expect(hourRequest.replies.join(" ")).toMatch(/Created reminder/i);
    expect(minuteRequest.replies.join(" ")).toMatch(/<t:\d+:F>/u);
    schedules.close();
  });

  it("keeps an unsupported untyped delete out of scheduled cleanup", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T13:00:00.000Z"),
      id: "unsupported-delete-reminder",
      kind: "reminder",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "play among us",
    });
    const planner = { calls: 0, plan: async () => { planner.calls += 1; return undefined; } };
    const instance = assistant({ planner, schedules });
    const request = message("delete play among us");

    await expect(instance.handle(request)).resolves.toBe(true);

    expect(planner.calls).toBe(1);
    expect(request.replies).toEqual([expect.stringMatching(/could not safely interpret/i)]);
    expect(schedules.getScheduledItem({ id: "unsupported-delete-reminder", ownerId })).toMatchObject({ status: "active" });
    schedules.close();
  });

  it("does not persist or replay a date-relative alias interpretation", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const planner = {
      calls: 0,
      plan: async () => {
        planner.calls += 1;
        return undefined;
      },
    };
    const instance = assistant({ planner, schedules });
    const input = "Please arrange focus in 2 hrs";

    await instance.handle(message(input));
    await instance.handle(message(["create: task", "title: Prepare report", "date: 2026-08-20"].join("\n")));

    expect(schedules.getInterpretation({ input, now, ownerId })).toBeUndefined();

    await instance.handle(message(input));

    expect(planner.calls).toBe(2);
    expect(schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-20",
      scheduledDateLatest: "2026-08-20",
    }).map((item) => item.title)).toEqual(["Prepare report"]);
    schedules.close();
  });

  it("reports a reviewed local cleanup as failed without partially cancelling earlier items", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const instance = assistant({ schedules });
    const first = schedules.createScheduledItem({
      id: "first-yoga", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Yoga class one",
    });
    const second = schedules.createScheduledItem({
      id: "second-yoga", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Yoga class two",
    });
    const request = message("delete all future yoga tasks");

    await instance.handle(request);
    const id = confirmationId(request.replies.join(" "));
    expect(schedules.completeScheduledItem({
      expectedRevision: second.revision,
      id: second.id,
      now: new Date("2026-08-18T12:30:00.000Z"),
      ownerId,
    })?.status).toBe("completed");

    const confirmation = message(`confirm ${id}`);
    await instance.handlePendingAction(confirmation, { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: first.id, ownerId })).toMatchObject({ revision: 1, status: "active" });
    expect(schedules.getScheduledItem({ id: second.id, ownerId })).toMatchObject({ status: "completed" });
    expect(confirmation.replies).toEqual(["Cancelled or deleted 0 items; 2 items changed or could not be removed."]);
    schedules.close();
  });

  it("reviews only future timed items and starts recurring cleanup at the first future occurrence", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const overdue = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T11:00:00.000Z"), id: "overdue-yoga", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-18", timeZone, title: "Yoga overdue reminder",
    });
    schedules.createScheduleSeries({
      id: "yoga-series", kind: "reminder", now, ownerId, recurrence: { frequency: "weekly", interval: 1, weekdays: [2] },
      startDate: "2026-08-18", startTime: "07:00", timeZone, title: "Yoga class",
    }, "2026-08-31");
    const seriesItems = schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-18",
      scheduledDateLatest: "2026-08-31",
    });
    const pastSeries = seriesItems.find((item) => item.seriesId === "yoga-series" && item.scheduledDate === "2026-08-18");
    const futureSeries = seriesItems.find((item) => item.seriesId === "yoga-series" && item.scheduledDate === "2026-08-25");
    const gateway = new FakeGateway();
    gateway.events = [
      calendarEvent({
        end: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone }, etag: "in-progress-etag",
        id: "in-progress", start: { dateTime: "2026-08-18T07:00:00.000-04:00", kind: "timed", timeZone }, summary: "Yoga currently in progress",
      }),
      calendarEvent({
        end: { dateTime: "2026-08-18T07:00:00.000-04:00", kind: "timed", timeZone }, etag: "past-etag", id: "past-occurrence",
        recurringEventId: "yoga-master", start: { dateTime: "2026-08-18T06:00:00.000-04:00", kind: "timed", timeZone }, summary: "Yoga past occurrence",
      }),
      calendarEvent({
        end: { dateTime: "2026-08-18T11:00:00.000-04:00", kind: "timed", timeZone }, etag: "future-etag", id: "future-occurrence",
        recurringEventId: "yoga-master", start: { dateTime: "2026-08-18T10:00:00.000-04:00", kind: "timed", timeZone }, summary: "Yoga class",
      }),
    ];
    gateway.masters = [calendarEvent({
      calendarId: "team", etag: "master-etag", id: "yoga-master", recurrence: ["RRULE:FREQ=WEEKLY"], summary: "Yoga class",
    })];
    const instance = assistant({ gateway, schedules });
    const request = message("My yoga classes ended");

    await instance.handle(request);

    expect(request.replies.join(" ")).not.toContain("Yoga overdue reminder");
    expect(request.replies.join(" ")).not.toContain("Yoga currently in progress");
    expect(request.replies.join(" ")).not.toContain("Yoga past occurrence");
    expect(request.replies.join(" ")).toMatch(/all future occurrences from <t:\d+:D>/u);
    expect(request.replies.join(" ")).not.toContain("2026-08-25");
    const id = confirmationId(request.replies.join(" "));

    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: overdue.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: pastSeries!.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: futureSeries!.id, ownerId })).toMatchObject({ status: "cancelled" });
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(gateway.truncateCalls).toHaveLength(1);
    expect(gateway.truncateCalls[0]?.targetOccurrence.id).toBe("future-occurrence");
    schedules.close();
  });

  it("requires confirmation for an unscoped delete-all request even when one item matches", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const task = schedules.createScheduledItem({
      id: "all-task", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Buy groceries",
    });
    const instance = assistant({ schedules, state });
    const request = message("delete all tasks");

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(schedules.getScheduledItem({ id: task.id, ownerId })?.status).toBe("active");
    const id = confirmationId(request.replies.join(" "));
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: task.id, ownerId })?.status).toBe("cancelled");
    schedules.close();
  });

  it("requires confirmation before deleting every scheduled category", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const task = schedules.createScheduledItem({
      id: "all-category-task", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Buy groceries",
    });
    const reminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T14:00:00.000Z"), id: "all-category-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Call dentist",
    });
    const gateway = new FakeGateway();
    gateway.events = [calendarEvent({ id: "all-category-event", summary: "Planning" })];
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all tasks/events/reminders");

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(schedules.getScheduledItem({ id: task.id, ownerId })?.status).toBe("active");
    expect(schedules.getScheduledItem({ id: reminder.id, ownerId })?.status).toBe("active");
    expect(gateway.deleteCalls).toHaveLength(0);
    const id = confirmationId(request.replies.join(" "));
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: task.id, ownerId })?.status).toBe("cancelled");
    expect(schedules.getScheduledItem({ id: reminder.id, ownerId })?.status).toBe("cancelled");
    expect(gateway.deleteCalls.map((call) => call.eventId)).toEqual(["all-category-event"]);
    schedules.close();
  });

  it("only targets strictly future records for unscoped cleanup across every category", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const pastReminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T11:59:59.999Z"), id: "past-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-18", timeZone, title: "Past scheduled reminder",
    });
    const currentReminder = schedules.createScheduledItem({
      dueAt: now, id: "current-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-18", timeZone, title: "Current scheduled reminder",
    });
    const futureReminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T12:01:00.000Z"), id: "future-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-18", timeZone, title: "Future scheduled reminder",
    });
    const currentTask = schedules.createScheduledItem({
      id: "current-task", kind: "task", now, ownerId, scheduledDate: "2026-08-18", timeZone, title: "Current all-day task",
    });
    const futureTask = schedules.createScheduledItem({
      id: "future-task", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Future all-day task",
    });
    schedules.createScheduleSeries({
      id: "recurring-all-day-task", kind: "task", now, ownerId, recurrence: { frequency: "weekly", interval: 1, weekdays: [2] },
      startDate: "2026-08-18", timeZone, title: "Recurring all-day task",
    }, "2026-08-25");
    const recurringItems = schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-18",
      scheduledDateLatest: "2026-08-25",
    });
    const currentRecurring = recurringItems.find((item) =>
      item.seriesId === "recurring-all-day-task" && item.scheduledDate === "2026-08-18",
    );
    const futureRecurring = recurringItems.find((item) =>
      item.seriesId === "recurring-all-day-task" && item.scheduledDate === "2026-08-25",
    );
    if (!currentRecurring || !futureRecurring) {
      throw new Error("Expected current and future recurring all-day task occurrences");
    }
    state.legacy.set("current-legacy-reminder", {
      createdAt: now, dueAt: now, id: "current-legacy-reminder", ownerId, revision: 1,
      status: "active", timeZone, title: "Current legacy reminder", updatedAt: now,
    });
    state.legacy.set("future-legacy-reminder", {
      createdAt: now, dueAt: new Date("2026-08-18T12:01:00.000Z"), id: "future-legacy-reminder", ownerId, revision: 1,
      status: "active", timeZone, title: "Future legacy reminder", updatedAt: now,
    });
    const gateway = new FakeGateway();
    gateway.events = [
      calendarEvent({
        end: { date: "2026-08-19", kind: "all_day", timeZone }, id: "current-all-day-event",
        start: { date: "2026-08-18", kind: "all_day", timeZone }, summary: "Current all-day event",
      }),
      calendarEvent({
        end: { date: "2026-08-20", kind: "all_day", timeZone }, id: "future-all-day-event",
        start: { date: "2026-08-19", kind: "all_day", timeZone }, summary: "Future all-day event",
      }),
      calendarEvent({
        end: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone }, id: "event-starting-now",
        start: { dateTime: "2026-08-18T08:00:00.000-04:00", kind: "timed", timeZone }, summary: "Event starting now",
      }),
      calendarEvent({
        end: { dateTime: "2026-08-18T10:00:00.000-04:00", kind: "timed", timeZone }, id: "future-timed-event",
        start: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone }, summary: "Future timed event",
      }),
    ];
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all tasks/events/reminders");

    await instance.handle(request);

    const review = request.replies.join(" ");
    expect(state.pending.size).toBe(1);
    expect(review).not.toContain("Past scheduled reminder");
    expect(review).not.toContain("Current scheduled reminder");
    expect(review).not.toContain("Current all-day task");
    expect(review).not.toContain("Current legacy reminder");
    expect(review).not.toContain("Current all-day event");
    expect(review).not.toContain("Event starting now");
    expect(review).toContain("Future scheduled reminder");
    expect(review).toContain("Future all-day task");
    expect(review).toContain("Future legacy reminder");
    expect(review).toContain("Future all-day event");
    expect(review).toContain("Future timed event");
    const id = confirmationId(review);

    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: pastReminder.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: currentReminder.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: futureReminder.id, ownerId })).toMatchObject({ status: "cancelled" });
    expect(schedules.getScheduledItem({ id: currentTask.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: futureTask.id, ownerId })).toMatchObject({ status: "cancelled" });
    expect(schedules.getScheduledItem({ id: currentRecurring.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: futureRecurring.id, ownerId })).toMatchObject({ status: "cancelled" });
    expect(state.legacy.get("current-legacy-reminder")).toMatchObject({ status: "active" });
    expect(state.legacy.get("future-legacy-reminder")).toMatchObject({ status: "cancelled" });
    expect(gateway.deleteCalls.map((call) => call.eventId).sort()).toEqual([
      "future-all-day-event",
      "future-timed-event",
    ]);
    schedules.close();
  });

  it("does not delete unscoped targets that are no longer future at confirmation", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const reviewNow = new Date("2026-08-19T03:59:00.000Z");
    let currentNow = reviewNow;
    const timedReminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T04:00:00.000Z"), id: "aging-timed-reminder", kind: "reminder", now: reviewNow, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Aging timed reminder",
    });
    const allDayTask = schedules.createScheduledItem({
      id: "aging-all-day-task", kind: "task", now: reviewNow, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Aging all-day task",
    });
    schedules.createScheduleSeries({
      id: "aging-series", kind: "task", now: reviewNow, ownerId, recurrence: { frequency: "weekly", interval: 1, weekdays: [3] },
      startDate: "2026-08-19", timeZone, title: "Aging recurring task",
    }, "2026-08-26");
    const seriesAnchor = schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    }).find((item) => item.seriesId === "aging-series");
    if (!seriesAnchor) {
      throw new Error("Expected the future recurring task occurrence");
    }
    state.legacy.set("aging-legacy-reminder", {
      createdAt: reviewNow, dueAt: new Date("2026-08-19T04:00:00.000Z"), id: "aging-legacy-reminder", ownerId, revision: 1,
      status: "active", timeZone, title: "Aging legacy reminder", updatedAt: reviewNow,
    });
    const gateway = new FakeGateway();
    gateway.events = [
      calendarEvent({
        end: { date: "2026-08-20", kind: "all_day", timeZone }, id: "aging-all-day-event",
        start: { date: "2026-08-19", kind: "all_day", timeZone }, summary: "Aging all-day event",
      }),
      calendarEvent({
        end: { dateTime: "2026-08-19T01:00:00.000-04:00", kind: "timed", timeZone }, id: "aging-timed-event",
        start: { dateTime: "2026-08-19T00:00:00.000-04:00", kind: "timed", timeZone }, summary: "Aging timed event",
      }),
      calendarEvent({
        end: { date: "2026-08-20", kind: "all_day", timeZone }, id: "aging-recurring-event", recurringEventId: "aging-calendar-series",
        start: { date: "2026-08-19", kind: "all_day", timeZone }, summary: "Aging recurring event",
      }),
    ];
    gateway.masters = [calendarEvent({
      calendarId: "team", etag: "aging-master-etag", id: "aging-calendar-series", recurrence: ["RRULE:FREQ=WEEKLY"],
      summary: "Aging recurring event",
    })];
    const instance = assistant({ gateway, now: () => currentNow, schedules, state });
    const request = message("delete all tasks/events/reminders");

    await instance.handle(request);

    const id = confirmationId(request.replies.join(" "));
    currentNow = new Date("2026-08-19T04:01:00.000Z");
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: timedReminder.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: allDayTask.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: seriesAnchor.id, ownerId })).toMatchObject({ status: "active" });
    expect(state.legacy.get("aging-legacy-reminder")).toMatchObject({ status: "active" });
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(gateway.truncateCalls).toHaveLength(0);
    schedules.close();
  });

  it("deletes one date-scoped scheduled item immediately without affecting another day", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const today = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T10:00:00.000Z"), id: "today-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-18", timeZone, title: "Call dentist",
    });
    const tomorrow = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T14:00:00.000Z"), id: "tomorrow-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Call dentist",
    });
    const instance = assistant({ schedules, state });
    const request = message("delete all tasks/events/reminders for today");

    await instance.handle(request);

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).not.toMatch(/confirm/i);
    expect(schedules.getScheduledItem({ id: today.id, ownerId })?.status).toBe("cancelled");
    expect(schedules.getScheduledItem({ id: tomorrow.id, ownerId })?.status).toBe("active");
    schedules.close();
  });

  it("requires confirmation when a date-scoped delete-all request matches multiple items", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const first = schedules.createScheduledItem({
      id: "today-task-one", kind: "task", now, ownerId, scheduledDate: "2026-08-18", timeZone, title: "First task",
    });
    const second = schedules.createScheduledItem({
      id: "today-task-two", kind: "task", now, ownerId, scheduledDate: "2026-08-18", timeZone, title: "Second task",
    });
    const tomorrow = schedules.createScheduledItem({
      id: "tomorrow-task", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone, title: "Tomorrow task",
    });
    let currentNow = now;
    const instance = assistant({ now: () => currentNow, schedules, state });
    const request = message("delete all tasks for today");

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(schedules.getScheduledItem({ id: first.id, ownerId })?.status).toBe("active");
    expect(schedules.getScheduledItem({ id: second.id, ownerId })?.status).toBe("active");
    const id = confirmationId(request.replies.join(" "));
    currentNow = new Date(now.valueOf() + 60_000);
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(schedules.getScheduledItem({ id: first.id, ownerId })?.status).toBe("cancelled");
    expect(schedules.getScheduledItem({ id: second.id, ownerId })?.status).toBe("cancelled");
    expect(schedules.getScheduledItem({ id: tomorrow.id, ownerId })?.status).toBe("active");
    schedules.close();
  });

  it("treats legacy timed records as reminders for type-specific deletion", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    state.legacy.set("legacy-dentist", {
      createdAt: now,
      dueAt: new Date("2026-08-19T14:00:00.000Z"),
      id: "legacy-dentist",
      ownerId,
      revision: 1,
      status: "active",
      timeZone,
      title: "Call dentist",
      updatedAt: now,
    });
    const instance = assistant({ schedules, state });
    const taskRequest = message("delete task dentist");

    await instance.handle(taskRequest);

    expect(state.pending.size).toBe(0);
    expect(taskRequest.replies.join(" ")).toMatch(/no future active tasks/i);
    expect(state.legacy.get("legacy-dentist")?.status).toBe("active");

    await instance.handle(message("delete reminder dentist"));

    expect(state.legacy.get("legacy-dentist")?.status).toBe("cancelled");
    schedules.close();
  });

  it.each([
    ["date-scoped bulk cleanup", "delete all events for today"],
    ["named cleanup", "delete event planning"],
  ])("requires confirmation before deleting a guest event through %s", async (_flow, command) => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = [calendarEvent({
      attendees: [{ email: "guest@example.com", self: false }],
      end: { dateTime: "2026-08-18T10:00:00.000-04:00", kind: "timed", timeZone },
      id: "guest-event",
      start: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone },
      summary: "Planning",
    })];
    const instance = assistant({ gateway, schedules, state });
    const request = message(command);

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(request.replies.join(" ")).toMatch(/guests will be notified/i);
    expect(gateway.deleteCalls).toHaveLength(0);
    const id = confirmationId(request.replies.join(" "));
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(gateway.deleteCalls).toEqual([expect.objectContaining({ eventId: "guest-event", sendUpdates: "all" })]);
    schedules.close();
  });

  it("deletes a uniquely named reminder immediately and leaves nonmatches active", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const dentist = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T14:00:00.000Z"), id: "dentist-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Call dentist",
    });
    const doctor = schedules.createScheduledItem({
      dueAt: new Date("2026-08-19T15:00:00.000Z"), id: "doctor-reminder", kind: "reminder", now, ownerId,
      scheduledDate: "2026-08-19", timeZone, title: "Call doctor",
    });
    const instance = assistant({ schedules, state });

    await instance.handle(message("delete reminder dentist"));

    expect(state.pending.size).toBe(0);
    expect(schedules.getScheduledItem({ id: dentist.id, ownerId })?.status).toBe("cancelled");
    expect(schedules.getScheduledItem({ id: doctor.id, ownerId })?.status).toBe("active");
    schedules.close();
  });

  it("deletes one date-scoped Calendar event immediately", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = [calendarEvent({
      end: { dateTime: "2026-08-18T10:00:00.000-04:00", kind: "timed", timeZone },
      id: "today-event",
      start: { dateTime: "2026-08-18T09:00:00.000-04:00", kind: "timed", timeZone },
      summary: "Planning",
    })];
    const instance = assistant({ gateway, schedules, state });

    await instance.handle(message("delete all events for today"));

    expect(state.pending.size).toBe(0);
    expect(gateway.deleteCalls).toHaveLength(1);
    expect(gateway.deleteCalls[0]?.eventId).toBe("today-event");
    schedules.close();
  });

  it("requires confirmation for a date-scoped Calendar event that crosses a date boundary", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = [calendarEvent({
      end: { dateTime: "2026-08-18T01:00:00.000-04:00", kind: "timed", timeZone },
      id: "overnight-event",
      start: { dateTime: "2026-08-17T23:30:00.000-04:00", kind: "timed", timeZone },
      summary: "Overnight maintenance",
    })];
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all events for today");

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(request.replies.join(" ")).toMatch(/spans multiple dates/i);
    expect(gateway.deleteCalls).toHaveLength(0);
    const id = confirmationId(request.replies.join(" "));
    await instance.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

    expect(gateway.deleteCalls.map((call) => call.eventId)).toEqual(["overnight-event"]);
    schedules.close();
  });

  it("requires confirmation for a multi-day all-day Calendar event", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = [calendarEvent({
      end: { date: "2026-08-20", kind: "all_day", timeZone },
      id: "multi-day-event",
      start: { date: "2026-08-18", kind: "all_day", timeZone },
      summary: "Conference",
    })];
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all events for today");

    await instance.handle(request);

    expect(state.pending.size).toBe(1);
    expect(request.replies.join(" ")).toMatch(/spans multiple dates/i);
    expect(gateway.deleteCalls).toHaveLength(0);
    schedules.close();
  });

  it("rejects an oversized Calendar cleanup before storing confirmation", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = Array.from({ length: MAX_BULK_SCHEDULE_CANCELLATIONS + 1 }, (_, index) => calendarEvent({
      etag: `bulk-calendar-etag-${index}`,
      id: `bulk-calendar-${index}`,
      summary: "Bulk Calendar Event",
    }));
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all events");

    await instance.handle(request);

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(gateway.truncateCalls).toHaveLength(0);
    schedules.close();
  });

  it("rejects an oversized recurring-series cleanup before storing confirmation", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const seriesOccurrences = Array.from({ length: MAX_BULK_SCHEDULE_CANCELLATIONS + 1 }, (_, index) => ({
      createdAt: now,
      id: `bulk-series-item-${index}`,
      kind: "task" as const,
      ownerId,
      revision: 1,
      scheduledDate: "2026-08-19",
      seriesId: `bulk-series-${index}`,
      status: "active" as const,
      timeZone,
      title: "Bulk recurring task",
      updatedAt: now,
    }));
    const listActiveScheduledItems = vi.spyOn(schedules, "listActiveScheduledItems").mockReturnValue(seriesOccurrences);
    const cancelScheduleSeries = vi.spyOn(schedules, "cancelScheduleSeries");
    const instance = assistant({ schedules, state });
    const request = message("delete all tasks");

    await instance.handle(request);

    expect(listActiveScheduledItems).toHaveBeenCalledTimes(1);
    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(cancelScheduleSeries).not.toHaveBeenCalled();
    listActiveScheduledItems.mockRestore();
    cancelScheduleSeries.mockRestore();
    schedules.close();
  });

  it("rejects a mixed cleanup whose total exceeds the shared cancellation cap", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    const localItems = Array.from({ length: 500 }, (_, index) => ({
      createdAt: now,
      id: `bulk-mixed-item-${index}`,
      kind: "task" as const,
      ownerId,
      revision: 1,
      scheduledDate: "2026-08-19",
      status: "active" as const,
      timeZone,
      title: "Bulk mixed task",
      updatedAt: now,
    }));
    vi.spyOn(schedules, "listActiveScheduledItems").mockReturnValue(localItems);
    gateway.events = Array.from({ length: 501 }, (_, index) => calendarEvent({
      etag: `bulk-mixed-calendar-etag-${index}`,
      id: `bulk-mixed-calendar-${index}`,
      summary: "Bulk mixed event",
    }));
    const instance = assistant({ gateway, schedules, state });
    const request = message("delete all tasks/events/reminders");

    await instance.handle(request);

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(gateway.deleteCalls).toHaveLength(0);
    schedules.close();
  });

  it("fails closed for persisted Calendar cleanup targets without a valid explicit scope", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    gateway.events = [
      calendarEvent({ id: "blocked-calendar-event", summary: "Blocked calendar event" }),
      calendarEvent({
        id: "blocked-recurring-event",
        recurringEventId: "blocked-series",
        summary: "Blocked recurring calendar event",
      }),
    ];
    gateway.masters = [calendarEvent({
      etag: "blocked-master-etag",
      id: "blocked-series",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      summary: "Blocked recurring calendar event",
    })];
    const instance = assistant({ gateway, schedules, state });
    const router = new OwnerCommandRouter({
      ownerId,
      scheduleAssistant: instance,
      stateRepository: {
        getPendingAction: ({ id, now: requestedAt, ownerId: requestedOwner }) => {
          const pending = state.pending.get(id);
          return pending && pending.expiresAt > requestedAt && requestedOwner === ownerId
            ? {
              createdAt: now,
              expiresAt: pending.expiresAt,
              id,
              ownerId,
              payload: pending.payload,
            }
            : undefined;
        },
      },
    });
    const invalidTargets: readonly unknown[] = [
      {
        calendarId: "team",
        etag: "event-etag",
        eventId: "blocked-calendar-event",
        hasExternalGuests: false,
        summary: "Blocked calendar event",
      },
      {
        calendarId: "team",
        etag: "event-etag",
        eventId: "blocked-calendar-event",
        hasExternalGuests: false,
        scope: "unsupported",
        summary: "Blocked calendar event",
      },
      {
        calendarId: "team",
        etag: "event-etag",
        eventId: "blocked-calendar-event",
        hasExternalGuests: false,
        recurringEventId: "",
        scope: "all_future",
        summary: "Blocked calendar event",
      },
      {
        calendarId: "team",
        etag: "event-etag",
        eventId: "blocked-calendar-event",
        hasExternalGuests: false,
        recurringEventId: "blocked-series",
        scope: "all_future",
        summary: "Blocked calendar event",
      },
    ];

    for (const [index, calendarEventTarget] of invalidTargets.entries()) {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      state.pending.set(id, {
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        payload: {
          calendarEvents: [calendarEventTarget],
          cleanupScope: "unscoped_future",
          items: [],
          kind: "schedule_cleanup",
          legacyItems: [],
          series: [],
        },
      });
      const request = message(`confirm ${id}`);

      await router.handle(request);

      expect(request.replies).toEqual(["That confirmation is invalid or has expired."]);
    }

    const mismatchedScopes: readonly {
      readonly calendarEventTarget: unknown;
      readonly cleanupScope: "date_scoped" | "unscoped_future";
    }[] = [
        {
          calendarEventTarget: {
            calendarId: "team",
            etag: "event-etag",
            eventId: "blocked-calendar-event",
            hasExternalGuests: false,
            scope: "this_instance",
            summary: "Blocked calendar event",
          },
          cleanupScope: "unscoped_future",
        },
        {
          calendarEventTarget: {
            calendarId: "team",
            etag: "event-etag",
            eventId: "blocked-recurring-event",
            expectedMasterEtag: "blocked-master-etag",
            hasExternalGuests: false,
            recurringEventId: "blocked-series",
            scope: "all_future",
            summary: "Blocked recurring calendar event",
          },
          cleanupScope: "date_scoped",
        },
      ];
    for (const [index, { calendarEventTarget, cleanupScope }] of mismatchedScopes.entries()) {
      const id = `00000000-0000-4000-8000-00000000000${index + 5}`;
      state.pending.set(id, {
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        payload: {
          calendarEvents: [calendarEventTarget],
          cleanupScope,
          items: [],
          kind: "schedule_cleanup",
          legacyItems: [],
          series: [],
        },
      });
      const request = message(`confirm ${id}`);

      await router.handle(request);

      expect(request.replies).toEqual(["That confirmation is invalid or has expired."]);
    }

    const dateScopedSeries = schedules.createScheduleSeries({
      id: "blocked-date-scoped-series",
      kind: "task",
      now,
      ownerId,
      recurrence: { frequency: "weekly", interval: 1, weekdays: [3] },
      startDate: "2026-08-19",
      timeZone,
      title: "Blocked date-scoped series",
    }, "2026-08-26");
    const dateScopedSeriesAnchor = schedules.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    }).find((item) => item.seriesId === dateScopedSeries.id);
    if (!dateScopedSeriesAnchor) {
      throw new Error("Expected a materialized recurring occurrence");
    }
    const dateScopedSeriesId = "00000000-0000-4000-8000-000000000007";
    state.pending.set(dateScopedSeriesId, {
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      payload: {
        calendarEvents: [],
        cleanupScope: "date_scoped",
        items: [],
        kind: "schedule_cleanup",
        legacyItems: [],
        series: [{
          expectedRevision: dateScopedSeriesAnchor.revision,
          fromDate: dateScopedSeriesAnchor.scheduledDate,
          id: dateScopedSeriesAnchor.id,
          seriesId: dateScopedSeries.id,
          title: dateScopedSeries.title,
        }],
      },
    });
    const dateScopedSeriesConfirmation = message(`confirm ${dateScopedSeriesId}`);

    await router.handle(dateScopedSeriesConfirmation);

    expect(dateScopedSeriesConfirmation.replies).toEqual(["That confirmation is invalid or has expired."]);
    expect(schedules.getScheduleSeries({ id: dateScopedSeries.id, ownerId })).toMatchObject({ status: "active" });
    expect(schedules.getScheduledItem({ id: dateScopedSeriesAnchor.id, ownerId })).toMatchObject({ status: "active" });

    const omittedRecurrenceId = "00000000-0000-4000-8000-000000000004";
    state.pending.set(omittedRecurrenceId, {
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      payload: {
        calendarEvents: [{
          calendarId: "team",
          etag: "event-etag",
          eventId: "blocked-recurring-event",
          hasExternalGuests: false,
          scope: "all_future",
          summary: "Blocked recurring calendar event",
        }],
        cleanupScope: "unscoped_future",
        items: [],
        kind: "schedule_cleanup",
        legacyItems: [],
        series: [],
      },
    });
    const omittedRecurrenceConfirmation = message(`confirm ${omittedRecurrenceId}`);

    await router.handle(omittedRecurrenceConfirmation);

    expect(omittedRecurrenceConfirmation.replies).toEqual([
      "Cancelled or deleted 0 items; 1 item changed or could not be removed.",
    ]);
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(gateway.truncateCalls).toHaveLength(0);
    schedules.close();
  });

  it("rejects an oversized stored cleanup before any target can be changed", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    const protectedItem = schedules.createScheduledItem({
      id: "protected-item",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone,
      title: "Protected task",
    });
    const id = "11111111-1111-4111-8111-111111111111";
    state.createPendingAction({
      expiresAt: new Date(now.valueOf() + 60_000),
      id,
      ownerId,
      payload: {
        calendarEvents: Array.from({ length: MAX_BULK_SCHEDULE_CANCELLATIONS }, (_, index) => ({
          calendarId: "team",
          etag: `stored-calendar-etag-${index}`,
          eventId: `stored-calendar-${index}`,
          hasExternalGuests: false,
          scope: "all_future",
          summary: "Stored calendar event",
        })),
        cleanupScope: "unscoped_future",
        items: [{ expectedRevision: protectedItem.revision, id: protectedItem.id }],
        kind: "schedule_cleanup",
        legacyItems: [],
        series: [],
      },
    });
    const instance = assistant({ gateway, schedules, state });
    const request = message(`confirm ${id}`);

    await instance.handlePendingAction(request, { actionId: id, kind: "confirm" });

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(schedules.getScheduledItem({ id: protectedItem.id, ownerId })?.status).toBe("active");
    expect(gateway.deleteCalls).toHaveLength(0);
    schedules.close();
  });

  it("rejects an oversized new scheduled-item cleanup before storing confirmation", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    for (let index = 0; index <= MAX_BULK_SCHEDULE_CANCELLATIONS; index += 1) {
      schedules.createScheduledItem({
        id: `bulk-scheduled-${index}`,
        kind: "task",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Bulk scheduled task",
      });
    }
    const instance = assistant({ schedules, state });
    const request = message("delete all tasks");

    await instance.handle(request);

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(schedules.getScheduledItem({ id: "bulk-scheduled-1000", ownerId })?.status).toBe("active");
    schedules.close();
  });

  it("rejects an oversized legacy reminder cleanup instead of silently omitting later reminders", async () => {
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    const state = new FakeState();
    const dueAt = new Date("2026-08-19T14:00:00.000Z");
    for (let index = 0; index <= MAX_BULK_LOCAL_TASK_CANCELLATIONS; index += 1) {
      state.legacy.set(`bulk-legacy-${index}`, {
        createdAt: now,
        dueAt,
        id: `bulk-legacy-${index}`,
        ownerId,
        revision: 1,
        status: "active",
        timeZone,
        title: "Bulk legacy reminder",
        updatedAt: now,
      });
    }
    const instance = assistant({ schedules, state });
    const request = message("delete all reminders");

    await instance.handle(request);

    expect(state.pending.size).toBe(0);
    expect(request.replies.join(" ")).toMatch(/more than 1000 matching scheduled items/i);
    expect(state.legacy.get("bulk-legacy-1000")?.status).toBe("active");
    schedules.close();
  });
});


describe("ScheduleAssistant named-delete routing integration", () => {
  it.each([
    {
      id: "integration-play-reminder",
      label: "the concrete lowercase selector",
      message: "delete play among us",
      selectorTitle: "play among us",
    },
    {
      id: "integration-play-reminder-punctuation",
      label: "punctuation and generic-word normalization",
      message: "delete the PLAY, among us",
      selectorTitle: "the PLAY, among us",
    },
    {
      id: "integration-play-reminder-case",
      label: "case normalization",
      message: "delete PLAY AMONG US!",
      selectorTitle: "PLAY AMONG US!",
    },
  ])("resolves the reminder represented by 'can you remind me in 30 min to play among us' for $label", async ({ id, message: requestText, selectorTitle }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "z".repeat(48) });
    const state = new FakeState();
    const gateway = new FakeGateway();
    const listActiveScheduledItems = vi.spyOn(schedules, "listActiveScheduledItems");
    const createPendingAction = vi.spyOn(state, "createPendingAction");
    const listCalendars = vi.spyOn(gateway, "listCalendars");
    const reminder = schedules.createScheduledItem({
      // This is the active repository state represented by:
      // "can you remind me in 30 min to play among us".
      dueAt: new Date("2026-08-18T12:30:00.000Z"),
      id,
      kind: "reminder",
      now,
      ownerId,
      scheduledDate: "2026-08-18",
      timeZone,
      title: "play among us",
    });
    const unrelatedReminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T12:35:00.000Z"),
      id: `${id}-unrelated`,
      kind: "reminder",
      now,
      ownerId,
      scheduledDate: "2026-08-18",
      timeZone,
      title: "play outside",
    });
    const foreignReminder = schedules.createScheduledItem({
      dueAt: new Date("2026-08-18T12:40:00.000Z"),
      id: `${id}-foreign`,
      kind: "reminder",
      now,
      ownerId: "987654321098765432",
      scheduledDate: "2026-08-18",
      timeZone,
      title: "play among us",
    });
    const legacyTask: LocalTask = {
      createdAt: now,
      dueAt: new Date("2026-08-18T12:45:00.000Z"),
      id: `${id}-legacy`,
      ownerId,
      revision: 1,
      status: "active",
      timeZone,
      title: "play among us",
      updatedAt: now,
    };
    state.legacy.set(legacyTask.id, legacyTask);
    const action = {
      action: "delete_task" as const,
      scope: "single" as const,
      selector: { title: selectorTitle },
    };
    const localTaskAssistant = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => undefined),
      handleNaturalLanguage: vi.fn(async () => undefined),
      handleNaturalLanguageAction: vi.fn(async () => undefined),
      handlePendingAction: vi.fn(async () => false),
      isTaskInput: vi.fn(() => false),
    };
    const planner = { plan: vi.fn(async () => action) };
    const scheduleAssistant = assistant({ gateway, schedules, state });
    const router = new OwnerCommandRouter({
      localTaskAssistant,
      naturalLanguagePlanner: planner,
      ownerId,
      scheduleAssistant,
      stateRepository: state,
      taskTimeZone: timeZone,
    });

    try {
      const request = message(requestText);
      await router.handle(request);

      expect(planner.plan).toHaveBeenCalledTimes(1);
      expect(listActiveScheduledItems).toHaveBeenCalledWith(expect.objectContaining({
        kinds: ["reminder"],
        ownerId,
        scheduledDateEarliest: "2026-08-18",
      }));
      expect(localTaskAssistant.handleNaturalLanguageAction).not.toHaveBeenCalled();
      expect(request.replies.join(" ")).toMatch(/Review matches[\s\S]*play among us/iu);
      expect(request.replies.join(" ")).toMatch(/requires confirmation|Reply confirm/iu);
      expect(createPendingAction).toHaveBeenCalledTimes(1);

      const pendingRequest = createPendingAction.mock.calls[0]?.[0];
      expect(pendingRequest?.ownerId).toBe(ownerId);
      expect(pendingRequest?.payload).toMatchObject({
        calendarEvents: [],
        cleanupScope: "unscoped_future",
        items: [{ expectedRevision: reminder.revision, id: reminder.id }],
        kind: "schedule_cleanup",
        legacyItems: [],
        responseSource: "gemini",
        series: [],
      });
      expect((pendingRequest?.payload as { items: readonly unknown[] }).items).toEqual([
        { expectedRevision: reminder.revision, id: reminder.id },
      ]);
      expect(listCalendars).not.toHaveBeenCalled();
      expect(gateway.deleteCalls).toEqual([]);
      expect(reminder.dueAt).toEqual(new Date("2026-08-18T12:30:00.000Z"));
      expect(schedules.getScheduledItem({ id: reminder.id, ownerId })).toMatchObject({
        revision: 1,
        status: "active",
        title: "play among us",
      });
      expect(schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId })).toMatchObject({ status: "active" });
      expect(schedules.getScheduledItem({ id: foreignReminder.id, ownerId: foreignReminder.ownerId })).toMatchObject({ status: "active" });
      expect(state.getLocalTask({ id: legacyTask.id, ownerId })).toMatchObject({ revision: 1, status: "active" });

      const confirmation = confirmationId(request.replies.join(" "));
      await router.handle(message(`confirm ${confirmation}`));

      expect(schedules.getScheduledItem({ id: reminder.id, ownerId })).toMatchObject({ status: "cancelled", revision: 2 });
      expect(schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId })).toMatchObject({ status: "active", revision: 1 });
      expect(schedules.getScheduledItem({ id: foreignReminder.id, ownerId: foreignReminder.ownerId })).toMatchObject({ status: "active", revision: 1 });
      expect(state.getLocalTask({ id: legacyTask.id, ownerId })).toMatchObject({ revision: 1, status: "active" });
      expect(gateway.deleteCalls).toEqual([]);
    } finally {
      listActiveScheduledItems.mockRestore();
      createPendingAction.mockRestore();
      listCalendars.mockRestore();
      schedules.close();
      vi.useRealTimers();
    }
  });

  /*
   * Recorded unfixed counterexample (before schedule-first routing):
   * owner 123456789012345678, clock 2026-08-18T12:00:00.000Z,
   * America/Toronto, reminder integration-play-reminder titled "play among us"
   * (active, due 2026-08-18T12:30:00.000Z), and validated action
   * { action: "delete_task", scope: "single", selector: { title: "play among us" } }
   * sent through OwnerCommandRouter. LocalTaskAssistant-only routing returned
   * "I could not find an active local task matching that description.", left the
   * scheduled item active, created no schedule_cleanup pending action, and made
   * no Calendar operation. The parameterized regression above is the fixed
   * version of that same case and its punctuation/case variants.
   */
});
