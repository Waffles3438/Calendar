import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { DailyAgendaScheduler } from "../src/scheduling/daily-agenda-scheduler.js";

const ownerId = "123456789012345678";

class FakeDailyState {
  public readonly deliveries = new Map<string, { claimToken: string; sent: boolean }>();
  public releaseCalls = 0;

  public tryClaimDailyAgenda(input: { claimToken: string; localDate: string }): boolean {
    const existing = this.deliveries.get(input.localDate);
    if (existing) {
      return false;
    }
    this.deliveries.set(input.localDate, { claimToken: input.claimToken, sent: false });
    return true;
  }

  public completeDailyAgenda(input: { claimToken: string; localDate: string }): boolean {
    const current = this.deliveries.get(input.localDate);
    if (!current || current.claimToken !== input.claimToken || current.sent) {
      return false;
    }
    this.deliveries.set(input.localDate, { ...current, sent: true });
    return true;
  }

  public releaseDailyAgendaClaim(input: { claimToken: string; localDate: string }): void {
    const current = this.deliveries.get(input.localDate);
    if (current?.claimToken === input.claimToken && !current.sent) {
      this.deliveries.delete(input.localDate);
      this.releaseCalls += 1;
    }
  }
}

function scheduler(input: {
  now: () => Date;
  render?: () => Promise<string>;
  send?: (content: string) => Promise<void>;
  state?: FakeDailyState;
}) {
  const state = input.state ?? new FakeDailyState();
  const sent: string[] = [];
  const instance = new DailyAgendaScheduler({
    agendaService: { render: input.render ?? (async () => "Agenda for <t:1787068800:D>:\nTasks:\n- None\nEvents:\n- None\nReminders:\n- None") },
    logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    now: input.now,
    ownerId,
    sendOwnerMessage: input.send ?? (async (content) => { sent.push(content); }),
    stateRepository: state,
    timeZone: "America/Toronto",
  });
  return { instance, sent, state };
}

describe("DailyAgendaScheduler", () => {
  it("skips before 7 AM and delivers an empty agenda at 7 AM", async () => {
    let current = new Date("2026-08-18T10:59:00.000Z"); // 6:59 AM Toronto
    const fixture = scheduler({ now: () => current });
    await expect(fixture.instance.runOnce()).resolves.toEqual({ delivered: false, failed: false, skipped: true });
    expect(fixture.sent).toEqual([]);

    current = new Date("2026-08-18T11:00:00.000Z");
    await expect(fixture.instance.runOnce()).resolves.toEqual({ delivered: true, failed: false, skipped: false });
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toContain("Tasks:\n- None");
  });

  it("uses durable date claims across a restart and handles a DST date in local time", async () => {
    const state = new FakeDailyState();
    const current = new Date("2026-03-08T11:30:00.000Z"); // 7:30 AM after Toronto spring-forward
    const first = scheduler({ now: () => current, state });
    const second = scheduler({ now: () => current, state });

    await expect(first.instance.runOnce()).resolves.toMatchObject({ delivered: true });
    await expect(second.instance.runOnce()).resolves.toEqual({ delivered: false, failed: false, skipped: true });
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    expect(state.deliveries.get("2026-03-08")?.sent).toBe(true);
  });

  it("releases a failed claim so a later run can retry", async () => {
    let fail = true;
    const state = new FakeDailyState();
    const fixture = scheduler({
      now: () => new Date("2026-08-18T11:00:00.000Z"),
      send: async () => {
        if (fail) {
          throw new Error("Discord unavailable");
        }
      },
      state,
    });
    await expect(fixture.instance.runOnce()).resolves.toMatchObject({ failed: true });
    expect(state.releaseCalls).toBe(1);
    fail = false;
    await expect(fixture.instance.runOnce()).resolves.toMatchObject({ delivered: true });
  });
});
