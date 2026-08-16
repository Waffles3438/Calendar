import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStateRepository } from "../src/persistence/state-repository.js";

const fixedNow = new Date("2026-08-15T12:00:00.000Z");

describe("AppStateRepository", () => {
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

  async function createRepository(): Promise<{ databasePath: string; repository: AppStateRepository }> {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "calendar-bot-"));
    const databasePath = join(temporaryDirectory, "calendar.sqlite");
    repository = new AppStateRepository({
      databasePath,
      encryptionSecret: "x".repeat(48),
    });
    return { databasePath, repository };
  }

  it("encrypts OAuth credentials before storing them", async () => {
    const { databasePath, repository: state } = await createRepository();
    const credentials = {
      accessToken: "access-token-value",
      expiresAt: "2026-08-15T13:00:00.000Z",
      refreshToken: "refresh-token-value",
      scope: "calendar.events",
    };

    state.saveGoogleOAuth(credentials);
    expect(state.getGoogleOAuth()).toEqual(credentials);

    state.close();
    repository = undefined;
    const databaseContents = await readFile(databasePath, "utf8");
    expect(databaseContents).not.toContain(credentials.accessToken);
    expect(databaseContents).not.toContain(credentials.refreshToken);
  });

  it("binds pending actions to their owner and consumes them only once", async () => {
    const { repository: state } = await createRepository();
    const expiresAt = new Date("2026-08-15T12:05:00.000Z");

    state.createPendingAction({
      expiresAt,
      id: "pending-1",
      ownerId: "123456789012345678",
      payload: { operation: "delete", eventId: "event-1" },
    });

    expect(
      state.getPendingAction({
        id: "pending-1",
        now: fixedNow,
        ownerId: "123456789012345678",
      }),
    ).toMatchObject({ payload: { eventId: "event-1" } });

    expect(
      state.consumePendingAction({
        id: "pending-1",
        now: fixedNow,
        ownerId: "999999999999999999",
      }),
    ).toBeUndefined();

    expect(
      state.consumePendingAction({
        id: "pending-1",
        now: fixedNow,
        ownerId: "123456789012345678",
      }),
    ).toMatchObject({ payload: { eventId: "event-1" } });

    expect(
      state.consumePendingAction({
        id: "pending-1",
        now: fixedNow,
        ownerId: "123456789012345678",
      }),
    ).toBeUndefined();
  });

  it("expires pending actions and records reminder deliveries idempotently", async () => {
    const { repository: state } = await createRepository();

    state.createPendingAction({
      expiresAt: new Date("2026-08-15T11:59:59.000Z"),
      id: "expired-action",
      ownerId: "123456789012345678",
      payload: { operation: "update" },
    });

    expect(
      state.consumePendingAction({
        id: "expired-action",
        now: fixedNow,
        ownerId: "123456789012345678",
      }),
    ).toBeUndefined();

    expect(
      state.recordReminderDelivery({
        deliveryKey: "primary:event-1:2026-08-15T12:15:00.000Z:15",
        eventId: "event-1",
        scheduledFor: "2026-08-15T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(state.hasReminderDelivery("primary:event-1:2026-08-15T12:15:00.000Z:15")).toBe(true);
    expect(
      state.recordReminderDelivery({
        deliveryKey: "primary:event-1:2026-08-15T12:15:00.000Z:15",
        eventId: "event-1",
        scheduledFor: "2026-08-15T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("stores event-specific reminder overrides without storing event contents", async () => {
    const { repository: state } = await createRepository();

    state.setReminderOverride({
      calendarId: "primary",
      eventId: "event-1",
      minutesBefore: 30,
      occurrenceStart: "2026-08-15T12:15:00.000Z",
    });

    expect(
      state.getReminderOverride({
        calendarId: "primary",
        eventId: "event-1",
        occurrenceStart: "2026-08-15T12:15:00.000Z",
      }),
    ).toBe(30);
  });
});
