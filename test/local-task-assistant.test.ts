import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import type { PendingAction } from "../src/persistence/state-repository.js";
import type {
  CreateLocalTaskInput,
  LocalTask,
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

  public listActiveLocalTasks(): readonly LocalTask[] {
    return [...this.tasks.values()].filter((task) => task.status === "active").sort((a, b) => a.dueAt.valueOf() - b.dueAt.valueOf());
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

function createAssistant(state = new FakeTaskState(), commandPlanner?: TaskCommandPlanner): LocalTaskAssistant {
  return new LocalTaskAssistant({
    ...(commandPlanner ? { commandPlanner } : {}),
    logger: createLogger("silent"),
    now: () => now,
    ownerId,
    stateRepository: state,
    timeZone: "America/Toronto",
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

  it("requires confirmation for a Gemini-proposed task creation", async () => {
    const state = new FakeTaskState();
    const planner = new FakeTaskPlanner({ date: "2026-08-18", kind: "create", time: "18:00", title: "run" });
    const assistant = createAssistant(state, planner);
    const request = message("Please make sure I remember to run tomorrow evening");

    await assistant.handle(request);
    expect(planner.calls).toHaveLength(1);
    expect(state.listActiveLocalTasks()).toHaveLength(0);
    const id = actionId(request.replies.join(" "));

    await assistant.handle(message(`confirm ${id}`));
    expect(state.listActiveLocalTasks()).toHaveLength(1);
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

  it("requires confirmation for Gemini-proposed task completions and cancellations", async () => {
    async function queueTransition(operation: "cancel" | "complete", taskId: string, title: string) {
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
      expect(state.getLocalTask({ id: taskId, ownerId })).toMatchObject({ status: "active" });
      return { actionId: actionId(request.replies.join(" ")), assistant, state };
    }

    const complete = await queueTransition("complete", "complete-task", "Run");
    await complete.assistant.handle(message(`confirm ${complete.actionId}`));
    expect(complete.state.getLocalTask({ id: "complete-task", ownerId })).toMatchObject({ status: "completed" });

    const cancel = await queueTransition("cancel", "cancel-task", "Walk");
    await cancel.assistant.handle(message(`confirm ${cancel.actionId}`));
    expect(cancel.state.getLocalTask({ id: "cancel-task", ownerId })).toMatchObject({ status: "cancelled" });

    for (const operation of ["complete", "cancel"] as const) {
      const declined = await queueTransition(operation, `decline-${operation}`, `Decline ${operation}`);
      await declined.assistant.handle(message(`cancel ${declined.actionId}`));
      expect(declined.state.getLocalTask({ id: `decline-${operation}`, ownerId })).toMatchObject({ status: "active" });

      const lateConfirmation = message(`confirm ${declined.actionId}`);
      expect(await declined.assistant.handlePendingAction(lateConfirmation, {
        actionId: declined.actionId,
        kind: "confirm",
      })).toBe(false);
      expect(declined.state.getLocalTask({ id: `decline-${operation}`, ownerId })).toMatchObject({ status: "active" });
    }
  });
});
