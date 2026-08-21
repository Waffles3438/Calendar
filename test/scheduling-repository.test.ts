import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";

const ownerId = "123456789012345678";
const secret = "x".repeat(48);
const now = new Date("2026-08-18T12:00:00.000Z");

describe("SchedulingRepository", () => {
  let directory: string | undefined;
  let repository: SchedulingRepository | undefined;

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    if (directory) {
      await rm(directory, { force: true, recursive: true });
      directory = undefined;
    }
  });

  async function createRepository(): Promise<{ databasePath: string; state: SchedulingRepository }> {
    directory = await mkdtemp(join(tmpdir(), "calendar-schedule-"));
    const databasePath = join(directory, "calendar.sqlite");
    const state = new SchedulingRepository({ databasePath, encryptionSecret: secret });
    repository = state;
    return { databasePath, state };
  }

  it("persists encrypted all-day tasks and timed reminders separately", async () => {
    const { databasePath, state } = await createRepository();
    const task = state.createScheduledItem({
      id: "task-1",
      kind: "task",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone: "America/Toronto",
      title: "Private all-day task",
    });
    const reminder = state.createScheduledItem({
      dueAt: new Date("2026-08-19T13:00:00.000Z"),
      id: "reminder-1",
      kind: "reminder",
      now,
      ownerId,
      scheduledDate: "2026-08-19",
      timeZone: "America/Toronto",
      title: "Private timed reminder",
    });

    expect(task.dueAt).toBeUndefined();
    expect(reminder.dueAt).toEqual(new Date("2026-08-19T13:00:00.000Z"));
    expect(state.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-19",
    }).map((item) => item.title)).toEqual(["Private all-day task", "Private timed reminder"]);

    state.close();
    repository = undefined;
    const contents = await readFile(databasePath, "utf8");
    expect(contents).not.toContain("Private all-day task");
    expect(contents).not.toContain("Private timed reminder");
  });

  it("materializes independent recurring occurrences and cancels a future series", async () => {
    const { state } = await createRepository();
    state.createScheduleSeries({
      id: "series-1",
      kind: "task",
      now,
      ownerId,
      recurrence: { frequency: "weekly", interval: 2, weekdays: [3] },
      startDate: "2026-08-19",
      timeZone: "America/Toronto",
      title: "Recycling",
    }, "2026-09-30");

    const initial = state.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-01",
      scheduledDateLatest: "2026-09-30",
    });
    expect(initial.map((item) => item.scheduledDate)).toEqual(["2026-08-19", "2026-09-02", "2026-09-16", "2026-09-30"]);

    const first = initial[0];
    expect(first).toBeDefined();
    const completed = state.completeScheduledItem({
      expectedRevision: first!.revision,
      id: first!.id,
      now: new Date("2026-08-19T12:00:00.000Z"),
      ownerId,
    });
    expect(completed?.status).toBe("completed");
    expect(state.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-01",
      scheduledDateLatest: "2026-09-30",
    }).map((item) => item.scheduledDate)).toEqual(["2026-09-02", "2026-09-16", "2026-09-30"]);

    const cancellationAnchor = initial.find((item) => item.scheduledDate === "2026-09-16");
    expect(cancellationAnchor).toBeDefined();
    expect(state.cancelScheduleSeries({
      anchor: { expectedRevision: cancellationAnchor!.revision, id: cancellationAnchor!.id },
      fromDate: "2026-09-16",
      now: new Date("2026-08-20T12:00:00.000Z"),
      ownerId,
      seriesId: "series-1",
    })).toBe(2);
    expect(state.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-01",
      scheduledDateLatest: "2026-09-30",
    }).map((item) => item.scheduledDate)).toEqual(["2026-09-02"]);
  });

  it("refuses a stale reviewed anchor without cancelling a recurring series", async () => {
    const { databasePath, state } = await createRepository();
    state.createScheduleSeries({
      id: "stale-anchor-series",
      kind: "task",
      now,
      ownerId,
      recurrence: { frequency: "weekly", interval: 1, weekdays: [3] },
      startDate: "2026-08-19",
      timeZone: "America/Toronto",
      title: "Weekly review",
    }, "2026-08-26");
    const occurrences = state.listActiveScheduledItems({
      ownerId,
      scheduledDateEarliest: "2026-08-19",
      scheduledDateLatest: "2026-08-26",
    });
    const anchor = occurrences.find((item) => item.scheduledDate === "2026-08-19");
    const laterOccurrence = occurrences.find((item) => item.scheduledDate === "2026-08-26");
    expect(anchor).toBeDefined();
    expect(laterOccurrence).toBeDefined();

    const concurrent = new SchedulingRepository({ databasePath, encryptionSecret: secret });
    try {
      expect(concurrent.completeScheduledItem({
        expectedRevision: anchor!.revision,
        id: anchor!.id,
        now: new Date("2026-08-18T13:00:00.000Z"),
        ownerId,
      })).toMatchObject({ status: "completed" });

      expect(state.cancelScheduleSeries({
        anchor: { expectedRevision: anchor!.revision, id: anchor!.id },
        fromDate: anchor!.scheduledDate,
        now: new Date("2026-08-18T14:00:00.000Z"),
        ownerId,
        seriesId: "stale-anchor-series",
      })).toBe(0);
      expect(state.getScheduleSeries({ id: "stale-anchor-series", ownerId })).toMatchObject({ status: "active" });
      expect(state.getScheduledItem({ id: anchor!.id, ownerId })).toMatchObject({ status: "completed" });
      expect(state.getScheduledItem({ id: laterOccurrence!.id, ownerId })).toMatchObject({ status: "active" });
    } finally {
      concurrent.close();
    }
  });

  it("rolls back a bulk cancellation when a later revision is stale", async () => {
    const { state } = await createRepository();
    const first = state.createScheduledItem({
      id: "first-item", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone: "America/Toronto", title: "First",
    });
    const second = state.createScheduledItem({
      id: "second-item", kind: "task", now, ownerId, scheduledDate: "2026-08-19", timeZone: "America/Toronto", title: "Second",
    });

    expect(state.cancelScheduledItems({
      now: new Date("2026-08-18T13:00:00.000Z"),
      ownerId,
      targets: [
        { expectedRevision: first.revision, id: first.id },
        { expectedRevision: second.revision + 1, id: second.id },
      ],
    })).toBeUndefined();
    expect(state.getScheduledItem({ id: first.id, ownerId })).toMatchObject({ revision: 1, status: "active" });
    expect(state.getScheduledItem({ id: second.id, ownerId })).toMatchObject({ revision: 1, status: "active" });
  });

  it("stores private interpretation entries with expiration and owner isolation", async () => {
    const { state } = await createRepository();
    state.putInterpretation({
      command: { date: "2026-08-19", kind: "agenda" },
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      input: "What do I need tomorrow?",
      now,
      ownerId,
      source: "manual",
    });
    expect(state.getInterpretation({
      input: "what do i need tomorrow?",
      now: new Date("2026-08-19T12:00:00.000Z"),
      ownerId,
    })).toEqual({
      command: { date: "2026-08-19", kind: "agenda" },
      source: "manual",
    });
    expect(state.getInterpretation({
      input: "what do i need tomorrow?",
      now: new Date("2026-08-19T12:00:00.000Z"),
      ownerId: "different-owner",
    })).toBeUndefined();
    expect(state.getInterpretation({
      input: "what do i need tomorrow?",
      now: new Date("2026-08-21T12:00:00.000Z"),
      ownerId,
    })).toBeUndefined();
  });
});
