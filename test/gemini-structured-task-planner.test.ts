import type { Interactions } from "@google/genai";
import { describe, expect, it } from "vitest";

import {
  GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
  type GeminiInteractionClient,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
} from "../src/nlp/gemini-structured-planner.js";
import type { TaskCommandPlanningInput } from "../src/tasks/task-command-planner.js";
import { GeminiStructuredTaskPlanner } from "../src/tasks/gemini-structured-task-planner.js";

class FakeGeminiClient implements GeminiInteractionClient {
  public readonly calls: Array<{
    options: GeminiInteractionRequestOptions;
    request: Interactions.CreateModelInteractionParamsNonStreaming;
  }> = [];
  public response: GeminiInteractionResponse = {};

  public async create(
    request: Interactions.CreateModelInteractionParamsNonStreaming,
    options: GeminiInteractionRequestOptions,
  ): Promise<GeminiInteractionResponse> {
    this.calls.push({ options, request });
    return this.response;
  }
}

const input: TaskCommandPlanningInput = {
  now: new Date("2026-08-17T20:00:00.000Z"),
  text: "Please make sure I remember to run tomorrow at six.",
  timeZone: "America/Toronto",
};

function planner(client: FakeGeminiClient): GeminiStructuredTaskPlanner {
  return new GeminiStructuredTaskPlanner({
    apiKey: "test-key",
    client,
    model: "gemini-test",
  });
}

describe("GeminiStructuredTaskPlanner", () => {
  it("uses a tool-free stored-disabled request with only task planning context", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({
        date: "2026-08-18",
        kind: "create",
        time: "18:00",
        title: "run",
      }),
    };

    await expect(planner(client).plan(input)).resolves.toEqual({
      date: "2026-08-18",
      kind: "create",
      time: "18:00",
      title: "run",
    });

    const call = client.calls[0];
    expect(call?.request).toMatchObject({ model: "gemini-test", store: false });
    expect(call?.options).toEqual({
      timeout_ms: GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
    });
    expect(call?.request).not.toHaveProperty("tools");
    expect(String(call?.request.input)).toContain(input.text);
    expect(String(call?.request.input)).not.toMatch(/calendar|oauth|task id|database|discord/iu);
  });

  it("accepts schema-conforming one-off complete and cancel plans", async () => {
    const expectedPlans = [
      { kind: "complete", selector: { title: "run" } },
      { kind: "cancel", selector: { date: "2026-08-18", title: "pay hydro" } },
    ] as const;

    for (const expected of expectedPlans) {
      const client = new FakeGeminiClient();
      client.response = { output_text: JSON.stringify(expected) };
      await expect(planner(client).plan(input)).resolves.toEqual(expected);
    }
  });

  it("rejects unsafe IDs, recurrence, impossible times, and malformed output", async () => {
    const invalidOutputs = [
      "not JSON",
      JSON.stringify({ date: "2026-08-18", id: "task-1", kind: "create", time: "18:00", title: "run" }),
      JSON.stringify({ date: "2026-11-01", kind: "create", time: "01:30", title: "run" }),
      JSON.stringify({ kind: "recurrence", title: "run" }),
    ];

    for (const output_text of invalidOutputs) {
      const client = new FakeGeminiClient();
      client.response = { output_text };
      await expect(planner(client).plan(input)).resolves.toBeUndefined();
    }
  });
});


describe("GeminiStructuredTaskPlanner clarification output", () => {
  it("maps a constrained clarify response to a local clarification", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({ kind: "clarify", reason: "unsupported_intent" }),
    };

    await expect(planner(client).plan(input)).resolves.toEqual({
      kind: "clarify",
      message: "I could not determine a supported one-time task command.",
      reason: "unsupported_intent",
    });
    expect(String(client.calls[0]?.request.system_instruction)).toContain("Mark pay hydro as done");
  });
});
