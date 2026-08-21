import { describe, expect, it, vi } from "vitest";

import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { CalendarEvent, CalendarReference } from "../src/domain/calendar.js";
import {
  CalendarChangeTracker,
  TrackedCalendarGateway,
} from "../src/google/calendar-change-tracker.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  ListCalendarEventsInput,
  SplitRecurringEventInput,
  TruncateRecurringEventInput,
  UpdateCalendarEventInput,
} from "../src/google/calendar-api.js";
import {
  CachingNaturalLanguageActionPlanner,
} from "../src/nlp/caching-natural-language-action-planner.js";
import type { NaturalLanguageAction } from "../src/nlp/natural-language-action.js";
import { AgendaService } from "../src/scheduling/agenda-service.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: `message-${replies.length}`,
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2026-08-21T18:00:00.000-04:00", kind: "timed", timeZone },
    etag: "event-etag-1",
    id: "event-1",
    start: { dateTime: "2026-08-21T17:00:00.000-04:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Planning meeting",
    ...overrides,
  };
}

class CountingCalendarGateway implements CalendarGateway {
  public readonly calendars: readonly CalendarReference[] = [{
    id: "primary",
    isPrimary: true,
    readOnly: false,
    summary: "Personal",
    timeZone,
  }];
  public calendarReads = 0;
  public eventReads = 0;
  public events: CalendarEvent[] = [calendarEvent()];

  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    return calendarEvent({
      calendarId: input.calendarId,
      end: input.end,
      id: "created-event",
      start: input.start,
      summary: input.summary,
    });
  }

  public async deleteEvent(_input: DeleteCalendarEventInput): Promise<void> {
    return undefined;
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const event = this.events.find((candidate) => candidate.calendarId === input.calendarId && candidate.id === input.eventId);
    if (!event) {
      throw new Error("Calendar event not found");
    }
    return event;
  }

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    this.calendarReads += 1;
    return this.calendars;
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    this.eventReads += 1;
    return this.events.filter((event) => event.calendarId === input.calendarId);
  }

  public async splitRecurringEvent(_input: SplitRecurringEventInput): Promise<CalendarEvent> {
    return calendarEvent({ id: "split-event" });
  }

  public async truncateRecurringEvent(_input: TruncateRecurringEventInput): Promise<void> {
    return undefined;
  }

  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    return this.getEvent({ calendarId: input.calendarId, eventId: input.eventId });
  }
}

function agendaAction(): Extract<NaturalLanguageAction, { action: "show_agenda" }> {
  return {
    action: "show_agenda",
    date: "2026-08-21",
    endDate: "2026-08-21",
    range: "day",
  };
}

describe("natural-language cache integration", () => {
  it("reuses an agenda interpretation while reading Calendar data on every request and invalidates after a changed read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T17:00:00.000Z"));
    const schedules = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
    try {
      const delegate = new CountingCalendarGateway();
      const tracker = new CalendarChangeTracker();
      const gateway = new TrackedCalendarGateway(delegate, tracker);
      const planned = agendaAction();
      const plan = vi.fn(async () => planned);
      const cache = new CachingNaturalLanguageActionPlanner({
        calendarChanges: tracker,
        model: "gemini-test-model",
        ownerId,
        planner: { plan },
      });
      const agenda = new AgendaService({
        calendarGateway: gateway,
        now: () => new Date("2026-08-21T17:00:00.000Z"),
        ownerId,
        schedulingRepository: schedules,
        timeZone,
      });
      const scheduleAssistant = {
        canHandlePendingAction: () => false,
        handle: vi.fn(async () => true),
        handleNaturalLanguageAction: vi.fn(async (
          routedMessage: OwnerDirectMessage,
          action: NaturalLanguageAction,
        ): Promise<boolean> => {
          if (action.action !== "show_agenda") {
            throw new Error("unexpected action");
          }
          await routedMessage.reply(await agenda.render(action));
          return true;
        }),
        handlePendingAction: vi.fn(async () => false),
      };
      const router = new OwnerCommandRouter({
        naturalLanguagePlanner: cache,
        ownerId,
        scheduleAssistant,
        stateRepository: {},
        taskTimeZone: timeZone,
      });

      await router.handle(message("What do I need to do today?"));
      await router.handle(message("What do I need to do today?"));

      expect(plan).toHaveBeenCalledTimes(1);
      expect(scheduleAssistant.handleNaturalLanguageAction).toHaveBeenCalledTimes(2);
      expect(delegate.calendarReads).toBe(2);
      expect(delegate.eventReads).toBe(2);

      delegate.events[0] = calendarEvent({ etag: "event-etag-2" });
      await router.handle(message("What do I need to do today?"));
      expect(plan).toHaveBeenCalledTimes(1);

      await router.handle(message("What do I need to do today?"));

      expect(plan).toHaveBeenCalledTimes(2);
      expect(delegate.calendarReads).toBe(4);
      expect(delegate.eventReads).toBe(4);
    } finally {
      schedules.close();
      vi.useRealTimers();
    }
  });

  it("keeps explicit task-list actions cached across Calendar changes and never dispatches them to Calendar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T17:00:00.000Z"));
    try {
      const tracker = new CalendarChangeTracker();
      const taskAction: NaturalLanguageAction = { action: "list_tasks" };
      const plan = vi.fn(async () => taskAction);
      const cache = new CachingNaturalLanguageActionPlanner({
        calendarChanges: tracker,
        model: "gemini-test-model",
        ownerId,
        planner: { plan },
      });
      const localTaskAssistant = {
        canHandlePendingAction: () => false,
        handle: vi.fn(async () => undefined),
        handleNaturalLanguage: vi.fn(async () => undefined),
        handleNaturalLanguageAction: vi.fn(async () => undefined),
        handlePendingAction: vi.fn(async () => false),
        isTaskInput: vi.fn(() => false),
      };
      const calendarAssistant = {
        handle: vi.fn(async () => undefined),
        handleNaturalLanguageAction: vi.fn(async () => undefined),
      };
      const router = new OwnerCommandRouter({
        calendarAssistant,
        localTaskAssistant,
        naturalLanguagePlanner: cache,
        ownerId,
        stateRepository: {},
        taskTimeZone: timeZone,
      });

      await router.handle(message("Show my tasks"));
      tracker.markChanged();
      await router.handle(message("Show my tasks"));

      expect(plan).toHaveBeenCalledTimes(1);
      expect(localTaskAssistant.handleNaturalLanguageAction).toHaveBeenCalledTimes(2);
      expect(calendarAssistant.handleNaturalLanguageAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
