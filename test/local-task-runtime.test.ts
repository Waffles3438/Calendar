import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  getGoogleCalendarConfig,
  getLocalBotConfig,
  loadConfig,
} from "../src/config.js";
import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";
import { isLocalTaskPendingActionPayload } from "../src/tasks/local-task-assistant.js";
import { isTaskShapedInput } from "../src/tasks/deterministic-task-parser.js";

const ownerId = "123456789012345678";

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return { authorId: ownerId, content, id: "message-1", replies, reply: async (value) => { replies.push(value); } };
}

describe("local task runtime configuration", () => {
  it("allows local Discord tasks without Google and validates the task timezone", () => {
    const local = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_OWNER_ID: ownerId,
      ENCRYPTION_KEY: "x".repeat(48),
    });
    expect(getLocalBotConfig(local)).toMatchObject({ taskTimeZone: "America/Toronto" });
    expect(getGoogleCalendarConfig(local)).toBeUndefined();
    expect(() => loadConfig({ LOCAL_TASK_TIME_ZONE: "Not/AZone" })).toThrow(ConfigurationError);
  });

  it("fails closed when the local runtime is incomplete", () => {
    const config = loadConfig({ DISCORD_OWNER_ID: ownerId, ENCRYPTION_KEY: "x".repeat(48) });
    expect(() => getLocalBotConfig(config)).toThrow(/DISCORD_BOT_TOKEN/u);
  });
});

describe("OwnerCommandRouter task-only mode", () => {
  it("reports local readiness, rejects unavailable Google commands, and routes task input before calendar", async () => {
    const taskHandle = vi.fn(async () => undefined);
    const calendarHandle = vi.fn(async () => undefined);
    const router = new OwnerCommandRouter({
      calendarAssistant: { handle: calendarHandle },
      localTaskAssistant: {
        canHandlePendingAction: () => false,
        handle: taskHandle,
        handlePendingAction: async () => false,
        isTaskInput: () => true,
      },
      ownerId,
      stateRepository: {},
      taskTimeZone: "America/Toronto",
    });

    const status = message("/status");
    await router.handle(status);
    expect(status.replies.join(" ")).toMatch(/Local tasks are ready.*Google Calendar is not configured/u);

    const connect = message("/connect");
    await router.handle(connect);
    expect(connect.replies.join(" ")).toMatch(/not configured/u);

    await router.handle(message("remind me at 6pm tomorrow to run"));
    expect(taskHandle).toHaveBeenCalledTimes(1);
    expect(calendarHandle).not.toHaveBeenCalled();
  });

  it("keeps Calendar-oriented remember-to wording on the Calendar fallback path", async () => {
    const taskHandle = vi.fn(async () => undefined);
    const calendarHandle = vi.fn(async () => undefined);
    const router = new OwnerCommandRouter({
      calendarAssistant: { handle: calendarHandle },
      localTaskAssistant: {
        canHandlePendingAction: () => false,
        handle: taskHandle,
        handlePendingAction: async () => false,
        isTaskInput: isTaskShapedInput,
      },
      ownerId,
      stateRepository: {},
    });

    await router.handle(message("remember to schedule a meeting on my calendar tomorrow"));

    expect(taskHandle).not.toHaveBeenCalled();
    expect(calendarHandle).toHaveBeenCalledTimes(1);
  });

  it("dispatches a pending local-task transition without allowing the calendar handler to consume it", async () => {
    const taskPendingHandler = vi.fn(async () => true);
    const calendarPendingHandler = vi.fn(async () => true);
    const router = new OwnerCommandRouter({
      calendarAssistant: {
        canHandlePendingAction: () => true,
        handle: async () => undefined,
        handlePendingAction: calendarPendingHandler,
      },
      localTaskAssistant: {
        canHandlePendingAction: isLocalTaskPendingActionPayload,
        handle: async () => undefined,
        handlePendingAction: taskPendingHandler,
        isTaskInput: () => false,
      },
      ownerId,
      stateRepository: {
        getPendingAction: () => ({
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          id: "a111-1",
          ownerId,
          payload: {
            expectedRevision: 1,
            kind: "local_task_transition",
            operation: "complete",
            source: "gemini",
            taskId: "task-1",
          },
        }),
      },
    });

    await router.handle(message("confirm a111-1"));
    expect(taskPendingHandler).toHaveBeenCalledTimes(1);
    expect(calendarPendingHandler).not.toHaveBeenCalled();
  });
});
