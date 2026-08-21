import { describe, expect, it, vi } from "vitest";

import { CalendarAssistant, type CalendarAssistantStateRepository } from "../src/application/calendar-assistant.js";
import type { CalendarEvent, CalendarReference } from "../src/domain/calendar.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { CalendarGateway } from "../src/google/calendar-api.js";
import type { NaturalLanguageActionPlanner } from "../src/nlp/natural-language-action-planner.js";
import type { CalendarCommandPlanner } from "../src/nlp/calendar-command-planner.js";
import { runNaturalLanguageDryRun } from "../src/nlp/natural-language-dry-run.js";
import { createLogger } from "../src/logger.js";
import {
  LocalTaskAssistant,
  type LocalTaskStateRepository,
} from "../src/tasks/local-task-assistant.js";
import type { LocalTask } from "../src/tasks/task-domain.js";

const ownerId = "123456789012345678";
const now = new Date("2026-08-17T20:00:00.000Z");
const timeZone = "America/Toronto";

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: "message-1",
    replies,
    reply: async (value) => {
      replies.push(value);
    },
  };
}

function calendarReference(): CalendarReference {
  return { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone };
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2026-08-18T16:00:00-04:00", kind: "timed", timeZone },
    etag: "etag-1",
    id: "event-1",
    start: { dateTime: "2026-08-18T15:00:00-04:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Team meeting",
    ...overrides,
  };
}

function calendarGateway(event?: CalendarEvent): {
  gateway: CalendarGateway;
  writes: {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    split: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
} {
  const writes = {
    create: vi.fn(),
    delete: vi.fn(),
    split: vi.fn(),
    truncate: vi.fn(),
    update: vi.fn(),
  };
  const gateway = {
    createEvent: writes.create,
    deleteEvent: writes.delete,
    getEvent: vi.fn(async () => event ?? calendarEvent()),
    listCalendars: vi.fn(async () => [calendarReference()]),
    listEvents: vi.fn(async () => event ? [event] : []),
    splitRecurringEvent: writes.split,
    truncateRecurringEvent: writes.truncate,
    updateEvent: writes.update,
  } as unknown as CalendarGateway;
  return { gateway, writes };
}

function calendarState(): {
  repository: CalendarAssistantStateRepository;
  writes: {
    audit: ReturnType<typeof vi.fn>;
    createPending: ReturnType<typeof vi.fn>;
    deletePending: ReturnType<typeof vi.fn>;
    reminder: ReturnType<typeof vi.fn>;
  };
} {
  const writes = {
    audit: vi.fn(),
    createPending: vi.fn(),
    deletePending: vi.fn(),
    reminder: vi.fn(),
  };
  const repository = {
    consumePendingAction: writes.deletePending,
    createPendingAction: writes.createPending,
    getPendingAction: vi.fn(),
    recordAudit: writes.audit,
    setReminderOverride: writes.reminder,
  } as unknown as CalendarAssistantStateRepository;
  return { repository, writes };
}

function taskState(task?: LocalTask): {
  repository: LocalTaskStateRepository;
  writes: {
    audit: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    bulkCancel: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createPending: ReturnType<typeof vi.fn>;
  };
} {
  const writes = {
    audit: vi.fn(),
    cancel: vi.fn(),
    bulkCancel: vi.fn(),
    complete: vi.fn(),
    create: vi.fn(),
    createPending: vi.fn(),
  };
  const repository = {
    cancelLocalTask: writes.cancel,
    cancelLocalTasks: writes.bulkCancel,
    completeLocalTask: writes.complete,
    createLocalTask: writes.create,
    createPendingAction: writes.createPending,
    getLocalTask: vi.fn(() => task),
    getPendingAction: vi.fn(),
    consumePendingAction: vi.fn(),
    listActiveLocalTasks: vi.fn(() => task ? [task] : []),
    listActiveLocalTasksInRange: vi.fn(() => []),
    recordAudit: writes.audit,
  } as unknown as LocalTaskStateRepository;
  return { repository, writes };
}

describe("natural-language dry-run safety harness", () => {
  it("runs the unified read-only evaluator with no execution dependencies or writes", async () => {
    const actionPlanner: NaturalLanguageActionPlanner = {
      plan: vi.fn(async () => ({
        action: "create_task_or_reminder" as const,
        date: "2026-08-18",
        scheduleKind: "reminder" as const,
        startTime: "18:00",
        title: "run",
      })),
    };

    const result = await runNaturalLanguageDryRun({
      actionPlanner,
      examples: [{
        expected: {
          command: { date: "2026-08-18", kind: "create", time: "18:00", title: "run" },
          domain: "task",
        },
        id: "dry-run-task-create",
        now: now.toISOString(),
        split: "evaluation",
        text: "Please remember to run tomorrow at six.",
        timeZone,
      }],
      minimumAccuracy: 1,
    });

    expect(result.evaluation.accuracy).toBe(1);
    expect(result.writesAttempted).toBe(0);
    expect(actionPlanner.plan).toHaveBeenCalledTimes(1);
  });

  it("blocks a model Calendar create before gateway, pending-action, or audit writes", async () => {
    const calendar = calendarGateway();
    const state = calendarState();
    const planner: CalendarCommandPlanner = {
      plan: vi.fn(async () => ({
        date: "2026-08-18",
        durationMinutes: 60,
        kind: "create" as const,
        startTime: "18:00",
        title: "Dinner",
      })),
    };
    const assistant = new CalendarAssistant({
      calendarGateway: calendar.gateway,
      commandPlanner: planner,
      dryRun: true,
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      stateRepository: state.repository,
    });
    const request = message("Please put dinner on my calendar tomorrow evening.");

    await assistant.handle(request);

    expect(calendar.writes.create).not.toHaveBeenCalled();
    expect(state.writes.createPending).not.toHaveBeenCalled();
    expect(state.writes.audit).not.toHaveBeenCalled();
    expect(request.replies.join(" ")).toMatch(/dry run/i);
  });

  it("blocks a model Calendar move affecting guests without storing confirmation", async () => {
    const calendar = calendarGateway(calendarEvent({
      attendees: [{ email: "guest@example.com", self: false }],
    }));
    const state = calendarState();
    const planner: CalendarCommandPlanner = {
      plan: vi.fn(async () => ({
        kind: "update" as const,
        newStartTime: "16:00",
        selector: { date: "2026-08-18", summary: "meeting", time: "15:00" },
      })),
    };
    const assistant = new CalendarAssistant({
      calendarGateway: calendar.gateway,
      commandPlanner: planner,
      dryRun: true,
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      stateRepository: state.repository,
    });

    await assistant.handle(message("Please move the team meeting tomorrow from 3pm to 4pm."));

    expect(calendar.writes.update).not.toHaveBeenCalled();
    expect(state.writes.createPending).not.toHaveBeenCalled();
    expect(state.writes.audit).not.toHaveBeenCalled();
  });

  it("blocks model local-task creation and completion without state writes", async () => {
    const createState = taskState();
    const createAssistant = new LocalTaskAssistant({
      commandPlanner: {
        plan: vi.fn(async () => ({
          date: "2026-08-18",
          kind: "create" as const,
          time: "18:00",
          title: "run",
        })),
      },
      dryRun: true,
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      stateRepository: createState.repository,
      timeZone,
    });

    await createAssistant.handleNaturalLanguage(message("I need to remember to run tomorrow at six."));

    expect(createState.writes.create).not.toHaveBeenCalled();
    expect(createState.writes.createPending).not.toHaveBeenCalled();
    expect(createState.writes.audit).not.toHaveBeenCalled();

    const task: LocalTask = {
      createdAt: now,
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "run-task",
      ownerId,
      revision: 1,
      status: "active",
      timeZone,
      title: "Run",
      updatedAt: now,
    };
    const completeState = taskState(task);
    const completeAssistant = new LocalTaskAssistant({
      commandPlanner: {
        plan: vi.fn(async () => ({ kind: "complete" as const, selector: { title: "run" } })),
      },
      dryRun: true,
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      stateRepository: completeState.repository,
      timeZone,
    });

    await completeAssistant.handleNaturalLanguage(message("The run task is done."));

    expect(completeState.writes.complete).not.toHaveBeenCalled();
    expect(completeState.writes.cancel).not.toHaveBeenCalled();
    expect(completeState.writes.audit).not.toHaveBeenCalled();
  });
});
