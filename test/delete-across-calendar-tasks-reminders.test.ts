import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import type { CalendarReference, CalendarEvent } from "../src/domain/calendar.js";
import type { ListCalendarEventsInput, DeleteCalendarEventInput, CalendarGateway } from "../src/google/calendar-api.js";
import { createLogger } from "../src/logger.js";
import { AppStateRepository } from "../src/persistence/state-repository.js";
import type { PendingActionInstruction } from "../src/application/pending-action.js";
import { OwnerCommandRouter, type OwnerCommandRouterOptions } from "../src/application/owner-command-router.js";
import type { NaturalLanguageAction } from "../src/nlp/natural-language-action.js";
import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";
import { LocalTaskAssistant } from "../src/tasks/local-task-assistant.js";

const ownerId = "123456789012345678";
const timeZone = "America/Toronto";
const now = new Date("2026-08-18T12:00:00.000Z");
const matchingTitle = "play among us";

/**
 * These are the unfixed observations this suite is intended to capture:
 *
 * - Reminder-only: delete_task/single/{title: "play among us"} produces the
 *   legacy local-task no-match reply; the active scheduled reminder remains
 *   active, no scheduled review is prepared, and Calendar is not read.
 * - Calendar-only: the same action produces the local-task no-match reply;
 *   listCalendars/listEvents are never called and the writable secondary event
 *   remains present.
 * - Cross-domain: with a matching local task, scheduled reminder, and Calendar
 *   event, the current route cancels the local task immediately instead of
 *   producing the complete candidate set for explicit selection; the other
 *   two records remain unchanged.
 *
 * The assertions below intentionally describe the fixed contract, so these
 * tests are expected to fail until the named-delete coordinator is wired into
 * OwnerCommandRouter.
 */

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: `exploration-${Math.random()}`,
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

function deleteAction(title = matchingTitle): Extract<NaturalLanguageAction, { action: "delete_task" }> {
  return {
    action: "delete_task",
    scope: "single",
    selector: { title },
  };
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "secondary",
    end: { dateTime: "2026-08-19T12:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    etag: "etag-play-among-us",
    id: "calendar-play-among-us",
    start: { dateTime: "2026-08-19T11:00:00.000-04:00", kind: "timed", timeZone: "America/New_York" },
    status: "confirmed",
    summary: matchingTitle,
    ...overrides,
  };
}

class FakeCalendarGateway implements Pick<CalendarGateway, "deleteEvent" | "listCalendars" | "listEvents"> {
  public readonly calendars: readonly CalendarReference[] = [
    { id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone },
    { id: "secondary", isPrimary: false, readOnly: false, summary: "Secondary", timeZone: "America/New_York" },
  ];
  public readonly deleteCalls: DeleteCalendarEventInput[] = [];
  public readonly eventReads: ListCalendarEventsInput[] = [];
  public readonly calendarReads: number[] = [];
  public events: CalendarEvent[] = [];

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    this.calendarReads.push(1);
    return this.calendars;
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    this.eventReads.push(input);
    return this.events.filter((event) => event.calendarId === input.calendarId);
  }

  public async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    this.deleteCalls.push(input);
    this.events = this.events.filter((event) => event.id !== input.eventId);
  }
}

type NamedDeleteAction = Extract<NaturalLanguageAction, { action: "delete_task" }>;
type CandidateDomain = "calendar_event" | "legacy_task" | "scheduled_reminder";

interface ExplorationCandidate {
  readonly domain: CandidateDomain;
  readonly label: string;
  readonly title: string;
}

interface ExplorationCall {
  readonly action: NamedDeleteAction;
  readonly candidates: readonly ExplorationCandidate[];
}

interface NamedDeleteExplorationHandler {
  handleNaturalLanguageAction(message: OwnerDirectMessage, action: NamedDeleteAction): Promise<void>;
  canHandlePendingAction(payload: unknown): boolean;
  handlePendingAction(message: OwnerDirectMessage, instruction: PendingActionInstruction): Promise<boolean>;
}

const GENERIC_SELECTOR_WORDS = new Set([
  "a", "an", "appointment", "appointments", "class", "classes", "event", "events", "meeting", "meetings",
  "my", "on", "reminder", "reminders", "schedule", "schedules", "task", "tasks", "the", "to",
]);

function selectorTerms(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const terms: string[] = [];
  for (const term of normalized.split(/[^\p{L}\p{N}]+/gu)) {
    if (!term || GENERIC_SELECTOR_WORDS.has(term) || terms.includes(term)) {
      continue;
    }
    terms.push(term);
  }
  return terms;
}

function titleMatches(title: string, terms: readonly string[]): boolean {
  const candidateTerms = new Set(selectorTerms(title));
  return terms.length > 0 && terms.every((term) => candidateTerms.has(term));
}

/**
 * Test oracle for the future named-delete router seam. It deliberately performs
 * only fresh reads and review/routing bookkeeping; it never mutates a target.
 * The unfixed router ignores this injected handler, which is the reproduction.
 */
class CrossDomainResolutionOracle implements NamedDeleteExplorationHandler {
  public readonly calls: ExplorationCall[] = [];
  public readonly pendingCandidates: ExplorationCandidate[][] = [];
  public readonly readDomains: string[] = [];
  public readonly routedDomains: CandidateDomain[] = [];
  public readonly selections: ExplorationCandidate[][] = [];

  public constructor(
    private readonly stateRepository: AppStateRepository,
    private readonly schedulingRepository: SchedulingRepository,
    private readonly calendarGateway: FakeCalendarGateway,
  ) { }

  public canHandlePendingAction(_payload: unknown): boolean {
    return false;
  }

  public async handlePendingAction(_message: OwnerDirectMessage, _instruction: PendingActionInstruction): Promise<boolean> {
    return false;
  }

  public async handleNaturalLanguageAction(message: OwnerDirectMessage, action: NamedDeleteAction): Promise<void> {
    const terms = selectorTerms(action.selector?.title ?? "");
    const candidates: ExplorationCandidate[] = [];

    const localTasks = this.stateRepository.listActiveLocalTasks({ ownerId });
    this.readDomains.push("legacy_local_tasks");
    for (const task of localTasks) {
      if (titleMatches(task.title, terms)) {
        candidates.push({ domain: "legacy_task", label: `Task: ${task.title}`, title: task.title });
      }
    }

    const scheduledItems = this.schedulingRepository.listActiveScheduledItems({
      kinds: ["reminder"],
      ownerId,
      scheduledDateEarliest: "2026-08-18",
      scheduledDateLatest: "9999-12-31",
    });
    this.readDomains.push("scheduled_reminders");
    for (const item of scheduledItems) {
      if (item.dueAt && item.dueAt > now && titleMatches(item.title, terms)) {
        candidates.push({ domain: "scheduled_reminder", label: `Reminder: ${item.title}`, title: item.title });
      }
    }

    const calendars = await this.calendarGateway.listCalendars();
    this.readDomains.push("calendar_list");
    for (const calendar of calendars) {
      if (calendar.readOnly) {
        continue;
      }
      const events = await this.calendarGateway.listEvents({
        calendarId: calendar.id,
        timeMin: now.toISOString(),
        timeMax: "2026-08-26T12:00:00.000Z",
      });
      this.readDomains.push(`calendar_events:${calendar.id}`);
      for (const event of events) {
        if (event.status !== "cancelled" && event.etag.trim() &&
          Date.parse(event.start.kind === "timed" ? event.start.dateTime : `${event.start.date}T00:00:00.000Z`) > now.valueOf() &&
          titleMatches(event.summary, terms)) {
          candidates.push({
            domain: "calendar_event",
            label: `${calendar.summary}: ${event.summary}`,
            title: event.summary,
          });
        }
      }
    }

    this.calls.push({ action, candidates });
    this.pendingCandidates.push(candidates);
    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate) {
        this.routedDomains.push(candidate.domain);
      }
      await message.reply(`Review: one matching ${candidate?.label ?? "item"}.`);
      return;
    }
    if (candidates.length > 1) {
      this.selections.push(candidates);
      await message.reply(`Review: multiple matching items. Reply choose <id> <number>: ${candidates.map((candidate) => candidate.label).join("; ")}`);
      return;
    }
    await message.reply("I could not find an eligible matching item.");
  }
}

interface ExplorationFixture {
  readonly calendarGateway: FakeCalendarGateway;
  readonly localTaskAssistant: LocalTaskAssistant;
  readonly namedDeleteHandler: CrossDomainResolutionOracle;
  readonly router: OwnerCommandRouter;
  readonly schedulingRepository: SchedulingRepository;
  readonly stateRepository: AppStateRepository;
  close(): void;
}

function createFixture(): ExplorationFixture {
  const stateRepository = new AppStateRepository({ databasePath: ":memory:", encryptionSecret: "x".repeat(48) });
  const schedulingRepository = new SchedulingRepository({ databasePath: ":memory:", encryptionSecret: "y".repeat(48) });
  const calendarGateway = new FakeCalendarGateway();
  const localTaskAssistant = new LocalTaskAssistant({
    logger: createLogger("silent"),
    now: () => now,
    ownerId,
    stateRepository,
    timeZone,
  });
  const namedDeleteHandler = new CrossDomainResolutionOracle(stateRepository, schedulingRepository, calendarGateway);
  const routerOptions = {
    calendarReader: calendarGateway,
    localTaskAssistant,
    // This is the seam specified by the design. The current router does not
    // know this option, so the cast lets the exploration compile unchanged
    // before the production option is added.
    namedDeleteHandler,
    naturalLanguagePlanner: { plan: async (): Promise<NaturalLanguageAction> => deleteAction() },
    ownerId,
    stateRepository,
    taskTimeZone: timeZone,
  } as unknown as OwnerCommandRouterOptions;

  return {
    calendarGateway,
    close: () => {
      schedulingRepository.close();
      stateRepository.close();
    },
    localTaskAssistant,
    namedDeleteHandler,
    router: new OwnerCommandRouter(routerOptions),
    schedulingRepository,
    stateRepository,
  };
}

function seedReminder(fixture: ExplorationFixture, id = "reminder-play-among-us"): void {
  fixture.schedulingRepository.createScheduledItem({
    dueAt: new Date("2026-08-19T13:00:00.000Z"),
    id,
    kind: "reminder",
    now,
    ownerId,
    scheduledDate: "2026-08-19",
    timeZone,
    title: matchingTitle,
  });
}

function seedLocalTask(fixture: ExplorationFixture, id = "legacy-play-among-us"): void {
  fixture.stateRepository.createLocalTask({
    dueAt: new Date("2026-08-19T13:00:00.000Z"),
    id,
    now,
    ownerId,
    timeZone,
    title: matchingTitle,
  });
}

function seedCalendarEvent(fixture: ExplorationFixture): void {
  fixture.calendarGateway.events.push(calendarEvent());
}

function unfixedObservation(fixture: ExplorationFixture, input: {
  readonly calendarEventId?: string;
  readonly localTaskId?: string;
  readonly message: OwnerDirectMessage & { replies: string[] };
  readonly reminderId?: string;
}): string {
  const localTask = input.localTaskId
    ? fixture.stateRepository.getLocalTask({ id: input.localTaskId, ownerId })
    : undefined;
  const reminder = input.reminderId
    ? fixture.schedulingRepository.getScheduledItem({ id: input.reminderId, ownerId })
    : undefined;
  return [
    "Expected the named-delete coordinator to run before a result, but the unfixed local-only route was observed.",
    `action=${JSON.stringify(deleteAction())}`,
    `reply=${JSON.stringify(input.message.replies)}`,
    `namedHandlerCalls=${fixture.namedDeleteHandler.calls.length}`,
    `calendarReads=${fixture.calendarGateway.calendarReads.length}`,
    `eventReads=${fixture.calendarGateway.eventReads.length}`,
    `localTask=${localTask?.status ?? "absent"}`,
    `scheduledReminder=${reminder?.status ?? "absent"}`,
    `calendarEvent=${input.calendarEventId
      ? (fixture.calendarGateway.events.some((event) => event.id === input.calendarEventId) ? "present" : "absent")
      : "none"}`,
    `pendingCandidates=${fixture.namedDeleteHandler.pendingCandidates.length}`,
  ].join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("named delete bug-condition exploration", () => {
  it("resolves a reminder-only candidate instead of returning the legacy local no-match", async () => {
    const fixture = createFixture();
    const reminderId = "reminder-play-among-us";
    try {
      seedReminder(fixture, reminderId);
      const input = message("delete play among us");

      await fixture.router.handle(input);

      expect(fixture.namedDeleteHandler.calls, unfixedObservation(fixture, { message: input, reminderId })).toHaveLength(1);
      expect(fixture.namedDeleteHandler.readDomains).toEqual([
        "legacy_local_tasks",
        "scheduled_reminders",
        "calendar_list",
        "calendar_events:primary",
        "calendar_events:secondary",
      ]);
      expect(fixture.namedDeleteHandler.routedDomains).toEqual(["scheduled_reminder"]);
      expect(fixture.namedDeleteHandler.pendingCandidates).toHaveLength(1);
      expect(fixture.schedulingRepository.getScheduledItem({ id: reminderId, ownerId })).toMatchObject({ status: "active" });
      expect(input.replies.join(" ")).toMatch(/review/i);
    } finally {
      fixture.close();
    }
  });

  it("performs the authoritative secondary-Calendar read for a Calendar-only candidate", async () => {
    const fixture = createFixture();
    const eventId = "calendar-play-among-us";
    try {
      seedCalendarEvent(fixture);
      const input = message("delete play among us");

      await fixture.router.handle(input);

      expect(fixture.namedDeleteHandler.calls, unfixedObservation(fixture, { calendarEventId: eventId, message: input })).toHaveLength(1);
      expect(fixture.namedDeleteHandler.readDomains).toEqual([
        "legacy_local_tasks",
        "scheduled_reminders",
        "calendar_list",
        "calendar_events:primary",
        "calendar_events:secondary",
      ]);
      expect(fixture.namedDeleteHandler.routedDomains).toEqual(["calendar_event"]);
      expect(fixture.namedDeleteHandler.pendingCandidates).toHaveLength(1);
      expect(fixture.calendarGateway.calendarReads).toHaveLength(1);
      expect(fixture.calendarGateway.eventReads.map((read) => read.calendarId)).toContain("secondary");
      expect(fixture.calendarGateway.deleteCalls).toHaveLength(0);
      expect(fixture.calendarGateway.events.some((event) => event.id === eventId)).toBe(true);
      expect(input.replies.join(" ")).toMatch(/review/i);
    } finally {
      fixture.close();
    }
  });

  it("keeps matching candidates across domains for explicit selection instead of first-match cancellation", async () => {
    const fixture = createFixture();
    const localTaskId = "legacy-play-among-us";
    const reminderId = "reminder-play-among-us";
    const eventId = "calendar-play-among-us";
    try {
      seedLocalTask(fixture, localTaskId);
      seedReminder(fixture, reminderId);
      seedCalendarEvent(fixture);
      const input = message("delete play among us");

      await fixture.router.handle(input);

      expect(
        fixture.namedDeleteHandler.calls,
        unfixedObservation(fixture, { calendarEventId: eventId, localTaskId, message: input, reminderId }),
      ).toHaveLength(1);
      expect(fixture.namedDeleteHandler.readDomains).toEqual([
        "legacy_local_tasks",
        "scheduled_reminders",
        "calendar_list",
        "calendar_events:primary",
        "calendar_events:secondary",
      ]);
      const selection = fixture.namedDeleteHandler.selections[0] ?? [];
      expect(selection.map((candidate) => candidate.domain)).toEqual([
        "legacy_task",
        "scheduled_reminder",
        "calendar_event",
      ]);
      expect(fixture.namedDeleteHandler.routedDomains).toEqual([]);
      expect(fixture.namedDeleteHandler.pendingCandidates).toHaveLength(1);
      expect(fixture.stateRepository.getLocalTask({ id: localTaskId, ownerId })).toMatchObject({ status: "active" });
      expect(fixture.schedulingRepository.getScheduledItem({ id: reminderId, ownerId })).toMatchObject({ status: "active" });
      expect(fixture.calendarGateway.events.some((event) => event.id === eventId)).toBe(true);
      expect(fixture.calendarGateway.deleteCalls).toHaveLength(0);
      expect(input.replies.join(" ")).toMatch(/choose/i);
    } finally {
      fixture.close();
    }
  });
});
