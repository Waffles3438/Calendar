import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStateRepository } from "../src/persistence/state-repository.js";

const ownerId = "123456789012345678";

function taskInput(id: string, title: string, dueAt: string) {
  return {
    dueAt: new Date(dueAt),
    id,
    now: new Date("2026-08-17T12:00:00.000Z"),
    ownerId,
    timeZone: "America/Toronto",
    title,
  };
}

describe("AppStateRepository local tasks", () => {
  let temporaryDirectory: string | undefined;
  let repository: AppStateRepository | undefined;

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
      temporaryDirectory = undefined;
    }
  });

  async function createRepository(): Promise<{ databasePath: string; state: AppStateRepository }> {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "calendar-task-"));
    const databasePath = join(temporaryDirectory, "calendar.sqlite");
    const state = new AppStateRepository({ databasePath, encryptionSecret: "x".repeat(48) });
    repository = state;
    return { databasePath, state };
  }

  it("stores encrypted task titles, lists active tasks by due time, and retains terminal records", async () => {
    const { databasePath, state } = await createRepository();
    const later = state.createLocalTask(taskInput("task-later", "Private later task", "2026-08-19T22:00:00.000Z"));
    const earlier = state.createLocalTask(taskInput("task-earlier", "Private earlier task", "2026-08-18T22:00:00.000Z"));

    expect(state.listActiveLocalTasks({ ownerId }).map((task) => task.id)).toEqual(["task-earlier", "task-later"]);
    const completed = state.completeLocalTask({
      expectedRevision: earlier.revision,
      id: earlier.id,
      now: new Date("2026-08-17T12:01:00.000Z"),
      ownerId,
    });
    expect(completed).toMatchObject({ revision: 2, status: "completed", title: "Private earlier task" });
    expect(state.listActiveLocalTasks({ ownerId }).map((task) => task.id)).toEqual([later.id]);
    expect(
      state.completeLocalTask({
        expectedRevision: earlier.revision,
        id: earlier.id,
        now: new Date("2026-08-17T12:02:00.000Z"),
        ownerId,
      }),
    ).toBeUndefined();

    state.close();
    repository = undefined;
    const databaseContents = await readFile(databasePath, "utf8");
    expect(databaseContents).not.toContain("Private earlier task");
    expect(databaseContents).not.toContain("Private later task");
  });

  it("cancels a task batch atomically while retaining cancellation history", async () => {
    const { state } = await createRepository();
    const first = state.createLocalTask(taskInput("batch-first", "First private task", "2026-08-18T22:00:00.000Z"));
    const second = state.createLocalTask(taskInput("batch-second", "Second private task", "2026-08-19T22:00:00.000Z"));

    const cancelled = state.cancelLocalTasks({
      now: new Date("2026-08-17T12:05:00.000Z"),
      ownerId,
      tasks: [
        { expectedRevision: first.revision, id: first.id },
        { expectedRevision: second.revision, id: second.id },
      ],
    });

    expect(cancelled?.map((task) => task.id)).toEqual([first.id, second.id]);
    expect(state.getLocalTask({ id: first.id, ownerId })).toMatchObject({
      cancelledAt: new Date("2026-08-17T12:05:00.000Z"),
      revision: 2,
      status: "cancelled",
    });
    expect(state.getLocalTask({ id: second.id, ownerId })).toMatchObject({ status: "cancelled" });
    expect(state.listActiveLocalTasks({ ownerId })).toEqual([]);

    const staleFirst = state.createLocalTask(taskInput("stale-first", "Stale first", "2026-08-20T22:00:00.000Z"));
    const staleSecond = state.createLocalTask(taskInput("stale-second", "Stale second", "2026-08-21T22:00:00.000Z"));
    expect(
      state.cancelLocalTasks({
        now: new Date("2026-08-17T12:10:00.000Z"),
        ownerId,
        tasks: [
          { expectedRevision: staleFirst.revision, id: staleFirst.id },
          { expectedRevision: staleSecond.revision + 1, id: staleSecond.id },
        ],
      }),
    ).toBeUndefined();
    expect(state.getLocalTask({ id: staleFirst.id, ownerId })).toMatchObject({ status: "active" });
    expect(state.getLocalTask({ id: staleSecond.id, ownerId })).toMatchObject({ status: "active" });
  });

  it("selects active local tasks within a bounded due-date range", async () => {
    const { state } = await createRepository();
    state.createLocalTask(taskInput("range-earlier", "Earlier", "2026-08-17T18:00:00.000Z"));
    state.createLocalTask(taskInput("range-later", "Later", "2026-08-17T19:00:00.000Z"));
    state.createLocalTask(taskInput("range-outside", "Outside", "2026-08-17T21:00:00.000Z"));

    expect(
      state.listActiveLocalTasksInRange({
        dueAtEarliest: new Date("2026-08-17T17:00:00.000Z"),
        dueAtLatest: new Date("2026-08-17T20:00:00.000Z"),
        limit: 1,
        ownerId,
      }).map((task) => task.id),
    ).toEqual(["range-earlier"]);
  });

  it("selects due active tasks and records reminder slots idempotently", async () => {
    const { state } = await createRepository();
    state.createLocalTask(taskInput("due-task", "Run", "2026-08-17T18:00:00.000Z"));
    state.createLocalTask(taskInput("future-task", "Later", "2026-08-17T21:00:00.000Z"));

    expect(
      state.listDueLocalTasks({
        dueAtEarliest: new Date("2026-08-17T17:00:00.000Z"),
        dueAtLatest: new Date("2026-08-17T20:00:00.000Z"),
        ownerId,
      }).map((task) => task.id),
    ).toEqual(["due-task"]);

    const scheduledFor = new Date("2026-08-17T18:15:00.000Z");
    expect(state.recordLocalTaskReminderDelivery({ scheduledFor, taskId: "due-task" })).toBe(true);
    expect(state.hasLocalTaskReminderDelivery({ scheduledFor, taskId: "due-task" })).toBe(true);
    expect(state.recordLocalTaskReminderDelivery({ scheduledFor, taskId: "due-task" })).toBe(false);
  });

  it("preserves claim ownership, permits stale-lease takeover, and records a slot once", async () => {
    const { state } = await createRepository();
    state.createLocalTask(taskInput("claimed-task", "Run", "2026-08-17T18:00:00.000Z"));
    const now = new Date("2026-08-17T18:00:00.000Z");
    const scheduledFor = new Date("2026-08-17T18:00:00.000Z");

    expect(state.tryClaimLocalTaskReminderDelivery({
      claimToken: "claim-a",
      leaseExpiresAt: new Date("2026-08-17T18:05:00.000Z"),
      now,
      ownerId,
      scheduledFor,
      taskId: "claimed-task",
    })).toBe(true);
    expect(state.completeLocalTaskReminderDelivery({
      claimToken: "claim-b",
      scheduledFor,
      sentAt: now,
      taskId: "claimed-task",
    })).toBe(false);
    state.releaseLocalTaskReminderClaim({ claimToken: "claim-b", scheduledFor, taskId: "claimed-task" });
    expect(state.tryClaimLocalTaskReminderDelivery({
      claimToken: "claim-b",
      leaseExpiresAt: new Date("2026-08-17T18:09:00.000Z"),
      now: new Date("2026-08-17T18:04:00.000Z"),
      ownerId,
      scheduledFor,
      taskId: "claimed-task",
    })).toBe(false);

    const leaseExpiry = new Date("2026-08-17T18:05:00.000Z");
    expect(state.tryClaimLocalTaskReminderDelivery({
      claimToken: "claim-b",
      leaseExpiresAt: new Date("2026-08-17T18:10:00.000Z"),
      now: leaseExpiry,
      ownerId,
      scheduledFor,
      taskId: "claimed-task",
    })).toBe(true);
    expect(state.completeLocalTaskReminderDelivery({
      claimToken: "claim-a",
      scheduledFor,
      sentAt: leaseExpiry,
      taskId: "claimed-task",
    })).toBe(false);
    expect(state.completeLocalTaskReminderDelivery({
      claimToken: "claim-b",
      scheduledFor,
      sentAt: leaseExpiry,
      taskId: "claimed-task",
    })).toBe(true);
    expect(state.hasLocalTaskReminderDelivery({ scheduledFor, taskId: "claimed-task" })).toBe(true);
    expect(state.tryClaimLocalTaskReminderDelivery({
      claimToken: "claim-c",
      leaseExpiresAt: new Date("2026-08-17T18:15:00.000Z"),
      now: leaseExpiry,
      ownerId,
      scheduledFor,
      taskId: "claimed-task",
    })).toBe(false);
  });
});
