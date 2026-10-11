import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarAssistant } from "../src/application/calendar-assistant.js";
import {
  NamedDeleteHandler,
  type NamedDeleteAction,
} from "../src/application/named-delete-handler.js";
import {
  isNamedDeleteCalendarEventForDate,
  namedDeleteTitleMatches,
  NamedDeleteResolver,
  normalizeNamedDeleteSelector,
  type CalendarEventCandidate,
  type LegacyTaskCandidate,
  type NamedDeleteResolution,
  type ScheduledReminderCandidate,
} from "../src/application/named-delete-resolver.js";
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
import { ScheduleAssistant } from "../src/scheduling/schedule-assistant.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";
import { LocalTaskAssistant } from "../src/tasks/local-task-assistant.js";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");
let messageNumber = 0;

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  messageNumber += 1;
  return {
    authorId: ownerId,
    content,
    id: `named-delete-${messageNumber}`,
    replies,
    reply: async (reply) => {
      replies.push(reply);
    },
  };
}

function action(title: string, date?: string): NamedDeleteAction {
  return {
    action: "delete_task",
    ...(date ? { date } : {}),
    scope: "single",
    selector: { title },
  };
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "secondary",
    end: { dateTime: "2026-08-19T13:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    etag: "etag-play",
    id: "calendar-play",
    start: { dateTime: "2026-08-19T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    status: "confirmed",
    summary: "Play among us",
    ...overrides,
  };
}

class TestCalendarGateway implements CalendarGateway {
  public calendars: CalendarReference[] = [
    { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone },
    { id: "secondary", isPrimary: false, readOnly: false, summary: "Secondary", timeZone: "America/New_York" },
  ];
  public events: CalendarEvent[] = [];
  public readonly eventReads: ListCalendarEventsInput[] = [];
  public readonly deleteCalls: DeleteCalendarEventInput[] = [];
  public failListCalendars = false;
  public failListEvents = false;

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    if (this.failListCalendars) {
      throw new Error("calendar unavailable");
    }
    return this.calendars;
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    this.eventReads.push(input);
    if (this.failListEvents) {
      throw new Error("calendar events unavailable");
    }
    return this.events.filter((event) => event.calendarId === input.calendarId);
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const event = this.events.find((item) => item.calendarId === input.calendarId && item.id === input.eventId);
    if (!event) {
      throw new Error("event unavailable");
    }
    return event;
  }

  public async createEvent(_input: CreateCalendarEventInput): Promise<CalendarEvent> {
    throw new Error("not used");
  }

  public async updateEvent(_input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    throw new Error("not used");
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    this.deleteCalls.push(input);
    this.events = this.events.filter((event) => event.id !== input.eventId);
  }

  public async splitRecurringEvent(_input: SplitRecurringEventInput): Promise<CalendarEvent> {
    throw new Error("not used");
  }

  public async truncateRecurringEvent(_input: TruncateRecurringEventInput): Promise<void> {
    throw new Error("not used");
  }
}

function createResolver(
  stateRepository: AppStateRepository,
  schedulingRepository: SchedulingRepository,
  calendarGateway?: TestCalendarGateway,
): NamedDeleteResolver {
  return new NamedDeleteResolver({
    ...(calendarGateway ? { calendarGateway } : {}),
    ownerId,
    schedulingRepository,
    stateRepository,
    timeZone,
  });
}

function closeRepositories(state: AppStateRepository, schedules: SchedulingRepository): void {
  schedules.close();
  state.close();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical named-delete selector", () => {
  it("normalizes Unicode, punctuation, generic words, dates, and duplicate terms", () => {
    expect(normalizeNamedDeleteSelector({
      date: "2026-08-19",
      now,
      timeZone,
      title: "Ｔhe  Play, among-us play on 2026-08-19",
    })).toEqual({ date: "2026-08-19", terms: ["play", "among", "us"] });
    expect(namedDeleteTitleMatches("PLAY among us tonight", ["play", "among", "us"])).toBe(true);
    expect(namedDeleteTitleMatches("runner among us", ["run"])).toBe(false);
    expect(normalizeNamedDeleteSelector({ now, timeZone, title: "the reminder today" })).toBeUndefined();
    expect(normalizeNamedDeleteSelector({ now, timeZone, title: "a task to" })).toBeUndefined();
  });

  it("requires all selector terms to be complete candidate tokens", () => {
    expect(namedDeleteTitleMatches("Call the dentist tomorrow", ["call", "dentist"])).toBe(true);
    expect(namedDeleteTitleMatches("Call the dentist tomorrow", ["dent"])).toBe(false);
    expect(namedDeleteTitleMatches("mañana café 42", ["café", "42"])).toBe(true);
  });
});

describe("NamedDeleteResolver", () => {
  it("reads every configured domain and preserves cross-domain candidates", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "a".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "b".repeat(48) });
    const gateway = new TestCalendarGateway();
    gateway.events = [calendarEvent()];
    try {
      state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "legacy-play",
        now,
        ownerId,
        timeZone,
        title: "Play among us",
      });
      schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "reminder-play",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });

      const result = await createResolver(state, schedules, gateway).resolve({
        now,
        ownerId,
        selectorTitle: "the play among-us",
        source: "gemini",
        timeZone,
      });

      expect(result.status).toBe("ambiguous");
      expect(result.candidates.map((candidate) => candidate.domain)).toEqual([
        "legacy_task",
        "scheduled_reminder",
        "calendar_event",
      ]);
      expect(result.sources).toEqual({ calendar: "complete", legacyTasks: "complete", scheduledReminders: "complete" });
      expect(gateway.eventReads.map((read) => read.calendarId)).toEqual(["primary", "secondary"]);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("blocks a local match when a configured Calendar read fails", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "c".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "d".repeat(48) });
    const gateway = new TestCalendarGateway();
    gateway.failListCalendars = true;
    try {
      state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "legacy-only",
        now,
        ownerId,
        timeZone,
        title: "Play among us",
      });
      const result = await createResolver(state, schedules, gateway).resolve({
        now,
        ownerId,
        selectorTitle: "play among us",
        source: "gemini",
        timeZone,
      });
      expect(result).toMatchObject({ status: "read_failure", candidates: [], sources: { calendar: "failed" } });
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("skips an unconfigured Calendar source and applies date overlap rules", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "e".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "f".repeat(48) });
    try {
      const event = calendarEvent({
        end: { date: "2026-08-20", kind: "all_day", timeZone: "America/New_York" },
        start: { date: "2026-08-19", kind: "all_day", timeZone: "America/New_York" },
      });
      expect(isNamedDeleteCalendarEventForDate(event, {
        id: "secondary",
        isPrimary: false,
        readOnly: false,
        summary: "Secondary",
        timeZone: "America/New_York",
      }, "2026-08-19")).toBe(true);

      schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "reminder-only",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });
      const result = await createResolver(state, schedules).resolve({
        now,
        ownerId,
        selectorTitle: "play among us",
        source: "gemini",
        timeZone,
      });
      expect(result.status).toBe("exact");
      expect(result.sources.calendar).toBe("skipped");
      expect(result.candidate.domain).toBe("scheduled_reminder");
    } finally {
      closeRepositories(state, schedules);
    }
  });
});

describe("single named-delete bug-condition exploration", () => {
  // **Validates: Requirements 1.1, 1.2**
  it.each([
    { domain: "scheduled_reminder" as const, label: "an exact private one-time reminder" },
    { domain: "calendar_event" as const, label: "an exact private non-recurring Calendar event" },
  ])("expects direct mutation for $label", async ({ domain }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "exploration-state".repeat(4) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "exploration-schedules".repeat(4) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");

    try {
      if (domain === "scheduled_reminder") {
        const reminder = schedules.createScheduledItem({
          dueAt: new Date("2026-08-19T15:00:00.000Z"),
          id: "exploration-private-reminder",
          kind: "reminder",
          now,
          ownerId,
          scheduledDate: "2026-08-19",
          timeZone,
          title: "Play among us",
        });
        const unrelatedReminder = schedules.createScheduledItem({
          dueAt: new Date("2026-08-19T16:00:00.000Z"),
          id: "exploration-unrelated-reminder",
          kind: "reminder",
          now,
          ownerId,
          scheduledDate: "2026-08-19",
          timeZone,
          title: "Unrelated reminder",
        });
        const unrelatedTask = state.createLocalTask({
          dueAt: new Date("2026-08-19T17:00:00.000Z"),
          id: "exploration-unrelated-task",
          now,
          ownerId,
          timeZone,
          title: "Unrelated task",
        });
        gateway.events = [calendarEvent({ id: "exploration-unrelated-event", summary: "Unrelated event" })];
        const reminderBefore = schedules.getScheduledItem({ id: reminder.id, ownerId });
        const unrelatedReminderBefore = schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId });
        const unrelatedTaskBefore = state.getLocalTask({ id: unrelatedTask.id, ownerId });
        if (!reminderBefore || !unrelatedReminderBefore || !unrelatedTaskBefore) {
          throw new Error("Exploration fixture was not persisted");
        }

        const scheduleAssistant = new ScheduleAssistant({
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          schedulingRepository: schedules,
          stateRepository: state,
          timeZone,
        });
        const handler = new NamedDeleteHandler({
          now: () => now,
          ownerId,
          resolver: createResolver(state, schedules, gateway),
          scheduleAssistant,
          schedulingRepository: schedules,
          stateRepository: state,
          timeZone,
        });
        const request = message("delete play among us");
        await handler.handleNaturalLanguageAction(request, action("play among us"));

        const reminderAfter = schedules.getScheduledItem({ id: reminder.id, ownerId });
        const reply = request.replies.join("\n");
        const confirmationId = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
        expect.soft(pendingAction).not.toHaveBeenCalled();
        expect.soft(confirmationId).toBeUndefined();
        expect.soft(reply).not.toMatch(/(?:confirm|Review:)/iu);
        expect.soft(reminderAfter?.status).toBe("cancelled");
        expect.soft(reminderAfter?.revision).toBe(reminderBefore.revision + 1);
        expect.soft(reminderAfter?.cancelledAt).toEqual(now);
        expect.soft(reminderAfter?.updatedAt).toEqual(now);
        expect.soft(reminderAfter).toMatchObject({
          createdAt: reminderBefore.createdAt,
          dueAt: reminderBefore.dueAt,
          id: reminderBefore.id,
          kind: reminderBefore.kind,
          ownerId: reminderBefore.ownerId,
          scheduledDate: reminderBefore.scheduledDate,
          timeZone: reminderBefore.timeZone,
          title: reminderBefore.title,
        });
        expect.soft(reminderAfter?.seriesId).toBeUndefined();
        expect.soft(reminderAfter?.occurrenceKey).toBeUndefined();
        expect.soft(schedules.listDueScheduledReminders({
          dueAtEarliest: now,
          dueAtLatest: new Date("2026-08-20T00:00:00.000Z"),
          ownerId,
        }).map((item) => item.id)).not.toContain(reminder.id);
        expect.soft(unrelatedReminderBefore && schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId })).toEqual(unrelatedReminderBefore);
        expect.soft(unrelatedTaskBefore && state.getLocalTask({ id: unrelatedTask.id, ownerId })).toEqual(unrelatedTaskBefore);
        expect.soft(gateway.deleteCalls).toHaveLength(0);
        return;
      }

      const calendarTarget = calendarEvent({
        etag: "exploration-private-etag",
        id: "exploration-private-calendar-event",
      });
      const unrelatedEvent = calendarEvent({
        etag: "exploration-unrelated-etag",
        id: "exploration-unrelated-calendar-event",
        start: { dateTime: "2026-08-20T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        end: { dateTime: "2026-08-20T13:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        summary: "Unrelated event",
      });
      gateway.events = [calendarTarget, unrelatedEvent];
      const unrelatedTask = state.createLocalTask({
        dueAt: new Date("2026-08-20T17:00:00.000Z"),
        id: "exploration-calendar-unrelated-task",
        now,
        ownerId,
        timeZone,
        title: "Unrelated task",
      });
      const unrelatedReminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-20T18:00:00.000Z"),
        id: "exploration-calendar-unrelated-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-20",
        timeZone,
        title: "Unrelated reminder",
      });
      const unrelatedEventBefore = { ...unrelatedEvent };
      const unrelatedTaskBefore = state.getLocalTask({ id: unrelatedTask.id, ownerId });
      const unrelatedReminderBefore = schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId });
      if (!unrelatedTaskBefore || !unrelatedReminderBefore) {
        throw new Error("Exploration fixture was not persisted");
      }

      const calendarAssistant = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant,
        calendarGateway: gateway,
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      const reply = request.replies.join("\n");
      const confirmationId = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
      expect.soft(pendingAction).not.toHaveBeenCalled();
      expect.soft(confirmationId).toBeUndefined();
      expect.soft(reply).not.toMatch(/(?:confirm|Review:)/iu);
      expect.soft(gateway.deleteCalls).toHaveLength(1);
      expect.soft(gateway.deleteCalls[0]).toMatchObject({
        calendarId: calendarTarget.calendarId,
        etag: calendarTarget.etag,
        eventId: calendarTarget.id,
        sendUpdates: "none",
      });
      expect.soft(gateway.events).not.toContainEqual(calendarTarget);
      expect.soft(gateway.events).toContainEqual(unrelatedEventBefore);
      expect.soft(state.getLocalTask({ id: unrelatedTask.id, ownerId })).toEqual(unrelatedTaskBefore);
      expect.soft(schedules.getScheduledItem({ id: unrelatedReminder.id, ownerId })).toEqual(unrelatedReminderBefore);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("preserves direct exact private local-task cancellation", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "exploration-local".repeat(4) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "exploration-local-schedules".repeat(4) });
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const task = state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "exploration-private-local-task",
        now,
        ownerId,
        timeZone,
        title: "Play among us",
      });
      const unrelated = state.createLocalTask({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "exploration-local-unrelated-task",
        now,
        ownerId,
        timeZone,
        title: "Unrelated task",
      });
      const taskBefore = state.getLocalTask({ id: task.id, ownerId });
      const unrelatedBefore = state.getLocalTask({ id: unrelated.id, ownerId });
      if (!taskBefore || !unrelatedBefore) {
        throw new Error("Exploration fixture was not persisted");
      }

      const localTaskAssistant = new LocalTaskAssistant({
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
        timeZone,
      });
      const handler = new NamedDeleteHandler({
        localTaskAssistant,
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      expect(pendingAction).not.toHaveBeenCalled();
      expect(request.replies).toEqual([expect.stringMatching(/^Cancelled local task: Play among us\.$/u)]);
      expect(request.replies.join(" ")).not.toMatch(/confirm|Review:/iu);
      expect(state.getLocalTask({ id: task.id, ownerId })).toMatchObject({ status: "cancelled", revision: 2 });
      expect(state.getLocalTask({ id: unrelated.id, ownerId })).toEqual(unrelatedBefore);
      expect(taskBefore.revision).toBe(1);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("retains confirmation and guest notification for an exact shared Calendar event", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "exploration-shared".repeat(4) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "exploration-shared-schedules".repeat(4) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const shared = calendarEvent({
        attendees: [{ email: "guest@example.com" }],
        etag: "exploration-shared-etag",
        id: "exploration-shared-calendar-event",
      });
      const unrelated = calendarEvent({
        etag: "exploration-shared-unrelated-etag",
        id: "exploration-shared-unrelated-event",
        summary: "Unrelated event",
      });
      gateway.events = [shared, unrelated];
      const sharedBefore = { ...shared };
      const unrelatedBefore = { ...unrelated };

      const calendarAssistant = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant,
        calendarGateway: gateway,
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      expect(pendingAction).toHaveBeenCalledTimes(1);
      const reply = request.replies.join(" ");
      const id = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
      expect(id).toBeDefined();
      if (!id) {
        throw new Error("Shared Calendar exploration did not return a confirmation identifier");
      }
      expect(state.getPendingAction({ id, now, ownerId })?.payload).toMatchObject({
        eventId: shared.id,
        expectedEtag: shared.etag,
        kind: "mutation",
        namedDelete: true,
        sendUpdates: "all",
      });
      expect(gateway.deleteCalls).toHaveLength(0);
      expect(gateway.events).toContainEqual(sharedBefore);
      expect(gateway.events).toContainEqual(unrelatedBefore);

      await calendarAssistant.handlePendingAction(message(`confirm ${id}`), { actionId: id, kind: "confirm" });

      expect(gateway.deleteCalls).toEqual([expect.objectContaining({
        eventId: shared.id,
        sendUpdates: "all",
      })]);
      expect(gateway.events).not.toContainEqual(sharedBefore);
      expect(gateway.events).toContainEqual(unrelatedBefore);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it.each([
    { label: "a series-linked reminder", seriesId: "exploration-series" },
    { label: "a materialized reminder occurrence", occurrenceKey: "2026-08-19T15:00:00.000Z", seriesId: "exploration-series" },
  ])("retains review for $label", async ({ occurrenceKey, seriesId }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "exploration-recurring".repeat(4) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "exploration-recurring-schedules".repeat(4) });
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      schedules.createScheduleSeries({
        id: seriesId,
        kind: "reminder",
        now,
        ownerId,
        recurrence: { frequency: "yearly", interval: 1 },
        startDate: "2026-08-19",
        startTime: "11:00",
        timeZone,
        title: "Unrelated recurring reminder",
      }, "2026-08-19");
      const reminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "exploration-recurring-reminder",
        kind: "reminder",
        now,
        ...(occurrenceKey ? { occurrenceKey } : {}),
        ownerId,
        scheduledDate: "2026-08-19",
        ...(seriesId ? { seriesId } : {}),
        timeZone,
        title: "Play among us",
      });
      const scheduleAssistant = new ScheduleAssistant({
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const handler = new NamedDeleteHandler({
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules),
        scheduleAssistant,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      expect(pendingAction).toHaveBeenCalledTimes(1);
      const reply = request.replies.join(" ");
      const id = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
      expect(id).toBeDefined();
      if (!id) {
        throw new Error("Recurring reminder exploration did not return a confirmation identifier");
      }
      expect(state.getPendingAction({ id, now, ownerId })?.payload).toMatchObject({
        items: [{ expectedRevision: reminder.revision, id: reminder.id }],
        kind: "schedule_cleanup",
      });
      expect(schedules.getScheduledItem({ id: reminder.id, ownerId })).toMatchObject({
        revision: 1,
        status: "active",
      });
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("fails closed when a one-time reminder revision changes after resolution", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "exploration-reminder-race".repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "exploration-reminder-race-schedules".repeat(3) });
    try {
      const reminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "exploration-reminder-revision-race",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });
      let current = reminder;
      const racedSchedules = {
        cancelScheduledItems: vi.fn(() => {
          throw new Error("The revision race should fail before cancellation.");
        }),
        ensureOccurrencesThrough: vi.fn(),
        getScheduledItem: vi.fn(({ id, ownerId: requestedOwnerId }: { id: string; ownerId: string }) =>
          id === reminder.id && requestedOwnerId === ownerId ? current : undefined),
        listActiveScheduledItems: vi.fn(() => {
          current = { ...reminder, revision: reminder.revision + 1 };
          return [reminder];
        }),
      } as unknown as SchedulingRepository;
      const pendingAction = vi.spyOn(state, "createPendingAction");
      const scheduleAssistant = new ScheduleAssistant({
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        schedulingRepository: racedSchedules,
        stateRepository: state,
        timeZone,
      });
      const handler = new NamedDeleteHandler({
        now: () => now,
        ownerId,
        resolver: createResolver(state, racedSchedules),
        scheduleAssistant,
        schedulingRepository: racedSchedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      expect(pendingAction).not.toHaveBeenCalled();
      expect(racedSchedules.cancelScheduledItems).not.toHaveBeenCalled();
      expect(request.replies.join(" ")).toMatch(/changed or could not be removed/i);
      expect(current).toMatchObject({ revision: reminder.revision + 1, status: "active" });
      expect(schedules.getScheduledItem({ id: reminder.id, ownerId })).toMatchObject({ revision: 1, status: "active" });
    } finally {
      closeRepositories(state, schedules);
    }
  });

  const calendarRaceFixtures = [
    { label: "gains an external attendee", mode: "sharing" as const },
    { label: "becomes recurring", mode: "recurrence" as const },
    { label: "changes its ETag", mode: "etag" as const },
    { label: "becomes read-only", mode: "access" as const },
    { label: "moves off the requested date", mode: "date" as const },
    { label: "is no longer in the future", mode: "future" as const },
  ] as const;

  it.each(calendarRaceFixtures)("does not auto-delete when a private Calendar target $label after resolution", async ({ mode }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: `exploration-calendar-${mode}`.repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: `exploration-calendar-${mode}-schedules`.repeat(3) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    let getEventSpy: ReturnType<typeof vi.spyOn> | undefined;
    let listCalendarsSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const target = calendarEvent({
        etag: `exploration-calendar-${mode}-etag`,
        id: `exploration-calendar-${mode}-target`,
      });
      const unrelated = calendarEvent({
        etag: `exploration-calendar-${mode}-unrelated-etag`,
        id: `exploration-calendar-${mode}-unrelated`,
        start: { dateTime: "2026-08-20T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        end: { dateTime: "2026-08-20T13:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        summary: "Unrelated event",
      });
      gateway.events = [target, unrelated];
      const unrelatedBefore = { ...unrelated };

      if (mode === "access") {
        const originalListCalendars = gateway.listCalendars.bind(gateway);
        let calendarReads = 0;
        listCalendarsSpy = vi.spyOn(gateway, "listCalendars").mockImplementation(async () => {
          calendarReads += 1;
          const calendars = await originalListCalendars();
          return calendarReads > 1
            ? calendars.map((calendar) => calendar.id === target.calendarId ? { ...calendar, readOnly: true } : calendar)
            : calendars;
        });
      } else {
        const originalGetEvent = gateway.getEvent.bind(gateway);
        getEventSpy = vi.spyOn(gateway, "getEvent").mockImplementation(async (input) => {
          gateway.events = gateway.events.map((event) => {
            if (event.id !== target.id) {
              return event;
            }
            if (mode === "sharing") {
              return { ...event, attendees: [{ email: "race-guest@example.com" }] };
            }
            if (mode === "recurrence") {
              return { ...event, recurrence: ["RRULE:FREQ=DAILY"] };
            }
            if (mode === "etag") {
              return { ...event, etag: `${event.etag}-changed` };
            }
            if (mode === "date") {
              return {
                ...event,
                end: { dateTime: "2026-08-20T13:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
                start: { dateTime: "2026-08-20T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
              };
            }
            return {
              ...event,
              end: { dateTime: "2026-08-18T07:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
              start: { dateTime: "2026-08-18T06:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
            };
          });
          return originalGetEvent(input);
        });
      }

      const calendarAssistant = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant,
        calendarGateway: gateway,
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message(mode === "date" ? "delete play among us on 2026-08-19" : "delete play among us");
      await handler.handleNaturalLanguageAction(
        request,
        action("play among us", mode === "date" ? "2026-08-19" : undefined),
      );

      expect(gateway.deleteCalls).toHaveLength(0);
      expect(gateway.events).toContainEqual(unrelatedBefore);
      if (mode === "sharing") {
        expect(pendingAction).toHaveBeenCalledTimes(1);
        const reply = request.replies.join(" ");
        const id = /confirm\s+([a-f0-9-]+)/iu.exec(reply)?.[1];
        expect(id).toBeDefined();
        expect(state.getPendingAction({ id: id!, now, ownerId })?.payload).toMatchObject({
          eventId: target.id,
          kind: "mutation",
          namedDelete: true,
          sendUpdates: "all",
        });
      } else {
        expect(pendingAction).not.toHaveBeenCalled();
        expect(request.replies.join(" ")).not.toMatch(/^Deleted /u);
      }
    } finally {
      getEventSpy?.mockRestore();
      listCalendarsSpy?.mockRestore();
      pendingAction.mockRestore();
      closeRepositories(state, schedules);
    }
  });
});

describe("NamedDeleteHandler", () => {
  it("routes an exact local candidate without searching by title again", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "g".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "h".repeat(48) });
    try {
      const candidate: LegacyTaskCandidate = {
        domain: "legacy_task",
        dueAt: "2026-08-19T14:00:00.000Z",
        expectedRevision: 1,
        localDate: "2026-08-19",
        taskId: "captured-task",
        timeZone,
        title: "Play among us",
      };
      const localAdapter = { handleResolvedNamedCancellation: vi.fn(async () => undefined) };
      const resolver = {
        resolve: vi.fn(async (): Promise<NamedDeleteResolution> => ({
          candidate,
          candidates: [candidate],
          sources: { calendar: "skipped", legacyTasks: "complete", scheduledReminders: "complete" },
          status: "exact",
        }))
      } as unknown as NamedDeleteResolver;
      const handler = new NamedDeleteHandler({
        localTaskAssistant: localAdapter,
        ownerId,
        resolver,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });

      await handler.handleNaturalLanguageAction(message("delete play among us"), action("play among us"));
      expect(localAdapter.handleResolvedNamedCancellation).toHaveBeenCalledWith(expect.anything(), candidate);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("stores a complete owner-bound selection and routes only the selected candidate", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "i".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "j".repeat(48) });
    try {
      const task = state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "selection-task",
        now,
        ownerId,
        timeZone,
        title: "Play among us",
      });
      const reminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "selection-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });
      const candidates: readonly NamedDeleteCandidateForTest[] = [
        {
          domain: "legacy_task",
          dueAt: task.dueAt.toISOString(),
          expectedRevision: task.revision,
          localDate: "2026-08-19",
          taskId: task.id,
          timeZone,
          title: task.title,
        },
        {
          domain: "scheduled_reminder",
          dueAt: reminder.dueAt?.toISOString(),
          expectedRevision: reminder.revision,
          itemId: reminder.id,
          scheduledDate: reminder.scheduledDate,
          timeZone,
          title: reminder.title,
        },
      ];
      const localAdapter = { handleResolvedNamedCancellation: vi.fn(async () => undefined) };
      const scheduleAdapter = { handleResolvedNamedReminderCancellation: vi.fn(async () => undefined) };
      const resolver = {
        resolve: vi.fn(async (): Promise<NamedDeleteResolution> => ({
          candidates,
          sources: { calendar: "skipped", legacyTasks: "complete", scheduledReminders: "complete" },
          status: "ambiguous",
        }))
      } as unknown as NamedDeleteResolver;
      const handler = new NamedDeleteHandler({
        localTaskAssistant: localAdapter,
        ownerId,
        resolver,
        scheduleAssistant: scheduleAdapter,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });

      const initial = message("delete play among us");
      await handler.handleNaturalLanguageAction(initial, action("play among us"));
      expect(initial.replies[0]).toMatch(/choose/iu);
      expect(initial.replies[0]).not.toContain(task.id);
      expect(initial.replies[0]).not.toContain(reminder.id);
      const pendingId = /choose ([a-f0-9-]+) followed/iu.exec(initial.replies[0] ?? "")?.[1];
      expect(pendingId).toBeDefined();
      const pending = state.getPendingAction({ id: pendingId!, now, ownerId });
      expect((pending?.payload as { candidates?: readonly unknown[] })?.candidates).toHaveLength(2);

      await handler.handlePendingAction(message(`choose ${pendingId} 2`), {
        actionId: pendingId!,
        choice: 2,
        kind: "choose",
      });
      expect(localAdapter.handleResolvedNamedCancellation).not.toHaveBeenCalled();
      expect(scheduleAdapter.handleResolvedNamedReminderCancellation).toHaveBeenCalledTimes(1);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  it("executes an exact one-time reminder through the existing cleanup path", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "k".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "l".repeat(48) });
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const reminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "exact-reminder",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });
      const candidate: ScheduledReminderCandidate = {
        domain: "scheduled_reminder",
        dueAt: reminder.dueAt?.toISOString(),
        expectedRevision: reminder.revision,
        itemId: reminder.id,
        scheduledDate: reminder.scheduledDate,
        timeZone,
        title: reminder.title,
      };
      const resolver = {
        resolve: vi.fn(async (): Promise<NamedDeleteResolution> => ({
          candidate,
          candidates: [candidate],
          sources: { calendar: "skipped", legacyTasks: "complete", scheduledReminders: "complete" },
          status: "exact",
        }))
      } as unknown as NamedDeleteResolver;
      const schedule = new ScheduleAssistant({
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const handler = new NamedDeleteHandler({
        ownerId,
        resolver,
        scheduleAssistant: schedule,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const initial = message("delete play among us");
      await handler.handleNaturalLanguageAction(initial, action("play among us"));

      expect(pendingAction).not.toHaveBeenCalled();
      expect(initial.replies).toEqual(["Cancelled or deleted 1 scheduled item."]);
      expect(initial.replies.join(" ")).not.toMatch(/confirm|Review:/iu);
      expect(schedules.getScheduledItem({ id: reminder.id, ownerId })).toMatchObject({
        cancelledAt: now,
        revision: 2,
        status: "cancelled",
        updatedAt: now,
      });
    } finally {
      pendingAction.mockRestore();
      closeRepositories(state, schedules);
    }
  });

  it("uses Calendar confirmation and guest notification policy for an exact event", async () => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "m".repeat(48) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "n".repeat(48) });
    const gateway = new TestCalendarGateway();
    gateway.events = [calendarEvent({ attendees: [{ email: "guest@example.com" }] })];
    try {
      const event = gateway.events[0]!;
      const candidate: CalendarEventCandidate = {
        calendarId: event.calendarId,
        calendarSummary: "Secondary",
        calendarTimeZone: "America/New_York",
        domain: "calendar_event",
        end: event.end,
        eventId: event.id,
        expectedEtag: event.etag,
        hasExternalGuests: true,
        start: event.start,
        summary: event.summary,
      };
      const resolver = {
        resolve: vi.fn(async (): Promise<NamedDeleteResolution> => ({
          candidate,
          candidates: [candidate],
          sources: { calendar: "complete", legacyTasks: "complete", scheduledReminders: "complete" },
          status: "exact",
        }))
      } as unknown as NamedDeleteResolver;
      const calendar = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant: calendar,
        calendarGateway: gateway,
        ownerId,
        resolver,
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const initial = message("delete play among us");
      await handler.handleNaturalLanguageAction(initial, action("play among us"));
      expect(initial.replies[0]).toMatch(/confirm/iu);
      const pendingId = /confirm ([a-f0-9-]+)/iu.exec(initial.replies[0] ?? "")?.[1];
      expect(pendingId).toBeDefined();
      await calendar.handlePendingAction(message(`confirm ${pendingId}`), { actionId: pendingId!, kind: "confirm" });
      expect(gateway.deleteCalls).toContainEqual(expect.objectContaining({ eventId: event.id, sendUpdates: "all" }));
    } finally {
      closeRepositories(state, schedules);
    }
  });
});

type NamedDeleteCandidateForTest = LegacyTaskCandidate | ScheduledReminderCandidate;


describe("named-delete preservation property matrix", () => {
  const normalizationFixtures = [
    { label: "case and punctuation", selectorTitle: "CALL, PLUMBER", date: undefined },
    { label: "generic selector words", selectorTitle: "the task to call plumber", date: undefined },
    { label: "an optional date token", selectorTitle: "call plumber on 2026-08-19", date: undefined },
    { label: "an explicit date field", selectorTitle: "call plumber", date: "2026-08-19" },
  ] as const;

  // **Validates: Requirements 2.1, 2.5, 3.7, 3.9**
  it.each(normalizationFixtures)("preserves exact local-task cancellation when the selector uses $label", async ({ selectorTitle, date }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "preservation-normalization-state".repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "preservation-normalization-schedules".repeat(3) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const task = state.createLocalTask({
        dueAt: new Date("2026-08-19T14:00:00.000Z"),
        id: "preservation-normalized-task",
        now,
        ownerId,
        timeZone,
        title: "Call plumber",
      });
      const unrelated = state.createLocalTask({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "preservation-normalized-unrelated",
        now,
        ownerId,
        timeZone,
        title: "Call dentist",
      });
      const taskBefore = state.getLocalTask({ id: task.id, ownerId });
      const unrelatedBefore = state.getLocalTask({ id: unrelated.id, ownerId });
      if (!taskBefore || !unrelatedBefore) {
        throw new Error("Normalization fixture was not persisted");
      }

      const handler = new NamedDeleteHandler({
        calendarAssistant: new CalendarAssistant({
          calendarGateway: gateway,
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          stateRepository: state,
        }),
        calendarGateway: gateway,
        localTaskAssistant: new LocalTaskAssistant({
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          stateRepository: state,
          timeZone,
        }),
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        scheduleAssistant: new ScheduleAssistant({
          calendarGateway: gateway,
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          schedulingRepository: schedules,
          stateRepository: state,
          timeZone,
        }),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message(`delete ${selectorTitle}`);
      await handler.handleNaturalLanguageAction(request, action(selectorTitle, date));

      expect(pendingAction).not.toHaveBeenCalled();
      expect(request.replies).toEqual([expect.stringMatching(/^Cancelled local task: Call plumber\.$/u)]);
      expect(state.getLocalTask({ id: task.id, ownerId })).toMatchObject({
        revision: taskBefore.revision + 1,
        status: "cancelled",
      });
      expect(state.getLocalTask({ id: unrelated.id, ownerId })).toEqual(unrelatedBefore);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  const ambiguityFixtures = [
    {
      expectedDomains: ["legacy_task", "scheduled_reminder"],
      label: "one local task and one reminder with the same title",
      mode: "cross_domain" as const,
    },
    {
      expectedDomains: ["scheduled_reminder", "scheduled_reminder"],
      label: "two reminders with the same title",
      mode: "same_domain" as const,
    },
  ] as const;

  // **Validates: Requirements 2.5, 3.1, 3.9**
  it.each(ambiguityFixtures)("retains owner-bound selection for $label", async ({ expectedDomains, mode }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "preservation-ambiguity-state".repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "preservation-ambiguity-schedules".repeat(3) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const task = mode === "cross_domain"
        ? state.createLocalTask({
          dueAt: new Date("2026-08-19T14:00:00.000Z"),
          id: "preservation-ambiguous-task",
          now,
          ownerId,
          timeZone,
          title: "Play among us",
        })
        : undefined;
      const firstReminder = schedules.createScheduledItem({
        dueAt: new Date("2026-08-19T15:00:00.000Z"),
        id: "preservation-ambiguous-reminder-1",
        kind: "reminder",
        now,
        ownerId,
        scheduledDate: "2026-08-19",
        timeZone,
        title: "Play among us",
      });
      const secondReminder = mode === "same_domain"
        ? schedules.createScheduledItem({
          dueAt: new Date("2026-08-19T16:00:00.000Z"),
          id: "preservation-ambiguous-reminder-2",
          kind: "reminder",
          now,
          ownerId,
          scheduledDate: "2026-08-19",
          timeZone,
          title: "Play among us",
        })
        : undefined;
      const taskBefore = task ? state.getLocalTask({ id: task.id, ownerId }) : undefined;
      const firstReminderBefore = schedules.getScheduledItem({ id: firstReminder.id, ownerId });
      const secondReminderBefore = secondReminder
        ? schedules.getScheduledItem({ id: secondReminder.id, ownerId })
        : undefined;
      if (!firstReminderBefore || (task && !taskBefore) || (secondReminder && !secondReminderBefore)) {
        throw new Error("Ambiguity fixture was not persisted");
      }

      const handler = new NamedDeleteHandler({
        calendarGateway: gateway,
        localTaskAssistant: new LocalTaskAssistant({
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          stateRepository: state,
          timeZone,
        }),
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        scheduleAssistant: new ScheduleAssistant({
          calendarGateway: gateway,
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          schedulingRepository: schedules,
          stateRepository: state,
          timeZone,
        }),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete the PLAY, among-us");
      await handler.handleNaturalLanguageAction(request, action("the PLAY, among-us"));

      expect(request.replies[0]).toMatch(/I found multiple matching items\. Reply choose /iu);
      const id = /choose ([a-f0-9-]+) followed/iu.exec(request.replies[0] ?? "")?.[1];
      expect(id).toBeDefined();
      expect(pendingAction).toHaveBeenCalledTimes(1);
      const pending = state.getPendingAction({ id: id!, now, ownerId });
      const payload = pending?.payload as {
        candidates?: readonly { domain: string }[];
        kind?: string;
        selectorTerms?: readonly string[];
        source?: string;
      } | undefined;
      expect(payload).toMatchObject({
        kind: "named_delete_selection",
        selectorTerms: ["play", "among", "us"],
        source: "gemini",
      });
      expect(payload?.candidates?.map((candidate) => candidate.domain)).toEqual(expectedDomains);
      expect(gateway.eventReads.map((read) => read.calendarId)).toEqual(["primary", "secondary"]);
      expect(task ? state.getLocalTask({ id: task.id, ownerId }) : undefined).toEqual(taskBefore);
      expect(schedules.getScheduledItem({ id: firstReminder.id, ownerId })).toEqual(firstReminderBefore);
      expect(secondReminder
        ? schedules.getScheduledItem({ id: secondReminder.id, ownerId })
        : undefined).toEqual(secondReminderBefore);
      expect(gateway.deleteCalls).toHaveLength(0);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  const reviewedCalendarFixtures = [
    {
      label: "a shared Calendar event",
      mode: "shared" as const,
      staleAfterReview: false,
    },
    {
      label: "a shared Calendar event after its ETag changes",
      mode: "shared" as const,
      staleAfterReview: true,
    },
    {
      label: "a recurring Calendar event",
      mode: "recurring" as const,
      staleAfterReview: false,
    },
  ] as const;

  // **Validates: Requirements 2.4, 2.6, 3.2, 3.3, 3.8**
  it.each(reviewedCalendarFixtures)("preserves review and fresh Calendar safety for $label", async ({ mode, staleAfterReview }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "preservation-calendar-state".repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "preservation-calendar-schedules".repeat(3) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    try {
      const target = calendarEvent({
        ...(mode === "recurring" ? { recurrence: ["RRULE:FREQ=WEEKLY"] } : {}),
        ...(mode === "shared" ? { attendees: [{ email: "guest@example.com", self: false }] } : {}),
        etag: `preservation-${mode}-etag`,
        id: `preservation-${mode}-event`,
      });
      const unrelated = calendarEvent({
        etag: `preservation-${mode}-unrelated-etag`,
        id: `preservation-${mode}-unrelated-event`,
        start: { dateTime: "2026-08-20T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        end: { dateTime: "2026-08-20T13:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
        summary: "Unrelated event",
      });
      gateway.events = [target, unrelated];
      const targetBefore = { ...target };
      const unrelatedBefore = { ...unrelated };
      const calendar = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant: calendar,
        calendarGateway: gateway,
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message("delete play among us");
      await handler.handleNaturalLanguageAction(request, action("play among us"));

      if (mode === "recurring") {
        expect(pendingAction).not.toHaveBeenCalled();
        expect(request.replies.join(" ")).toMatch(/recurring event/i);
        expect(gateway.deleteCalls).toHaveLength(0);
        expect(gateway.events).toEqual([targetBefore, unrelatedBefore]);
        return;
      }

      expect(pendingAction).toHaveBeenCalledTimes(1);
      expect(request.replies.join(" ")).toMatch(/confirm/iu);
      const id = /confirm ([a-f0-9-]+)/iu.exec(request.replies.join(" "))?.[1];
      expect(id).toBeDefined();
      const pending = state.getPendingAction({ id: id!, now, ownerId });
      expect(pending?.payload).toMatchObject({
        eventId: target.id,
        expectedEtag: target.etag,
        kind: "mutation",
        namedDelete: true,
        sendUpdates: "all",
      });
      expect(gateway.deleteCalls).toHaveLength(0);
      expect(gateway.events).toEqual([targetBefore, unrelatedBefore]);

      if (staleAfterReview) {
        gateway.events[0] = { ...target, etag: "preservation-changed-etag" };
        const confirmation = message(`confirm ${id}`);
        await calendar.handlePendingAction(confirmation, { actionId: id!, kind: "confirm" });
        expect(gateway.deleteCalls).toHaveLength(0);
        expect(confirmation.replies.join(" ")).toMatch(/changed since/i);
        expect(gateway.events).toContainEqual(unrelatedBefore);
        return;
      }

      await calendar.handlePendingAction(message(`confirm ${id}`), { actionId: id!, kind: "confirm" });
      expect(gateway.deleteCalls).toEqual([expect.objectContaining({
        eventId: target.id,
        sendUpdates: "all",
      })]);
      expect(gateway.events).not.toContainEqual(targetBefore);
      expect(gateway.events).toContainEqual(unrelatedBefore);
    } finally {
      closeRepositories(state, schedules);
    }
  });

  const failClosedFixtures = [
    { label: "a Calendar source read failure", mode: "calendar_read_failure" as const },
    { label: "a read-only Calendar", mode: "calendar_read_only" as const },
    { label: "a Calendar date mismatch", mode: "calendar_date_mismatch" as const },
    { label: "an elapsed future-only Calendar event", mode: "calendar_not_future" as const },
    { label: "a malformed Calendar interval", mode: "calendar_malformed_interval" as const },
    { label: "a cancelled Calendar event", mode: "calendar_cancelled" as const },
    { label: "a reminder owned by another owner", mode: "foreign_reminder" as const },
    { label: "a cancelled reminder", mode: "cancelled_reminder" as const },
  ] as const;

  // **Validates: Requirements 2.5, 2.6, 3.6, 3.8**
  it.each(failClosedFixtures)("keeps $label fail-closed without a mutation", async ({ mode }) => {
    const state = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "preservation-failure-state".repeat(3) });
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "preservation-failure-schedules".repeat(3) });
    const gateway = new TestCalendarGateway();
    const pendingAction = vi.spyOn(state, "createPendingAction");
    const otherOwnerId = "987654321098765432";
    try {
      let expectedReply = /could not find an eligible matching item/i;
      let reminderId: string | undefined;
      let reminderOwnerId = ownerId;
      let reminderBefore: ReturnType<SchedulingRepository["getScheduledItem"]> = undefined;
      if (mode.startsWith("calendar")) {
        const invalidInterval = mode === "calendar_malformed_interval";
        const target = calendarEvent({
          ...(mode === "calendar_cancelled" ? { status: "cancelled" as const } : {}),
          ...(invalidInterval
            ? {
              end: { dateTime: "2026-08-19T11:00:00.000-04:00", kind: "timed" as const, timeZone: "America/New_York" },
              start: { dateTime: "2026-08-19T12:00:00.000-04:00", kind: "timed" as const, timeZone: "America/New_York" },
            }
            : {}),
          ...(mode === "calendar_not_future"
            ? {
              end: { dateTime: "2026-08-18T07:00:00.000-04:00", kind: "timed" as const, timeZone: "America/New_York" },
              start: { dateTime: "2026-08-18T06:00:00.000-04:00", kind: "timed" as const, timeZone: "America/New_York" },
            }
            : {}),
          id: `preservation-failure-${mode}`,
        });
        gateway.events = [target];
        if (mode === "calendar_read_failure") {
          gateway.failListCalendars = true;
          expectedReply = /safely review every matching item/i;
        } else if (mode === "calendar_read_only") {
          gateway.calendars = gateway.calendars.map((calendar) =>
            calendar.id === target.calendarId ? { ...calendar, readOnly: true } : calendar);
        } else if (invalidInterval) {
          expectedReply = /safely review every matching item/i;
        }
      } else {
        reminderOwnerId = mode === "foreign_reminder" ? otherOwnerId : ownerId;
        const reminder = schedules.createScheduledItem({
          dueAt: new Date("2026-08-19T15:00:00.000Z"),
          id: `preservation-failure-${mode}`,
          kind: "reminder",
          now,
          ownerId: reminderOwnerId,
          scheduledDate: "2026-08-19",
          timeZone,
          title: "Play among us",
        });
        reminderId = reminder.id;
        if (mode === "cancelled_reminder") {
          schedules.cancelScheduledItem({
            expectedRevision: reminder.revision,
            id: reminder.id,
            now,
            ownerId: reminderOwnerId,
          });
        }
        reminderBefore = schedules.getScheduledItem({ id: reminder.id, ownerId: reminderOwnerId });
      }

      const calendar = new CalendarAssistant({
        calendarGateway: gateway,
        logger: createLogger("silent"),
        now: () => now,
        ownerId,
        stateRepository: state,
      });
      const handler = new NamedDeleteHandler({
        calendarAssistant: calendar,
        calendarGateway: gateway,
        localTaskAssistant: new LocalTaskAssistant({
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          stateRepository: state,
          timeZone,
        }),
        now: () => now,
        ownerId,
        resolver: createResolver(state, schedules, gateway),
        scheduleAssistant: new ScheduleAssistant({
          calendarGateway: gateway,
          logger: createLogger("silent"),
          now: () => now,
          ownerId,
          schedulingRepository: schedules,
          stateRepository: state,
          timeZone,
        }),
        schedulingRepository: schedules,
        stateRepository: state,
        timeZone,
      });
      const request = message(
        mode === "calendar_date_mismatch" ? "delete play among us on 2026-08-20" : "delete play among us",
      );
      await handler.handleNaturalLanguageAction(
        request,
        mode === "calendar_date_mismatch"
          ? action("play among us", "2026-08-20")
          : action("play among us"),
      );

      expect(request.replies.join(" ")).toMatch(expectedReply);
      expect(pendingAction).not.toHaveBeenCalled();
      expect(gateway.deleteCalls).toHaveLength(0);
      if (reminderId) {
        expect(schedules.getScheduledItem({ id: reminderId, ownerId: reminderOwnerId })).toEqual(reminderBefore);
      } else if (mode !== "calendar_read_failure") {
        expect(gateway.events).toHaveLength(1);
      }
    } finally {
      closeRepositories(state, schedules);
    }
  });
});
