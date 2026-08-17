import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import type { LocalTask } from "../src/tasks/task-domain.js";
import {
  LOCAL_TASK_REMINDER_WINDOW_MINUTES,
  LocalTaskReminderScheduler,
} from "../src/tasks/local-task-reminder-scheduler.js";

const ownerId = "123456789012345678";

function task(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    createdAt: new Date("2026-08-17T16:00:00.000Z"),
    dueAt: new Date("2026-08-17T18:00:00.000Z"),
    id: "task-1",
    ownerId,
    revision: 1,
    status: "active",
    timeZone: "America/Toronto",
    title: "Run",
    updatedAt: new Date("2026-08-17T16:00:00.000Z"),
    ...overrides,
  };
}

class FakeTaskState {
  public readonly claims = new Map<string, string>();
  public readonly deliveries = new Set<string>();

  public constructor(public tasks: LocalTask[]) { }

  public listDueLocalTasks(): readonly LocalTask[] {
    return this.tasks;
  }

  public tryClaimLocalTaskReminderDelivery(input: {
    claimToken: string;
    ownerId: string;
    scheduledFor: Date;
    taskId: string;
  }): boolean {
    const key = `${input.taskId}:${input.scheduledFor.toISOString()}`;
    const current = this.tasks.find((candidate) => candidate.id === input.taskId);
    if (!current || current.ownerId !== input.ownerId || current.status !== "active" || this.deliveries.has(key) || this.claims.has(key)) {
      return false;
    }
    this.claims.set(key, input.claimToken);
    return true;
  }

  public completeLocalTaskReminderDelivery(input: {
    claimToken: string;
    scheduledFor: Date;
    taskId: string;
  }): boolean {
    const key = `${input.taskId}:${input.scheduledFor.toISOString()}`;
    if (this.claims.get(key) !== input.claimToken) {
      return false;
    }
    this.claims.delete(key);
    this.deliveries.add(key);
    return true;
  }

  public releaseLocalTaskReminderClaim(input: { claimToken: string; scheduledFor: Date; taskId: string }): void {
    const key = `${input.taskId}:${input.scheduledFor.toISOString()}`;
    if (this.claims.get(key) === input.claimToken) {
      this.claims.delete(key);
    }
  }
}

describe("LocalTaskReminderScheduler", () => {
  it("sends each of the nine eligible slots once through the two-hour cutoff", async () => {
    const sent: string[] = [];
    const state = new FakeTaskState([task()]);
    let now = new Date("2026-08-17T18:00:00.000Z");
    const scheduler = new LocalTaskReminderScheduler({
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      sendOwnerMessage: async (content) => {
        sent.push(content);
      },
      stateRepository: state,
    });

    for (let offset = 0; offset <= LOCAL_TASK_REMINDER_WINDOW_MINUTES; offset += 15) {
      now = new Date(`2026-08-17T${String(18 + Math.floor(offset / 60)).padStart(2, "0")}:${String(offset % 60).padStart(2, "0")}:00.000Z`);
      await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 1 });
    }
    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 0 });

    expect(sent).toHaveLength(9);
    expect(sent[0]).toMatch(/Task reminder: Run/u);
    expect(sent.at(-1)).toMatch(/Late task reminder/u);
  });

  it("uses only the newest eligible slot after downtime and skips work after the original window", async () => {
    const sent: string[] = [];
    const state = new FakeTaskState([task()]);
    let now = new Date("2026-08-17T18:44:00.000Z");
    const scheduler = new LocalTaskReminderScheduler({
      logger: createLogger("silent"),
      now: () => now,
      ownerId,
      sendOwnerMessage: async (content) => {
        sent.push(content);
      },
      stateRepository: state,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 1 });
    expect([...state.deliveries][0]).toContain("2026-08-17T18:30:00.000Z");

    now = new Date("2026-08-17T20:00:00.001Z");
    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
  });

  it("claims a slot before sending so a concurrent scheduler skips the same reminder", async () => {
    const state = new FakeTaskState([task()]);
    let openSend: (() => void) | undefined;
    let sentStarted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => { openSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { sentStarted = resolve; });
    const first = new LocalTaskReminderScheduler({
      logger: createLogger("silent"),
      now: () => new Date("2026-08-17T18:00:00.000Z"),
      ownerId,
      sendOwnerMessage: async () => {
        sentStarted?.();
        await sendGate;
      },
      stateRepository: state,
    });
    const second = new LocalTaskReminderScheduler({
      logger: createLogger("silent"),
      now: () => new Date("2026-08-17T18:00:00.000Z"),
      ownerId,
      sendOwnerMessage: async () => {
        throw new Error("A second worker must not send this slot");
      },
      stateRepository: state,
    });

    const firstRun = first.runOnce();
    await sendStarted;
    await expect(second.runOnce()).resolves.toMatchObject({ delivered: 0, skipped: 1 });
    openSend?.();
    await expect(firstRun).resolves.toMatchObject({ delivered: 1 });
  });

  it("releases a claim and does not record a slot when Discord delivery fails", async () => {
    const state = new FakeTaskState([task()]);
    const scheduler = new LocalTaskReminderScheduler({
      logger: createLogger("silent"),
      now: () => new Date("2026-08-17T18:00:00.000Z"),
      ownerId,
      sendOwnerMessage: async () => {
        throw new Error("Discord unavailable");
      },
      stateRepository: state,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 0, failed: 1 });
    expect(state.deliveries).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });
});
