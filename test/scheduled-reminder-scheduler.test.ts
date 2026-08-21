import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ScheduledReminderScheduler } from "../src/scheduling/scheduled-reminder-scheduler.js";
import type { ScheduledItem } from "../src/scheduling/schedule-domain.js";

const ownerId = "123456789012345678";

function reminder(): ScheduledItem {
  return {
    createdAt: new Date("2026-08-18T12:00:00.000Z"),
    dueAt: new Date("2026-08-18T13:00:00.000Z"),
    id: "reminder-1",
    kind: "reminder",
    ownerId,
    revision: 1,
    scheduledDate: "2026-08-18",
    status: "active",
    timeZone: "America/Toronto",
    title: "Buy cheese",
    updatedAt: new Date("2026-08-18T12:00:00.000Z"),
  };
}

describe("ScheduledReminderScheduler", () => {
  it("delivers the early, due, and follow-up slots once each", async () => {
    const delivered = new Set<string>();
    let current = new Date("2026-08-18T12:30:00.000Z");
    const messages: string[] = [];
    const repository = {
      completeScheduledReminderDelivery: ({ itemId, scheduledFor }: { itemId: string; scheduledFor: Date }) => {
        delivered.add(`${itemId}:${scheduledFor.toISOString()}`);
        return true;
      },
      listDueScheduledReminders: () => [reminder()],
      releaseScheduledReminderClaim: () => undefined,
      tryClaimScheduledReminderDelivery: ({ itemId, scheduledFor }: { itemId: string; scheduledFor: Date }) =>
        !delivered.has(`${itemId}:${scheduledFor.toISOString()}`),
    };
    const scheduler = new ScheduledReminderScheduler({
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
      now: () => current,
      ownerId,
      sendOwnerMessage: async (content) => { messages.push(content); },
      stateRepository: repository,
    });

    await scheduler.runOnce();
    current = new Date("2026-08-18T13:00:00.000Z");
    await scheduler.runOnce();
    current = new Date("2026-08-18T13:15:00.000Z");
    await scheduler.runOnce();

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatch(/Upcoming reminder/i);
    expect(messages[1]).toMatch(/^Reminder:/i);
    expect(messages[2]).toMatch(/Late reminder/i);
  });
});
