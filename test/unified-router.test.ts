import { describe, expect, it, vi } from "vitest";

import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";

const ownerId = "123456789012345678";

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: ownerId,
    content,
    id: `message-${Math.random()}`,
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

function taskHandler(overrides: Record<string, unknown> = {}) {
  return {
    canHandlePendingAction: () => false,
    handle: vi.fn(async () => undefined),
    handleNaturalLanguage: vi.fn(async () => undefined),
    handleNaturalLanguageAction: vi.fn(async () => undefined),
    handlePendingAction: vi.fn(async () => false),
    isTaskInput: vi.fn(() => false),
    ...overrides,
  };
}

describe("unified owner routing", () => {
  it("keeps control commands outside the Gemini planner", async () => {
    const plan = vi.fn(async () => ({ action: "list_tasks" as const }));
    const input = message("status");
    const router = new OwnerCommandRouter({
      naturalLanguagePlanner: { plan },
      ownerId,
      stateRepository: { getGoogleOAuth: () => undefined },
    });

    await router.handle(input);

    expect(plan).not.toHaveBeenCalled();
    expect(input.replies).toEqual(["Google Calendar is not configured."]);
  });

  it("dispatches one accepted action through a typed assistant entry point", async () => {
    const local = taskHandler();
    const plan = vi.fn(async () => ({
      action: "delete_task" as const,
      scope: "single" as const,
      selector: { title: "call plumber" },
    }));
    const router = new OwnerCommandRouter({
      localTaskAssistant: local,
      naturalLanguagePlanner: { plan },
      ownerId,
      stateRepository: {},
      taskTimeZone: "America/Toronto",
    });
    const input = message("delete the plumber task");

    await router.handle(input);

    expect(plan).toHaveBeenCalledTimes(1);
    expect(local.handleNaturalLanguageAction).toHaveBeenCalledWith(expect.objectContaining({ content: input.content }), {
      action: "delete_task",
      scope: "single",
      selector: { title: "call plumber" },
    });
  });

  it("stores clarification context and supplies it to a follow-up action", async () => {
    const context = {
      clarificationQuestion: "What time should I use?",
      createdAt: new Date("2026-08-17T20:00:00.000Z"),
      expiresAt: new Date("2026-08-17T20:10:00.000Z"),
      originalRequest: "Remember to call the plumber tomorrow.",
      reason: "missing_required_detail" as const,
      recentMessages: [] as readonly string[],
    };
    const stored: { value: typeof context | undefined } = { value: undefined };
    const save = vi.fn((input: Omit<typeof context, "createdAt" | "expiresAt"> & { expiresAt: Date; now: Date; ownerId: string }) => {
      stored.value = {
        clarificationQuestion: input.clarificationQuestion,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        originalRequest: input.originalRequest,
        reason: input.reason,
        recentMessages: input.recentMessages,
      };
    });
    const get = vi.fn(() => stored.value);
    const clear = vi.fn(() => {
      stored.value = undefined;
    });
    const plans = [
      { action: "ask_clarification" as const, reason: "missing_required_detail" as const },
      { action: "create_task_or_reminder" as const, date: "2026-08-18", scheduleKind: "reminder" as const, startTime: "18:00", title: "call the plumber" },
    ];
    const plan = vi.fn(async (input: { context?: unknown }) => {
      const next = plans.shift();
      if (input.context) {
        expect(input.context).toMatchObject({ originalRequest: "Remember to call the plumber tomorrow." });
      }
      return next;
    });
    const schedule = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => false),
      handleNaturalLanguageAction: vi.fn(async () => true),
      handlePendingAction: vi.fn(async () => false),
    };
    const router = new OwnerCommandRouter({
      naturalLanguagePlanner: { plan },
      ownerId,
      scheduleAssistant: schedule,
      stateRepository: { clearNaturalLanguageContext: clear, getNaturalLanguageContext: get, saveNaturalLanguageContext: save },
      taskTimeZone: "America/Toronto",
    });

    const first = message("Remember to call the plumber tomorrow.");
    await router.handle(first);
    expect(first.replies[0]).toMatch(/time/i);
    expect(save).toHaveBeenCalledTimes(1);

    const second = message("At 6.");
    await router.handle(second);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(schedule.handleNaturalLanguageAction).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith({ ownerId });
  });

  it("falls back deterministically when the unified provider is unavailable", async () => {
    const local = taskHandler({ isTaskInput: vi.fn(() => true) });
    const schedule = {
      canHandlePendingAction: () => false,
      handle: vi.fn(async () => false),
      handlePendingAction: vi.fn(async () => false),
    };
    const planner = { plan: vi.fn(async () => undefined) };
    const router = new OwnerCommandRouter({
      localTaskAssistant: local,
      naturalLanguagePlanner: planner,
      ownerId,
      scheduleAssistant: schedule,
      stateRepository: {},
    });

    await router.handle(message("tasks"));

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(local.handle).toHaveBeenCalledTimes(1);
    expect(local.handleNaturalLanguage).not.toHaveBeenCalled();
  });
});
