import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SchedulingRepository } from "../src/scheduling/scheduling-repository.js";

const ownerId = "123456789012345678";
const secret = "x".repeat(48);
const now = new Date("2026-08-18T12:00:00.000Z");

describe("SchedulingRepository durability", () => {
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

  it("keeps manual correction context, cache entries, and daily claims durable and encrypted", async () => {
    directory = await mkdtemp(join(tmpdir(), "calendar-schedule-durable-"));
    const path = join(directory, "calendar.sqlite");
    repository = new SchedulingRepository({ databasePath: path, encryptionSecret: secret });
    repository.putPendingManualCorrection({
      expiresAt: new Date("2026-08-18T12:10:00.000Z"),
      input: "Please arrange my abstract private thing",
      now,
      ownerId,
    });
    repository.putInterpretation({
      command: { date: "2026-08-20", endDate: "2026-08-20", kind: "agenda", range: "day" },
      expiresAt: new Date("2026-11-16T12:00:00.000Z"),
      input: "abstract agenda phrase",
      now,
      ownerId,
      source: "manual",
    });
    repository.close();
    repository = undefined;

    expect(await readFile(path, "utf8")).not.toContain("Please arrange my abstract private thing");
    repository = new SchedulingRepository({ databasePath: path, encryptionSecret: secret });
    expect(repository.consumePendingManualCorrection({ now, ownerId })).toBe("Please arrange my abstract private thing");
    expect(repository.getInterpretation({ input: "abstract agenda phrase", now, ownerId })).toEqual({
      command: {
        date: "2026-08-20",
        endDate: "2026-08-20",
        kind: "agenda",
        range: "day",
      },
      source: "manual",
    });
    expect(repository.tryClaimDailyAgenda({
      claimToken: "claim-1",
      leaseExpiresAt: new Date("2026-08-18T12:10:00.000Z"),
      localDate: "2026-08-18",
      now,
      ownerId,
    })).toBe(true);
    expect(repository.completeDailyAgenda({ claimToken: "claim-1", localDate: "2026-08-18", ownerId, sentAt: now })).toBe(true);
    repository.close();
    repository = undefined;

    repository = new SchedulingRepository({ databasePath: path, encryptionSecret: secret });
    expect(repository.tryClaimDailyAgenda({
      claimToken: "claim-2",
      leaseExpiresAt: new Date("2026-08-18T12:20:00.000Z"),
      localDate: "2026-08-18",
      now: new Date("2026-08-18T12:01:00.000Z"),
      ownerId,
    })).toBe(false);
  });
});
