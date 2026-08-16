import { describe, expect, it } from "vitest";

import { ReminderScheduler } from "../src/reminders/reminder-scheduler.js";
import type { CalendarEvent, CalendarReference } from "../src/domain/calendar.js";
import type { CalendarGateway, ListCalendarEventsInput } from "../src/google/calendar-api.js";
import { createLogger } from "../src/logger.js";

const timeZone = "America/New_York";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    attendees: [],
    calendarId: "primary",
    end: { dateTime: "2025-01-10T16:00:00.000-05:00", kind: "timed", timeZone },
    etag: "etag-1",
    id: "event-1",
    start: { dateTime: "2025-01-10T15:00:00.000-05:00", kind: "timed", timeZone },
    status: "confirmed",
    summary: "Design review",
    ...overrides,
  };
}

class FakeCalendarGateway implements Pick<CalendarGateway, "listCalendars" | "listEvents"> {
  public readonly requests: ListCalendarEventsInput[] = [];

  public constructor(private readonly events: readonly CalendarEvent[] = [event()]) { }

  public async listCalendars(): Promise<readonly CalendarReference[]> {
    return [{ id: "primary", isPrimary: true, readOnly: false, summary: "Personal", timeZone }];
  }

  public async listEvents(input: ListCalendarEventsInput): Promise<readonly CalendarEvent[]> {
    this.requests.push(input);
    return this.events;
  }
}

class FakeReminderState {
  public readonly deliveries = new Set<string>();

  public constructor(private readonly override?: number) { }

  public getReminderOverride(): number | undefined {
    return this.override;
  }

  public hasReminderDelivery(deliveryKey: string): boolean {
    return this.deliveries.has(deliveryKey);
  }

  public recordReminderDelivery(input: { deliveryKey: string }): boolean {
    if (this.deliveries.has(input.deliveryKey)) {
      return false;
    }
    this.deliveries.add(input.deliveryKey);
    return true;
  }
}

describe("ReminderScheduler", () => {
  it("delivers the default 15-minute reminder exactly once in the single-process scheduler", async () => {
    const sent: string[] = [];
    const state = new FakeReminderState();
    const scheduler = new ReminderScheduler({
      calendarGateway: new FakeCalendarGateway(),
      logger: createLogger("silent"),
      now: () => new Date("2025-01-10T19:45:00.000Z"),
      sendOwnerMessage: async (content) => {
        sent.push(content);
      },
      stateRepository: state,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 1 });
    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 0 });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Design review/);
  });

  it("does not mark a reminder delivered when Discord delivery fails", async () => {
    const state = new FakeReminderState();
    const scheduler = new ReminderScheduler({
      calendarGateway: new FakeCalendarGateway(),
      logger: createLogger("silent"),
      now: () => new Date("2025-01-10T19:45:00.000Z"),
      sendOwnerMessage: async () => {
        throw new Error("Discord unavailable");
      },
      stateRepository: state,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 0, failed: 1 });
    expect(state.deliveries).toHaveLength(0);
  });

  it("queries far enough ahead to honor the maximum supported local override", async () => {
    const gateway = new FakeCalendarGateway([
      event({
        end: { dateTime: "2025-01-13T16:00:00.000-05:00", kind: "timed", timeZone },
        start: { dateTime: "2025-01-13T15:00:00.000-05:00", kind: "timed", timeZone },
      }),
    ]);
    const state = new FakeReminderState(4_320);
    const sent: string[] = [];
    const scheduler = new ReminderScheduler({
      calendarGateway: gateway,
      logger: createLogger("silent"),
      now: () => new Date("2025-01-10T20:00:00.000Z"),
      sendOwnerMessage: async (content) => {
        sent.push(content);
      },
      stateRepository: state,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ delivered: 1 });

    expect(sent).toHaveLength(1);
    expect(gateway.requests[0]?.timeMax).toMatch(/^2025-02-07/u);
  });
});
