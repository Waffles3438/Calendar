import { describe, expect, it } from "vitest";

import { CalendarAssistant } from "../src/application/calendar-assistant.js";
import type {
  CalendarEvent,
  CalendarEventPatch,
  CalendarReference,
} from "../src/domain/calendar.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type {
  CalendarGateway,
  CreateCalendarEventInput,
  DeleteCalendarEventInput,
  SplitRecurringEventInput,
  TruncateRecurringEventInput,
  UpdateCalendarEventInput,
} from "../src/google/calendar-api.js";
import type { CalendarCommandPlanner, CalendarCommandPlanningInput } from "../src/nlp/calendar-command-planner.js";
import type { ParsedCalendarCommand } from "../src/nlp/deterministic-command-parser.js";
import { createLogger } from "../src/logger.js";

const timeZone = "America/New_York";
const now = new Date("2025-01-06T16:00:00.000Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
    etag: "etag-1",
    id: "meeting-1",
    start: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Team meeting",
    ...overrides,
  };
}

class FakeCalendarGateway implements CalendarGateway {
  public readonly calendars: CalendarReference[] = [
    { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone },
  ];
  public events: CalendarEvent[];
  public readonly hiddenEvents: CalendarEvent[];
  public readonly updateCalls: UpdateCalendarEventInput[] = [];
  public readonly deleteCalls: DeleteCalendarEventInput[] = [];
  public readonly createCalls: CreateCalendarEventInput[] = [];
  public readonly splitCalls: SplitRecurringEventInput[] = [];
  public readonly truncateCalls: TruncateRecurringEventInput[] = [];

  public constructor(events: CalendarEvent[], hiddenEvents: CalendarEvent[] = []) {
    this.events = events;
    this.hiddenEvents = hiddenEvents;
  }

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    return this.calendars;
  }

  public async listEvents(): Promise<readonly CalendarEvent[]> {
    return this.events;
  }

  public async getEvent(input: { calendarId: string; eventId: string }): Promise<CalendarEvent> {
    const found = [...this.events, ...this.hiddenEvents].find(
      (candidate) => candidate.calendarId === input.calendarId && candidate.id === input.eventId,
    );
    if (!found) {
      throw new Error("not found");
    }
    return found;
  }

  public async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    this.createCalls.push(input);
    const created = event({
      calendarId: input.calendarId,
      end: input.end,
      etag: "created-etag",
      id: "created-1",
      start: input.start,
      summary: input.summary,
    });
    this.events.push(created);
    return created;
  }

  public async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEvent> {
    this.updateCalls.push(input);
    const existing = await this.getEvent({ calendarId: input.calendarId, eventId: input.eventId });
    const updated: CalendarEvent = {
      ...existing,
      ...input.patch,
      etag: `${existing.etag}-updated`,
    };
    this.replace(updated);
    return updated;
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    this.deleteCalls.push(input);
    this.events = this.events.filter((candidate) => candidate.id !== input.eventId);
    const hiddenIndex = this.hiddenEvents.findIndex((candidate) => candidate.id === input.eventId);
    if (hiddenIndex >= 0) {
      this.hiddenEvents.splice(hiddenIndex, 1);
    }
  }

  public async splitRecurringEvent(input: SplitRecurringEventInput): Promise<CalendarEvent> {
    this.splitCalls.push(input);
    const created = event({
      attendees: input.patch.attendees ?? input.master.attendees,
      end: input.patch.end ?? input.targetOccurrence.end,
      etag: "split-etag",
      id: "split-series-1",
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
    const eventIndex = this.events.findIndex((candidate) => candidate.id === updated.id);
    if (eventIndex >= 0) {
      this.events[eventIndex] = updated;
      return;
    }
    const hiddenIndex = this.hiddenEvents.findIndex((candidate) => candidate.id === updated.id);
    if (hiddenIndex >= 0) {
      this.hiddenEvents[hiddenIndex] = updated;
    }
  }
}

class FakeStateRepository {
  public readonly audits: Array<{ actionType: string; status: "failed" | "succeeded" }> = [];
  public readonly overrides: Array<{ calendarId: string; eventId: string; minutesBefore: number; occurrenceStart?: string }> = [];
  private readonly pending = new Map<string, { expiresAt: Date; ownerId: string; payload: unknown }>();

  public createPendingAction(input: {
    expiresAt: Date;
    id: string;
    ownerId: string;
    payload: unknown;
  }): void {
    this.pending.set(input.id, input);
  }

  public getPendingAction(input: { id: string; now: Date; ownerId: string }) {
    const pending = this.pending.get(input.id);
    if (!pending || pending.ownerId !== input.ownerId || pending.expiresAt <= input.now) {
      return undefined;
    }
    return {
      createdAt: input.now,
      expiresAt: pending.expiresAt,
      id: input.id,
      ownerId: input.ownerId,
      payload: pending.payload,
    };
  }

  public consumePendingAction(input: { id: string; now: Date; ownerId: string }) {
    const pending = this.getPendingAction(input);
    if (!pending) {
      return undefined;
    }
    this.pending.delete(input.id);
    return pending;
  }

  public setReminderOverride(input: {
    calendarId: string;
    eventId: string;
    minutesBefore: number;
    occurrenceStart?: string;
  }): void {
    this.overrides.push(input);
  }

  public recordAudit(input: { actionType: string; status: "failed" | "succeeded" }): void {
    this.audits.push(input);
  }
}

class FakeCommandPlanner implements CalendarCommandPlanner {
  public readonly calls: CalendarCommandPlanningInput[] = [];
  public failure = false;

  public constructor(public result: ParsedCalendarCommand | undefined) { }

  public async plan(input: CalendarCommandPlanningInput): Promise<ParsedCalendarCommand | undefined> {
    this.calls.push(input);
    if (this.failure) {
      throw new Error("Gemini is unavailable");
    }
    return this.result;
  }
}

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: "123456789012345678",
    content,
    id: "message-1",
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

function createAssistant(
  gateway: FakeCalendarGateway,
  state = new FakeStateRepository(),
  commandPlanner?: CalendarCommandPlanner,
): CalendarAssistant {
  return new CalendarAssistant({
    calendarGateway: gateway,
    ...(commandPlanner ? { commandPlanner } : {}),
    logger: createLogger("silent"),
    now: () => now,
    ownerId: "123456789012345678",
    stateRepository: state,
  });
}

function actionId(reply: string, command: "choose" | "confirm" = "confirm"): string {
  const id = new RegExp(`${command} ([a-f0-9-]+)`, "iu").exec(reply)?.[1];
  if (!id) {
    throw new Error(`Expected ${command} action ID in reply: ${reply}`);
  }
  return id;
}

function recurringOccurrence(): CalendarEvent {
  return event({
    etag: "instance-etag",
    id: "occurrence-1",
    originalStart: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
    recurringEventId: "series-1",
  });
}

function recurringMaster(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return event({
    end: { dateTime: "2025-01-03T16:00:00.000-05:00", kind: "timed", timeZone },
    etag: "series-etag",
    id: "series-1",
    recurrence: ["RRULE:FREQ=WEEKLY"],
    start: { dateTime: "2025-01-03T15:00:00.000-05:00", kind: "timed", timeZone },
    ...overrides,
  });
}

describe("CalendarAssistant", () => {
  it("moves a unique, non-guest event immediately and reports an overlap", async () => {
    const gateway = new FakeCalendarGateway([
      event(),
      event({
        end: { dateTime: "2025-01-10T17:00:00.000-05:00", kind: "timed", timeZone },
        etag: "etag-2",
        id: "overlap-1",
        start: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
        summary: "Design review",
      }),
    ]);
    const assistant = createAssistant(gateway);
    const input = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(input);

    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]).toMatchObject({
      eventId: "meeting-1",
      patch: {
        end: { dateTime: "2025-01-10T17:00:00.000-05:00" },
        start: { dateTime: "2025-01-10T16:00:00.000-05:00" },
      },
      sendUpdates: "none",
    });
    expect(input.replies.join(" ")).toMatch(/moved/i);
    expect(input.replies.join(" ")).toMatch(/overlap/i);
  });

  it("creates a clear event without involving a model", async () => {
    const gateway = new FakeCalendarGateway([]);
    const assistant = createAssistant(gateway);
    const input = message("schedule lunch Friday at noon");

    await assistant.handle(input);

    expect(gateway.createCalls).toEqual([
      expect.objectContaining({
        calendarId: "primary",
        sendUpdates: "none",
        summary: "lunch",
      }),
    ]);
    expect(input.replies.join(" ")).toMatch(/created/i);
  });

  it("requires explicit confirmation before changing an event with guests", async () => {
    const gateway = new FakeCalendarGateway([
      event({ attendees: [{ email: "guest@example.com", self: false }] }),
    ]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(request);

    expect(gateway.updateCalls).toHaveLength(0);
    const confirmationId = actionId(request.replies.join(" "));
    expect(request.replies.join(" ")).toMatch(/guests will receive/i);

    const confirmation = message(`confirm ${confirmationId}`);
    await assistant.handle(confirmation);

    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]?.sendUpdates).toBe("all");
  });

  it("requires confirmation before deleting a clearly matched event", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const assistant = createAssistant(gateway);
    const request = message("delete the 3pm meeting on Friday");

    await assistant.handle(request);

    const confirmationId = actionId(request.replies.join(" "));
    expect(gateway.deleteCalls).toHaveLength(0);

    await assistant.handle(message(`confirm ${confirmationId}`));
    expect(gateway.deleteCalls).toHaveLength(1);
  });

  it("stores a clear reminder override locally without changing Calendar guests", async () => {
    const gateway = new FakeCalendarGateway([event({ attendees: [{ email: "guest@example.com", self: false }] })]);
    const state = new FakeStateRepository();
    const assistant = createAssistant(gateway, state);
    const input = message("remind me 30 minutes before the 3pm meeting on Friday");

    await assistant.handle(input);

    expect(state.overrides).toEqual([
      expect.objectContaining({ calendarId: "primary", eventId: "meeting-1", minutesBefore: 30 }),
    ]);
    expect(input.replies.join(" ")).toMatch(/30 minutes/i);
  });

  it("does not fall back to an unrelated event when a supplied time does not match", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const assistant = createAssistant(gateway);
    const input = message("change the 4pm meeting on Friday to 5pm");

    await assistant.handle(input);

    expect(gateway.updateCalls).toHaveLength(0);
    expect(input.replies.join(" ")).toMatch(/could not find/i);
  });

  it("does not fall back to an unrelated event when a supplied title does not match", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const assistant = createAssistant(gateway);
    const input = message("change the 3pm dentist appointment on Friday to 5pm");

    await assistant.handle(input);

    expect(gateway.updateCalls).toHaveLength(0);
    expect(input.replies.join(" ")).toMatch(/could not find/i);
  });

  it("keeps a selection action available after an invalid choice and then updates the chosen event", async () => {
    const gateway = new FakeCalendarGateway([
      event(),
      event({ etag: "etag-2", id: "meeting-2", summary: "Planning meeting" }),
    ]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(request);

    const selectionId = actionId(request.replies.join(" "), "choose");
    await assistant.handle(message(`choose ${selectionId} 0`));
    expect(gateway.updateCalls).toHaveLength(0);

    await assistant.handle(message(`choose ${selectionId} 2`));
    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]?.eventId).toBe("meeting-2");
  });

  it("rejects a confirmed write when the event ETag is stale", async () => {
    const gateway = new FakeCalendarGateway([
      event({ attendees: [{ email: "guest@example.com", self: false }] }),
    ]);
    const state = new FakeStateRepository();
    const assistant = createAssistant(gateway, state);
    const request = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(request);
    gateway.events[0] = event({
      attendees: [{ email: "guest@example.com", self: false }],
      etag: "new-etag",
    });

    const confirmation = message(`confirm ${actionId(request.replies.join(" "))}`);
    await assistant.handle(confirmation);

    expect(gateway.updateCalls).toHaveLength(0);
    expect(confirmation.replies.join(" ")).toMatch(/changed since/i);
    expect(state.audits).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("requires a recurrence scope and supports an immediate this-occurrence update", async () => {
    const occurrence = recurringOccurrence();
    const gateway = new FakeCalendarGateway([occurrence], [recurringMaster()]);
    const assistant = createAssistant(gateway);
    const missingScope = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(missingScope);
    expect(missingScope.replies.join(" ")).toMatch(/recurring event/i);
    expect(gateway.updateCalls).toHaveLength(0);

    const scoped = message("change the 3pm meeting on Friday to 4pm this occurrence");
    await assistant.handle(scoped);
    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]?.eventId).toBe("occurrence-1");
  });

  it("confirms whole-series changes and rebases the time patch onto the series master", async () => {
    const gateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm whole series");

    await assistant.handle(request);
    expect(gateway.updateCalls).toHaveLength(0);

    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));
    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]).toMatchObject({
      eventId: "series-1",
      patch: { start: { dateTime: "2025-01-03T16:00:00.000-05:00" } },
    });
  });

  it("confirms and splits a recurring series for an all-future change", async () => {
    const gateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm all future occurrences");

    await assistant.handle(request);
    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));

    expect(gateway.splitCalls).toHaveLength(1);
    expect(gateway.splitCalls[0]).toMatchObject({
      master: { id: "series-1" },
      targetOccurrence: { id: "occurrence-1" },
    });
  });

  it("truncates a recurring series after confirmation when deleting all future occurrences", async () => {
    const gateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const assistant = createAssistant(gateway);
    const request = message("delete the 3pm meeting on Friday all future occurrences");

    await assistant.handle(request);
    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));

    expect(gateway.truncateCalls).toHaveLength(1);
    expect(gateway.truncateCalls[0]).toMatchObject({
      master: { id: "series-1" },
      targetOccurrence: { id: "occurrence-1" },
    });
  });

  it("requires confirmation for attendee additions and sends updates to guests", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const assistant = createAssistant(gateway);
    const request = message("add guest@example.com to the 3pm meeting on Friday");

    await assistant.handle(request);
    expect(gateway.updateCalls).toHaveLength(0);

    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));
    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]).toMatchObject({
      eventId: "meeting-1",
      patch: { attendees: [{ email: "guest@example.com" }] },
      sendUpdates: "all",
    });
  });

  it("removes an attendee only after confirmation and notifies the remaining guests", async () => {
    const gateway = new FakeCalendarGateway([
      event({
        attendees: [
          { email: "owner@example.com", self: true },
          { email: "guest@example.com", self: false },
        ],
      }),
    ]);
    const assistant = createAssistant(gateway);
    const request = message("remove guest@example.com from the 3pm meeting on Friday");

    await assistant.handle(request);
    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));

    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]).toMatchObject({
      patch: { attendees: [{ email: "owner@example.com", self: true }] },
      sendUpdates: "all",
    });
  });
});


describe("CalendarAssistant Gemini fallback", () => {
  it("never invokes the planner for a deterministic command", async () => {
    const gateway = new FakeCalendarGateway([]);
    const planner = new FakeCommandPlanner({
      kind: "create",
      date: "2025-01-10",
      durationMinutes: 60,
      startTime: "12:00",
      title: "incorrect fallback",
    });
    const assistant = createAssistant(gateway, undefined, planner);

    await assistant.handle(message("schedule lunch Friday at noon"));

    expect(planner.calls).toHaveLength(0);
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]?.summary).toBe("lunch");
  });

  it("uses a valid model plan only after deterministic unsupported intent and confirms an update", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const planner = new FakeCommandPlanner({
      kind: "update",
      newStartTime: "16:00",
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
    const assistant = createAssistant(gateway, undefined, planner);
    const request = message("Could you shift the 3pm meeting on Friday to 4pm?");

    await assistant.handle(request);

    expect(planner.calls).toEqual([{
      now,
      text: request.content,
      timeZone,
    }]);
    expect(gateway.updateCalls).toHaveLength(0);
    expect(request.replies.join(" ")).toMatch(/model proposed/i);

    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));
    expect(gateway.updateCalls).toHaveLength(1);
    expect(gateway.updateCalls[0]?.eventId).toBe("meeting-1");
  });

  it("preserves the deterministic clarification and makes no write when the planner is unavailable", async () => {
    const gateway = new FakeCalendarGateway([event()]);
    const planner = new FakeCommandPlanner(undefined);
    planner.failure = true;
    const state = new FakeStateRepository();
    const assistant = createAssistant(gateway, state, planner);
    const request = message("Please magically reorganize my Friday calendar");

    await assistant.handle(request);

    expect(planner.calls).toHaveLength(1);
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.updateCalls).toHaveLength(0);
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(state.overrides).toHaveLength(0);
    expect(request.replies).toEqual(["I couldn't determine a calendar command."]);
  });

  it("requires confirmation before a model-proposed create", async () => {
    const gateway = new FakeCalendarGateway([]);
    const planner = new FakeCommandPlanner({
      kind: "create",
      date: "2025-01-10",
      durationMinutes: 30,
      startTime: "15:00",
      title: "Planning",
    });
    const assistant = createAssistant(gateway, undefined, planner);
    const request = message("Please put planning on my calendar Friday at 3pm");

    await assistant.handle(request);
    expect(gateway.createCalls).toHaveLength(0);

    await assistant.handle(message(`confirm ${actionId(request.replies.join(" "))}`));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]?.summary).toBe("Planning");
  });

  it("requires confirmation before model-proposed delete and reminder writes", async () => {
    const deleteGateway = new FakeCalendarGateway([event()]);
    const deletePlanner = new FakeCommandPlanner({
      kind: "delete",
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
    const deleteAssistant = createAssistant(deleteGateway, undefined, deletePlanner);
    const deleteRequest = message("Please remove that 3pm meeting from Friday");

    await deleteAssistant.handle(deleteRequest);
    expect(deleteGateway.deleteCalls).toHaveLength(0);
    await deleteAssistant.handle(message(`confirm ${actionId(deleteRequest.replies.join(" "))}`));
    expect(deleteGateway.deleteCalls).toHaveLength(1);

    const reminderGateway = new FakeCalendarGateway([event()]);
    const reminderPlanner = new FakeCommandPlanner({
      kind: "set_reminder",
      minutesBefore: 30,
      selector: { date: "2025-01-10", summary: "meeting", time: "15:00" },
    });
    const reminderState = new FakeStateRepository();
    const reminderAssistant = createAssistant(reminderGateway, reminderState, reminderPlanner);
    const reminderRequest = message("Please give me a half-hour heads-up for Friday's meeting");

    await reminderAssistant.handle(reminderRequest);
    expect(reminderState.overrides).toHaveLength(0);
    await reminderAssistant.handle(message(`confirm ${actionId(reminderRequest.replies.join(" "))}`));
    expect(reminderState.overrides).toEqual([
      expect.objectContaining({ eventId: "meeting-1", minutesBefore: 30 }),
    ]);
  });
});


describe("CalendarAssistant Gemini eligibility guard", () => {
  it("does not ask Gemini to invent a missing required detail", async () => {
    const gateway = new FakeCalendarGateway([]);
    const planner = new FakeCommandPlanner({
      kind: "create",
      date: "2025-01-10",
      durationMinutes: 60,
      startTime: "12:00",
      title: "invented lunch",
    });
    const assistant = createAssistant(gateway, undefined, planner);
    const request = message("schedule lunch Friday");

    await assistant.handle(request);

    expect(planner.calls).toHaveLength(0);
    expect(gateway.createCalls).toHaveLength(0);
    expect(request.replies).toEqual(["Please specify a start time."]);
  });
});


describe("CalendarAssistant confirmation freshness", () => {
  it("rejects series and all-future writes when the reviewed master ETag changes", async () => {
    const seriesGateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const seriesAssistant = createAssistant(seriesGateway);
    const seriesRequest = message("change the 3pm meeting on Friday to 4pm whole series");

    await seriesAssistant.handle(seriesRequest);
    seriesGateway.hiddenEvents[0] = recurringMaster({ etag: "changed-series-etag" });
    await seriesAssistant.handle(message(`confirm ${actionId(seriesRequest.replies.join(" "))}`));

    expect(seriesGateway.updateCalls).toHaveLength(0);

    const futureGateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const futureAssistant = createAssistant(futureGateway);
    const futureRequest = message("change the 3pm meeting on Friday to 4pm all future occurrences");

    await futureAssistant.handle(futureRequest);
    futureGateway.hiddenEvents[0] = recurringMaster({ etag: "changed-future-etag" });
    await futureAssistant.handle(message(`confirm ${actionId(futureRequest.replies.join(" "))}`));

    expect(futureGateway.splitCalls).toHaveLength(0);
  });

  it("rechecks new conflicts and requires a fresh confirmation before writing", async () => {
    const gateway = new FakeCalendarGateway([
      event({ attendees: [{ email: "guest@example.com", self: false }] }),
    ]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm");

    await assistant.handle(request);
    gateway.events.push(event({
      end: { dateTime: "2025-01-10T17:00:00.000-05:00", kind: "timed", timeZone },
      etag: "conflict-etag",
      id: "new-conflict",
      start: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
      summary: "New conflict",
    }));

    const initialConfirmation = message(`confirm ${actionId(request.replies.join(" "))}`);
    await assistant.handle(initialConfirmation);

    expect(gateway.updateCalls).toHaveLength(0);
    expect(initialConfirmation.replies.join(" ")).toMatch(/overlaps another event/i);

    await assistant.handle(message(`confirm ${actionId(initialConfirmation.replies.join(" "))}`));
    expect(gateway.updateCalls).toHaveLength(1);
  });
});


describe("CalendarAssistant recurring conflict freshness", () => {
  it("rechecks whole-series conflicts at the selected occurrence before applying the series patch", async () => {
    const gateway = new FakeCalendarGateway([recurringOccurrence()], [recurringMaster()]);
    const assistant = createAssistant(gateway);
    const request = message("change the 3pm meeting on Friday to 4pm whole series");

    await assistant.handle(request);
    gateway.events.push(event({
      end: { dateTime: "2025-01-10T17:00:00.000-05:00", kind: "timed", timeZone },
      etag: "series-conflict-etag",
      id: "series-new-conflict",
      start: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
      summary: "New Friday conflict",
    }));

    const confirmation = message(`confirm ${actionId(request.replies.join(" "))}`);
    await assistant.handle(confirmation);

    expect(gateway.updateCalls).toHaveLength(0);
    expect(confirmation.replies.join(" ")).toMatch(/overlaps another event/i);
  });
});