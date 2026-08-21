import type { Interactions } from "@google/genai";
import { describe, expect, it } from "vitest";

import {
  GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
  MAX_GEMINI_REQUEST_CHARACTERS,
  type GeminiInteractionClient,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
} from "../src/nlp/gemini-structured-planner.js";
import { GeminiActionPlanner } from "../src/nlp/gemini-action-planner.js";

class FakeGeminiClient implements GeminiInteractionClient {
  public readonly calls: Array<{
    options: GeminiInteractionRequestOptions;
    request: Interactions.CreateModelInteractionParamsNonStreaming;
  }> = [];
  public error: Error | undefined;
  public response: GeminiInteractionResponse = {};

  public async create(
    request: Interactions.CreateModelInteractionParamsNonStreaming,
    options: GeminiInteractionRequestOptions,
  ): Promise<GeminiInteractionResponse> {
    this.calls.push({ options, request });
    if (this.error) {
      throw this.error;
    }
    return this.response;
  }
}

const input = {
  now: new Date("2026-08-17T20:00:00.000Z"),
  text: "Put lunch with Sam on my calendar Friday at noon for one hour.",
  timeZone: "America/Toronto",
};

function planner(client: FakeGeminiClient): GeminiActionPlanner {
  return new GeminiActionPlanner({
    apiKey: "test-api-key",
    client,
    model: "gemini-test-model",
  });
}

describe("GeminiActionPlanner", () => {
  it("returns one validated application action without exposing execution tools", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({
        action: "create_calendar_event",
        date: "2026-08-21",
        endTime: "13:00",
        startTime: "12:00",
        title: "lunch with Sam",
      }),
    };

    await expect(planner(client).plan(input)).resolves.toEqual({
      action: "create_calendar_event",
      date: "2026-08-21",
      endTime: "13:00",
      startTime: "12:00",
      title: "lunch with Sam",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.request).toMatchObject({
      model: "gemini-test-model",
      response_format: { mime_type: "application/json", type: "text" },
      store: false,
    });
    expect(client.calls[0]?.request).not.toHaveProperty("tools");
    expect(client.calls[0]?.options).toEqual({ timeout_ms: GEMINI_REQUEST_TIMEOUT_MILLISECONDS });
    expect(String(client.calls[0]?.request.system_instruction)).toContain("delete_task");
    expect(String(client.calls[0]?.request.input)).toContain(input.text);
    expect(String(client.calls[0]?.request.input)).toContain(input.timeZone);
  });

  it("carries short-lived clarification context as inert prompt data", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({
        action: "create_task_or_reminder",
        date: "2026-08-18",
        scheduleKind: "reminder",
        startTime: "18:00",
        title: "call the plumber",
      }),
    };

    await expect(planner(client).plan({
      ...input,
      context: {
        clarificationQuestion: "What time should I use?",
        originalRequest: "I want to remember to call the plumber tomorrow.",
        reason: "missing_required_detail",
        recentMessages: ["At 6."],
      },
      text: "At 6.",
    })).resolves.toMatchObject({ action: "create_task_or_reminder", scheduleKind: "reminder" });
    const prompt = String(client.calls[0]?.request.input);
    expect(prompt).toContain("<previous-context>");
    expect(prompt).toContain("call the plumber");
    expect(prompt).toContain("<owner-message>");
  });

  it("returns clarification and rejects malformed or over-privileged actions", async () => {
    const clarification = new FakeGeminiClient();
    clarification.response = { output_text: JSON.stringify({ action: "ask_clarification", reason: "missing_required_detail" }) };
    await expect(planner(clarification).plan(input)).resolves.toEqual({
      action: "ask_clarification",
      reason: "missing_required_detail",
    });

    for (const output_text of [
      "not json",
      JSON.stringify({ action: "list_tasks", id: "task-1" }),
      JSON.stringify({ action: "delete_task", scope: "single", selector: { title: "https://example.test" } }),
      JSON.stringify({ action: "list_calendar", date: "2026-02-30" }),
      JSON.stringify({ action: "create_task_or_reminder", date: "2026-08-18", scheduleKind: "reminder", title: "call" }),
    ]) {
      const client = new FakeGeminiClient();
      client.response = { output_text };
      await expect(planner(client).plan(input)).resolves.toBeUndefined();
    }
  });

  it("fails closed for provider errors and oversized requests", async () => {
    const providerError = new FakeGeminiClient();
    providerError.error = new Error("timeout");
    await expect(planner(providerError).plan(input)).resolves.toBeUndefined();

    const oversized = new FakeGeminiClient();
    await expect(planner(oversized).plan({ ...input, text: "x".repeat(MAX_GEMINI_REQUEST_CHARACTERS + 1) })).resolves.toBeUndefined();
    expect(oversized.calls).toHaveLength(0);
  });
});
