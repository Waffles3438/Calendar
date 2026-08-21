import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ScheduledReminderScheduler, SCHEDULED_RECURRENCE_MATERIALIZATION_DAYS } from "../src/scheduling/scheduled-reminder-scheduler.js";

const ownerId = "123456789012345678";

describe("ScheduledReminderScheduler recurrence maintenance", () => {
  it("extends recurring occurrences before reading due reminders", async () => {
    const calls: Array<{ now: Date; ownerId: string; throughDate: string }> = [];
    const now = new Date("2026-08-18T12:00:00.000Z");
    const scheduler = new ScheduledReminderScheduler({
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
      now: () => now,
      ownerId,
      sendOwnerMessage: async () => undefined,
      stateRepository: {
        completeScheduledReminderDelivery: () => true,
        ensureOccurrencesThrough: (input) => { calls.push(input); },
        listDueScheduledReminders: () => [],
        releaseScheduledReminderClaim: () => undefined,
        tryClaimScheduledReminderDelivery: () => false,
      },
    });

    await expect(scheduler.runOnce()).resolves.toEqual({ delivered: 0, failed: 0, skipped: 0 });
    expect(calls).toEqual([{
      now,
      ownerId,
      throughDate: "2027-09-22",
    }]);
    expect(SCHEDULED_RECURRENCE_MATERIALIZATION_DAYS).toBe(400);
  });
});
