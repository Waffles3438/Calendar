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
