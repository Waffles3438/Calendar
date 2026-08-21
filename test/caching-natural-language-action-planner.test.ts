import { describe, expect, it, vi } from "vitest";

import {
  CachingNaturalLanguageActionPlanner,
  NATURAL_LANGUAGE_ACTION_CACHE_TTL_MILLISECONDS,
} from "../src/nlp/caching-natural-language-action-planner.js";
import type {
  NaturalLanguageAction,
  NaturalLanguageActionPlanningInput,
} from "../src/nlp/natural-language-action.js";
import type { NaturalLanguageActionPlanner } from "../src/nlp/natural-language-action-planner.js";

const timeZone = "America/Toronto";
const ownerId = "123456789012345678";
const agendaAction: NaturalLanguageAction = {
  action: "show_agenda",
  date: "2026-08-21",
  endDate: "2026-08-21",
  range: "day",
};
const taskListAction: NaturalLanguageAction = {
  action: "list_tasks",
  date: "2026-08-21",
};

function input(overrides: Partial<NaturalLanguageActionPlanningInput> = {}): NaturalLanguageActionPlanningInput {
  return {
    now: new Date("2026-08-21T17:00:00.000Z"),
    text: "What do I need to do today?",
    timeZone,
    ...overrides,
  };
}

function planner(action: NaturalLanguageAction | undefined = agendaAction): {
  planner: NaturalLanguageActionPlanner;
  plan: ReturnType<typeof vi.fn>;
} {
  const plan = vi.fn(async () => action);
  return { plan, planner: { plan } };
}

describe("CachingNaturalLanguageActionPlanner", () => {
  it("reuses an exact normalized action without persisting it", async () => {
    const fake = planner();
    const cache = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
    });

    await expect(cache.plan(input())).resolves.toEqual(agendaAction);
    await expect(cache.plan(input({ text: "  What   do I need to do today?  " }))).resolves.toEqual(agendaAction);

    expect(fake.plan).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("expires entries after ten minutes", async () => {
    const fake = planner();
    const cache = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
    });

    await cache.plan(input({ now: new Date("2026-08-21T17:00:00.000Z") }));
    await cache.plan(input({ now: new Date("2026-08-21T17:04:00.000Z") }));
    await cache.plan(input({ now: new Date("2026-08-21T17:10:01.000Z") }));

    expect(fake.plan).toHaveBeenCalledTimes(2);
    expect(NATURAL_LANGUAGE_ACTION_CACHE_TTL_MILLISECONDS).toBe(600_000);
  });

  it("misses when context, time zone, model, or planner version changes", async () => {
    const fake = planner();
    const context = {
      clarificationQuestion: "Which one?",
      originalRequest: "Schedule the usual thing.",
      reason: "ambiguous_intent" as const,
      recentMessages: ["The dentist appointment."],
    };
    const cache = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
      plannerVersion: "1",
    });

    await cache.plan(input());
    await cache.plan(input({ context }));
    await cache.plan(input({ timeZone: "UTC" }));

    const otherModel = new CachingNaturalLanguageActionPlanner({
      model: "gemini-other-model",
      ownerId,
      planner: fake.planner,
      plannerVersion: "1",
    });
    await otherModel.plan(input());
    const otherVersion = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
      plannerVersion: "2",
    });
    await otherVersion.plan(input());

    expect(fake.plan).toHaveBeenCalledTimes(5);
  });

  it("revalidates a cached reminder when it becomes past within the same time bucket", async () => {
    const reminder: NaturalLanguageAction = {
      action: "create_task_or_reminder",
      date: "2026-08-21",
      scheduleKind: "reminder",
      startTime: "13:58",
      title: "call the plumber",
    };
    const fake = planner(reminder);
    const cache = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
    });

    await expect(cache.plan(input({
      now: new Date("2026-08-21T17:55:00.000Z"),
      text: "Remind me at 1:58pm to call the plumber.",
    }))).resolves.toEqual(reminder);
    await expect(cache.plan(input({
      now: new Date("2026-08-21T17:59:00.000Z"),
      text: "Remind me at 1:58pm to call the plumber.",
    }))).resolves.toBeUndefined();

    expect(fake.plan).toHaveBeenCalledTimes(2);
  });

  it("does not cache undefined results and starts empty after a new instance", async () => {
    const undefinedFake = planner();
    undefinedFake.plan.mockResolvedValue(undefined);
    const cache = new CachingNaturalLanguageActionPlanner({
      model: "gemini-test-model",
      ownerId,
      planner: undefinedFake.planner,
    });
    await cache.plan(input());
    await cache.plan(input());
    expect(undefinedFake.plan).toHaveBeenCalledTimes(2);

    const fake = planner();
    const first = new CachingNaturalLanguageActionPlanner({ model: "gemini-test-model", ownerId, planner: fake.planner });
    const second = new CachingNaturalLanguageActionPlanner({ model: "gemini-test-model", ownerId, planner: fake.planner });
    await first.plan(input());
    await second.plan(input());
    expect(fake.plan).toHaveBeenCalledTimes(2);
  });

  it("bounds entries with least-recently-used eviction", async () => {
    const fake = planner(taskListAction);
    const cache = new CachingNaturalLanguageActionPlanner({
      maxEntries: 2,
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
    });

    await cache.plan(input({ text: "tasks for today" }));
    await cache.plan(input({ text: "tasks for tomorrow" }));
    await cache.plan(input({ text: "tasks for Friday" }));
    expect(cache.size).toBe(2);
    await cache.plan(input({ text: "tasks for today" }));

    expect(fake.plan).toHaveBeenCalledTimes(4);
  });

  it("invalidates Calendar actions by generation but retains local task actions", async () => {
    let generation = 0;
    const changeSource = {
      getGeneration: () => generation,
      subscribe: () => () => undefined,
    };
    const calendarFake = planner(agendaAction);
    const calendarCache = new CachingNaturalLanguageActionPlanner({
      calendarChanges: changeSource,
      model: "gemini-test-model",
      ownerId,
      planner: calendarFake.planner,
    });
    await calendarCache.plan(input());
    generation = 1;
    await calendarCache.plan(input());
    expect(calendarFake.plan).toHaveBeenCalledTimes(2);

    const taskFake = planner(taskListAction);
    const taskCache = new CachingNaturalLanguageActionPlanner({
      calendarChanges: changeSource,
      model: "gemini-test-model",
      ownerId,
      planner: taskFake.planner,
    });
    await taskCache.plan(input({ text: "show my tasks" }));
    generation = 2;
    await taskCache.plan(input({ text: "show my tasks" }));
    expect(taskFake.plan).toHaveBeenCalledTimes(1);
  });

  it("removes Calendar actions when the change source notifies subscribers", async () => {
    let listener: (() => void) | undefined;
    const fake = planner();
    const cache = new CachingNaturalLanguageActionPlanner({
      calendarChanges: {
        getGeneration: () => 0,
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      },
      model: "gemini-test-model",
      ownerId,
      planner: fake.planner,
    });

    await cache.plan(input());
    listener?.();
    await cache.plan(input());

    expect(fake.plan).toHaveBeenCalledTimes(2);
  });
});
