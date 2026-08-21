import { describe, expect, it } from "vitest";

import { withGeminiResponseAttribution } from "../src/application/gemini-response-attribution.js";
import { createLogger } from "../src/logger.js";
import type { PendingAction } from "../src/persistence/state-repository.js";
import type {
  CreateLocalTaskInput,
  LocalTask,
  LocalTaskBulkCancellationInput,
  LocalTaskTransitionInput,
} from "../src/tasks/task-domain.js";
import type { ParsedTaskCommand } from "../src/tasks/deterministic-task-parser.js";
import { LocalTaskAssistant } from "../src/tasks/local-task-assistant.js";
import type { TaskCommandPlanner, TaskCommandPlanningInput } from "../src/tasks/task-command-planner.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";

const ownerId = "123456789012345678";
const now = new Date("2026-08-17T20:00:00.000Z");

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: "message-1",
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

class FakeTaskState {
  public readonly audits: Array<{ actionType: string; status: "failed" | "succeeded" }> = [];
  public readonly dueRangeQueries: Array<{
    dueAtEarliest: Date;
    dueAtLatest: Date;
    limit: number;
    ownerId: string;
  }> = [];
  public readonly pending = new Map<string, { expiresAt: Date; ownerId: string; payload: unknown }>();
  public readonly tasks = new Map<string, LocalTask>();

  public createLocalTask(input: CreateLocalTaskInput): LocalTask {
    const task: LocalTask = {
      createdAt: input.now,
      dueAt: input.dueAt,
      id: input.id,
      ownerId: input.ownerId,
      revision: 1,
      status: "active",
      timeZone: input.timeZone,
      title: input.title,
      updatedAt: input.now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  public createPendingAction(input: { expiresAt: Date; id: string; ownerId: string; payload: unknown }): void {
    this.pending.set(input.id, input);
  }

  public getPendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined {
    const pending = this.pending.get(input.id);
    if (!pending || pending.ownerId !== input.ownerId || pending.expiresAt <= input.now) {
      return undefined;
    }
    return { createdAt: now, expiresAt: pending.expiresAt, id: input.id, ownerId: input.ownerId, payload: pending.payload };
  }

  public consumePendingAction(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined {
    const pending = this.getPendingAction(input);
    if (pending) {
      this.pending.delete(input.id);
    }
    return pending;
  }

  public listActiveLocalTasks(input: { limit?: number; ownerId?: string } = {}): readonly LocalTask[] {
    return [...this.tasks.values()]
      .filter((task) => (!input.ownerId || task.ownerId === input.ownerId) && task.status === "active")
      .sort((a, b) => a.dueAt.valueOf() - b.dueAt.valueOf())
      .slice(0, input.limit ?? 10_000);
  }

  public listActiveLocalTasksInRange(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    limit: number;
    ownerId: string;
  }): readonly LocalTask[] {
    this.dueRangeQueries.push(input);
    return this.listActiveLocalTasks({ ownerId: input.ownerId })
      .filter((task) => task.dueAt >= input.dueAtEarliest && task.dueAt <= input.dueAtLatest)
      .slice(0, input.limit);
  }

  public getLocalTask(input: { id: string; ownerId: string }): LocalTask | undefined {
    const task = this.tasks.get(input.id);
    return task?.ownerId === input.ownerId ? task : undefined;
  }

  public completeLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined {
    return this.transition(input, "completed");
  }

  public cancelLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined {
    return this.transition(input, "cancelled");
  }

  public cancelLocalTasks(input: LocalTaskBulkCancellationInput): readonly LocalTask[] | undefined {
    if (input.tasks.length === 0 || new Set(input.tasks.map((task) => task.id)).size !== input.tasks.length) {
      return undefined;
    }

    const matches = input.tasks.map((target) => ({
      target,
      task: this.getLocalTask({ id: target.id, ownerId: input.ownerId }),
    }));
    if (matches.some(({ target, task }) => !task || task.status !== "active" || task.revision !== target.expectedRevision)) {
      return undefined;
    }

    const cancelled: LocalTask[] = [];
    for (const { task } of matches) {
      if (!task) {
        return undefined;
      }
      const updated: LocalTask = {
        ...task,
        cancelledAt: input.now,
        revision: task.revision + 1,
        status: "cancelled",
        updatedAt: input.now,
      };
      this.tasks.set(updated.id, updated);
      cancelled.push(updated);
    }
    return cancelled;
  }

  public recordAudit(input: { actionType: string; status: "failed" | "succeeded" }): void {
    this.audits.push(input);
  }

  private transition(input: LocalTaskTransitionInput, status: "cancelled" | "completed"): LocalTask | undefined {
    const existing = this.getLocalTask(input);
    if (!existing || existing.status !== "active" || existing.revision !== input.expectedRevision) {
      return undefined;
    }
    const updated: LocalTask = {
      ...existing,
      ...(status === "completed" ? { completedAt: input.now } : { cancelledAt: input.now }),
      revision: existing.revision + 1,
      status,
      updatedAt: input.now,
    };
    this.tasks.set(updated.id, updated);
    return updated;
  }
}

class FakeTaskPlanner implements TaskCommandPlanner {
  public readonly calls: TaskCommandPlanningInput[] = [];

  public constructor(private readonly result: ParsedTaskCommand | undefined) { }

  public async plan(input: TaskCommandPlanningInput): Promise<ParsedTaskCommand | undefined> {
    this.calls.push(input);
    return this.result;
  }
}

function createAssistant(
  state = new FakeTaskState(),
  commandPlanner?: TaskCommandPlanner,
  timeZone = "America/Toronto",
  nowProvider: () => Date = () => now,
): LocalTaskAssistant {
  return new LocalTaskAssistant({
    ...(commandPlanner ? { commandPlanner } : {}),
    logger: createLogger("silent"),
    now: nowProvider,
    ownerId,
    stateRepository: state,
    timeZone,
  });
}

function actionId(reply: string, command: "choose" | "confirm" = "confirm"): string {
  const id = new RegExp(`${command} ([a-f0-9-]+)`, "iu").exec(reply)?.[1];
  if (!id) {
    throw new Error(`Expected ${command} action id in ${reply}`);
  }
  return id;
}

describe("LocalTaskAssistant", () => {
  it("creates and lists a deterministic task without a model or Google dependency", async () => {
    const state = new FakeTaskState();
    const assistant = createAssistant(state);
    const create = message("remind me at 6pm tomorrow to run");

    await assistant.handle(create);
    expect(create.replies.join(" ")).toMatch(/Created local task: run/i);
    expect(state.listActiveLocalTasks()).toHaveLength(1);

    const list = message("tasks");
    await assistant.handle(list);
    expect(list.replies.join(" ")).toMatch(/Active local tasks/i);
    expect(list.replies.join(" ")).toMatch(/run/i);
  });

  it("creates relative hour and minute tasks deterministically without invoking the planner", async () => {
    const state = new FakeTaskState();
    const planner = new FakeTaskPlanner({ date: "2026-08-18", kind: "create", time: "18:00", title: "walk" });
    const assistant = createAssistant(state, planner);

    await assistant.handle(message("remind me in 30 mins to run"));
    await assistant.handle(message("remind me in 1 hr to stretch"));

    expect(planner.calls).toHaveLength(0);
    expect(state.listActiveLocalTasks()).toHaveLength(2);
    expect(state.listActiveLocalTasks()[0]).toMatchObject({
      dueAt: new Date("2026-08-17T20:30:00.000Z"),
      timeZone: "America/Toronto",
      title: "run",
    });
    expect(state.listActiveLocalTasks()[1]).toMatchObject({
      dueAt: new Date("2026-08-17T21:00:00.000Z"),
      timeZone: "America/Toronto",
      title: "stretch",
    });
  });

  it("lists only active tasks due on the requested local date without invoking Gemini", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-17T22:00:00.000Z"),
      id: "today-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Today task",
    });
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "tomorrow-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Tomorrow task",
    });
    const planner = new FakeTaskPlanner({ kind: "list" });
    const assistant = createAssistant(state, planner);
    const request = message("what tasks do I have today?");

    await assistant.handle(request);

    expect(planner.calls).toHaveLength(0);
    expect(state.dueRangeQueries).toHaveLength(1);
    expect(state.dueRangeQueries[0]).toMatchObject({ limit: 21, ownerId });
    expect(request.replies.join(" ")).toMatch(/Active local tasks for <t:\d+:D>/iu);
    expect(request.replies.join(" ")).not.toContain("2026-08-17");
    expect(request.replies.join(" ")).toContain("Today task");
    expect(request.replies.join(" ")).not.toContain("Tomorrow task");
  });

  it("uses the configured task time zone consistently for date-filtered lists", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-17T04:30:00.000Z"),
      id: "prior-day-in-chicago",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Prior configured-day task",
    });
    state.createLocalTask({
      dueAt: new Date("2026-08-17T22:00:00.000Z"),
      id: "today-in-chicago",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Configured today task",
    });
    const assistant = createAssistant(state, undefined, "America/Chicago");
    const request = message("what tasks do I have today?");

    await assistant.handle(request);

    expect(request.replies.join(" ")).toContain("Configured today task");
    expect(request.replies.join(" ")).not.toContain("Prior configured-day task");
    expect(request.replies.join(" ")).toContain("America/Chicago");
  });

  it("completes a unique task and preserves the terminal task outside the active list", async () => {
    const state = new FakeTaskState();
    const assistant = createAssistant(state);
    await assistant.handle(message("remind me at 6pm tomorrow to run"));

    const complete = message("done run");
    await assistant.handle(complete);

    expect(complete.replies.join(" ")).toMatch(/Completed local task: run/i);
    expect([...state.tasks.values()][0]).toMatchObject({ status: "completed" });
    expect(state.listActiveLocalTasks()).toHaveLength(0);
  });

  it("deletes a uniquely matching task immediately without invoking the planner", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "run-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Run",
    });
    const planner = new FakeTaskPlanner({ kind: "list" });
    const assistant = createAssistant(state, planner);
    const request = message("delete task run");

    await assistant.handle(request);

    expect(planner.calls).toHaveLength(0);
    expect(state.pending.size).toBe(0);
    expect(state.getLocalTask({ id: "run-task", ownerId })).toMatchObject({ status: "cancelled" });
    expect(request.replies.join(" ")).toMatch(/Cancelled local task: Run/i);
  });

  it("requires confirmation before deleting all active tasks, including one task", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "only-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Only task",
    });
    const assistant = createAssistant(state);
    const request = message("delete all tasks");

    await assistant.handle(request);

    const firstId = actionId(request.replies.join(" "));
    expect(state.getLocalTask({ id: "only-task", ownerId })).toMatchObject({ status: "active" });
    expect(request.replies.join(" ")).toMatch(/Review: delete 1 future active local task/i);

    await assistant.handle(message(`cancel ${firstId}`));
    expect(state.getLocalTask({ id: "only-task", ownerId })).toMatchObject({ status: "active" });

    const retry = message("delete all tasks");
    await assistant.handle(retry);
    await assistant.handle(message(`confirm ${actionId(retry.replies.join(" "))}`));
    expect(state.getLocalTask({ id: "only-task", ownerId })).toMatchObject({ status: "cancelled" });
  });

  it("only considers strictly future tasks for an unscoped bulk delete", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date(now.valueOf() - 1),
      id: "past-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Past task",
    });
    state.createLocalTask({
      dueAt: now,
      id: "current-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Current task",
    });
    state.createLocalTask({
      dueAt: new Date(now.valueOf() + 60 * 60 * 1_000),
      id: "future-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Future task",
    });
    const assistant = createAssistant(state);
    const request = message("delete all tasks");

    await assistant.handle(request);

    expect(state.dueRangeQueries).toHaveLength(1);
    expect(state.dueRangeQueries[0]?.dueAtEarliest).toEqual(new Date(now.valueOf() + 1));
    expect(request.replies.join(" ")).toMatch(/Review: delete 1 future active local task/i);
    const id = actionId(request.replies.join(" "));
    await assistant.handle(message(`confirm ${id}`));

    expect(state.getLocalTask({ id: "past-task", ownerId })).toMatchObject({ status: "active" });
    expect(state.getLocalTask({ id: "current-task", ownerId })).toMatchObject({ status: "active" });
    expect(state.getLocalTask({ id: "future-task", ownerId })).toMatchObject({ status: "cancelled" });
  });

  it("does not cancel an unscoped bulk task after it reaches its due time", async () => {
    const state = new FakeTaskState();
    let currentNow = now;
    const task = state.createLocalTask({
      dueAt: new Date(now.valueOf() + 60_000),
      id: "aging-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Aging task",
    });
    const assistant = createAssistant(state, undefined, "America/Toronto", () => currentNow);
    const request = message("delete all tasks");

    await assistant.handle(request);

    const id = actionId(request.replies.join(" "));
    currentNow = new Date(now.valueOf() + 120_000);
    await assistant.handle(message(`confirm ${id}`));

    expect(state.getLocalTask({ id: task.id, ownerId })).toMatchObject({ status: "active" });
    expect(request.replies.join(" ")).toMatch(/Review: delete 1 future active local task/i);
  });

  it("deletes one task for today immediately without touching another day", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-17T22:00:00.000Z"),
      id: "today-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Today task",
    });
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "tomorrow-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Tomorrow task",
    });
    const assistant = createAssistant(state);

    await assistant.handle(message("delete all tasks for today"));

    expect(state.pending.size).toBe(0);
    expect(state.getLocalTask({ id: "today-task", ownerId })).toMatchObject({ status: "cancelled" });
    expect(state.getLocalTask({ id: "tomorrow-task", ownerId })).toMatchObject({ status: "active" });
  });

  it("requires confirmation before deleting multiple tasks for today", async () => {
    const state = new FakeTaskState();
    for (const [id, title, dueAt] of [
      ["today-task-1", "Today task one", "2026-08-17T19:00:00.000Z"],
      ["today-task-2", "Today task two", "2026-08-17T19:30:00.000Z"],
      ["tomorrow-task", "Tomorrow task", "2026-08-18T22:00:00.000Z"],
    ] as const) {
      state.createLocalTask({ dueAt: new Date(dueAt), id, now, ownerId, timeZone: "America/Toronto", title });
    }
    let currentNow = now;
    const assistant = createAssistant(state, undefined, "America/Toronto", () => currentNow);
    const request = message("delete all tasks for today");

    await assistant.handle(request);

    const id = actionId(request.replies.join(" "));
    expect(state.getLocalTask({ id: "today-task-1", ownerId })).toMatchObject({ status: "active" });
    expect(state.getLocalTask({ id: "today-task-2", ownerId })).toMatchObject({ status: "active" });

    currentNow = new Date(now.valueOf() + 60_000);
    await assistant.handle(message(`confirm ${id}`));

    expect(state.getLocalTask({ id: "today-task-1", ownerId })).toMatchObject({ status: "cancelled" });
    expect(state.getLocalTask({ id: "today-task-2", ownerId })).toMatchObject({ status: "cancelled" });
    expect(state.getLocalTask({ id: "tomorrow-task", ownerId })).toMatchObject({ status: "active" });
  });

  it("keeps an ambiguous task selection usable after an invalid choice", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"), id: "run-1", now, ownerId, timeZone: "America/Toronto", title: "Run outside",
    });
    state.createLocalTask({
      dueAt: new Date("2026-08-19T22:00:00.000Z"), id: "run-2", now, ownerId, timeZone: "America/Toronto", title: "Run inside",
    });
    const assistant = createAssistant(state);
    const request = message("done run");

    await assistant.handle(request);
    const id = actionId(request.replies.join(" "), "choose");
    await assistant.handle(message(`choose ${id} 3`));
    expect(state.listActiveLocalTasks()).toHaveLength(2);

    await assistant.handle(message(`choose ${id} 2`));
    expect(state.listActiveLocalTasks()).toHaveLength(1);
    expect(state.getLocalTask({ id: "run-2", ownerId })).toMatchObject({ status: "completed" });
  });

  it("executes a complete Gemini-proposed task creation without confirmation", async () => {
    const state = new FakeTaskState();
    const planner = new FakeTaskPlanner({ date: "2026-08-18", kind: "create", time: "18:00", title: "run" });
    const assistant = createAssistant(state, planner);
    const request = message("Please make sure I remember to run tomorrow evening");

    await assistant.handle(withGeminiResponseAttribution(request, true));

    expect(planner.calls).toHaveLength(1);
    expect(state.listActiveLocalTasks()).toHaveLength(1);
    expect(request.replies.join(" ")).toMatch(/Created local task: run/i);
    expect(request.replies.join(" ")).toMatch(/\[Gemini\]$/u);
    expect(request.replies.join(" ")).not.toMatch(/confirm|review/i);
  });

  it("labels a Gemini-proposed task selection after its persisted follow-up", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"), id: "run-one", now, ownerId, timeZone: "America/Toronto", title: "Run outside",
    });
    state.createLocalTask({
      dueAt: new Date("2026-08-19T22:00:00.000Z"), id: "run-two", now, ownerId, timeZone: "America/Toronto", title: "Run inside",
    });
    const planner = new FakeTaskPlanner({ kind: "complete", selector: { title: "run" } });
    const assistant = createAssistant(state, planner);
    const request = message("to-do complete run");

    await assistant.handle(withGeminiResponseAttribution(request, true));

    const id = actionId(request.replies.join(" "), "choose");
    const selection = message(`choose ${id} 1`);
    await assistant.handle(withGeminiResponseAttribution(selection, true));

    expect(state.getLocalTask({ id: "run-one", ownerId })).toMatchObject({ status: "completed" });
    expect(selection.replies.join(" ")).toMatch(/Completed local task: Run outside\. \[Gemini\]$/u);
  });

  it("responds clearly to recurring task requests without calling a model", async () => {
    const planner = new FakeTaskPlanner({ date: "2026-08-18", kind: "create", time: "18:00", title: "run" });
    const assistant = createAssistant(new FakeTaskState(), planner);
    const request = message("remind me every Tuesday at 6pm to run");

    await assistant.handle(request);
    expect(planner.calls).toHaveLength(0);
    expect(request.replies.join(" ")).toMatch(/Recurring local tasks are not supported/i);
  });

  it("does not apply a generic done task request or send it to Gemini", async () => {
    const state = new FakeTaskState();
    state.createLocalTask({
      dueAt: new Date("2026-08-18T22:00:00.000Z"),
      id: "run-task",
      now,
      ownerId,
      timeZone: "America/Toronto",
      title: "Run",
    });
    const planner = new FakeTaskPlanner({ date: "2026-08-18", kind: "create", time: "18:00", title: "walk" });
    const assistant = createAssistant(state, planner);
    const request = message("done task");

    await assistant.handle(request);

    expect(planner.calls).toHaveLength(0);
    expect(state.getLocalTask({ id: "run-task", ownerId })).toMatchObject({ status: "active" });
    expect(request.replies.join(" ")).toMatch(/Please specify the task to complete or cancel/i);
  });

  it("executes Gemini-proposed task completions and cancellations without confirmation", async () => {
    async function runTransition(operation: "cancel" | "complete", taskId: string, title: string) {
      const state = new FakeTaskState();
      state.createLocalTask({
        dueAt: new Date("2026-08-18T22:00:00.000Z"),
        id: taskId,
        now,
        ownerId,
        timeZone: "America/Toronto",
        title,
      });
      const planner = new FakeTaskPlanner({ kind: operation, selector: { title } });
      const assistant = createAssistant(state, planner);
      const request = message(`to-do ${operation} ${title}`);

      await assistant.handle(request);

      expect(planner.calls).toHaveLength(1);
      expect(state.getLocalTask({ id: taskId, ownerId })).toMatchObject({
        status: operation === "complete" ? "completed" : "cancelled",
      });
      expect(request.replies.join(" ")).not.toMatch(/confirm|review/i);
      return state;
    }

    const complete = await runTransition("complete", "complete-task", "Run");
    expect(complete.getLocalTask({ id: "complete-task", ownerId })).toMatchObject({ status: "completed" });

    const cancel = await runTransition("cancel", "cancel-task", "Walk");
    expect(cancel.getLocalTask({ id: "cancel-task", ownerId })).toMatchObject({ status: "cancelled" });
  });
});


describe("LocalTaskAssistant natural-language entry point", () => {
  it("allows a classifier-selected natural request to reach the task planner", async () => {
    const state = new FakeTaskState();
    const planner = new FakeTaskPlanner({
      date: "2026-08-18",
      kind: "create",
      time: "18:00",
      title: "run",
    });
    const assistant = createAssistant(state, planner);
    const request = message("I need to remember to run tomorrow at six.");

    await assistant.handleNaturalLanguage(request);

    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]).toMatchObject({ text: request.content, timeZone: "America/Toronto" });
    expect(state.listActiveLocalTasks()).toHaveLength(1);
    expect(request.replies.join(" ")).toMatch(/Created local task: run/i);
    expect(request.replies.join(" ")).not.toMatch(/confirm|review/i);
  });
});

describe("LocalTaskAssistant unified deletion policy", () => {
  function addTask(state: FakeTaskState, id: string, title: string, dueAt: string): void {
    state.createLocalTask({
      dueAt: new Date(dueAt),
      id,
      now,
      ownerId,
      timeZone: "America/Toronto",
      title,
    });
  }

  it("always reviews delete-all requests when future tasks exist", async () => {
    const state = new FakeTaskState();
    addTask(state, "all-one", "one", "2026-08-17T21:00:00.000Z");
    const assistant = createAssistant(state);
    const request = message("delete all tasks");

    await assistant.handleNaturalLanguageAction(request, { action: "delete_task", scope: "all" });

    expect(request.replies[0]).toMatch(/Review: delete 1 future active local task/i);
    expect(state.listActiveLocalTasks()).toHaveLength(1);
    expect(state.pending.size).toBe(1);
  });

  it("deletes one future task for today immediately but reviews multiple future tasks", async () => {
    const oneState = new FakeTaskState();
    addTask(oneState, "today-one", "one", "2026-08-17T21:00:00.000Z");
    addTask(oneState, "today-past", "past", "2026-08-17T19:00:00.000Z");
    const oneAssistant = createAssistant(oneState);
    const oneRequest = message("delete all tasks for today");

    await oneAssistant.handleNaturalLanguageAction(oneRequest, {
      action: "delete_task",
      date: "2026-08-17",
      scope: "today",
    });

    expect(oneRequest.replies.join(" ")).toMatch(/Cancelled local task: one/i);
    expect(oneState.getLocalTask({ id: "today-past", ownerId })?.status).toBe("active");

    const manyState = new FakeTaskState();
    addTask(manyState, "today-a", "a", "2026-08-17T21:00:00.000Z");
    addTask(manyState, "today-b", "b", "2026-08-17T22:00:00.000Z");
    const manyAssistant = createAssistant(manyState);
    const manyRequest = message("delete all tasks for today");

    await manyAssistant.handleNaturalLanguageAction(manyRequest, {
      action: "delete_task",
      date: "2026-08-17",
      scope: "today",
    });

    expect(manyRequest.replies[0]).toMatch(/Review: delete 2 future active local tasks/i);
    expect(manyState.listActiveLocalTasks()).toHaveLength(2);
  });

  it("executes a unique single delete, selects multiple matches, and clarifies no matches", async () => {
    const uniqueState = new FakeTaskState();
    addTask(uniqueState, "unique", "call plumber", "2026-08-18T21:00:00.000Z");
    const uniqueAssistant = createAssistant(uniqueState);
    const uniqueRequest = message("delete task call plumber");
    await uniqueAssistant.handleNaturalLanguageAction(uniqueRequest, {
      action: "delete_task",
      scope: "single",
      selector: { title: "call plumber" },
    });
    expect(uniqueRequest.replies.join(" ")).toMatch(/Cancelled local task: call plumber/i);
    expect(uniqueState.getLocalTask({ id: "unique", ownerId })?.status).toBe("cancelled");

    const manyState = new FakeTaskState();
    addTask(manyState, "many-a", "call plumber", "2026-08-18T21:00:00.000Z");
    addTask(manyState, "many-b", "call plumber", "2026-08-19T21:00:00.000Z");
    const manyAssistant = createAssistant(manyState);
    const manyRequest = message("delete task call plumber");
    await manyAssistant.handleNaturalLanguageAction(manyRequest, {
      action: "delete_task",
      scope: "single",
      selector: { title: "call plumber" },
    });
    expect(manyRequest.replies[0]).toMatch(/multiple active local tasks/i);
    expect(manyRequest.replies[0]).not.toMatch(/confirm/i);

    const noneState = new FakeTaskState();
    const noneAssistant = createAssistant(noneState);
    const noneRequest = message("delete task missing");
    await noneAssistant.handleNaturalLanguageAction(noneRequest, {
      action: "delete_task",
      scope: "single",
      selector: { title: "missing" },
    });
    expect(noneRequest.replies).toEqual([expect.stringMatching(/could not find an active local task/i)]);
  });
});
