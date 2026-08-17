import type { Interactions } from "@google/genai";
import { describe, expect, it } from "vitest";

import type { CalendarCommandPlanningInput } from "../src/nlp/calendar-command-planner.js";
import {
  GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
  GeminiStructuredCommandPlanner,
  type GeminiInteractionClient,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
} from "../src/nlp/gemini-structured-planner.js";

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

const input: CalendarCommandPlanningInput = {
  now: new Date("2025-01-06T16:00:00.000Z"),
  text: "Could you shift my team meeting on Friday from 3pm to 4pm?",
  timeZone: "America/New_York",
};

function planner(client: FakeGeminiClient): GeminiStructuredCommandPlanner {
  return new GeminiStructuredCommandPlanner({
    apiKey: "test-api-key",
    client,
    model: "gemini-3.6-flash",
  });
}

describe("GeminiStructuredCommandPlanner", () => {
  it("uses a fixed structured request with no tools and only planning context", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({
        kind: "update",
        newStartTime: "16:00",
        selector: { date: "2025-01-10", summary: "team meeting", time: "15:00" },
      }),
    };

    const result = await planner(client).plan(input);

    expect(result).toEqual({
      kind: "update",
      newStartTime: "16:00",
      selector: { date: "2025-01-10", summary: "team meeting", time: "15:00" },
    });
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call).toBeDefined();
    expect(call?.request).toMatchObject({
      model: "gemini-3.6-flash",
      response_format: { mime_type: "application/json", type: "text" },
      store: false,
    });
    expect(call?.request).not.toHaveProperty("tools");
    expect(call?.options).toEqual({
      timeout_ms: GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
    });

    const prompt = String(call?.request.input);
    expect(prompt).toContain(input.text);
    expect(prompt).toContain("2025-01-06");
    expect(prompt).toContain(input.timeZone);
    expect(prompt).not.toMatch(/oauth|refresh token|calendarId|etag|eventId/iu);
  });

  it("rejects malformed, over-privileged, and semantically invalid model output", async () => {
    const invalidOutputs = [
      "not json",
      JSON.stringify({
        calendarId: "primary",
        kind: "create",
        date: "2025-01-10",
        durationMinutes: 30,
        startTime: "15:00",
        title: "Planning",
      }),
      JSON.stringify({
        kind: "create",
        date: "2025-02-30",
        durationMinutes: 30,
        startTime: "15:00",
        title: "Planning",
      }),
      JSON.stringify({
        kind: "set_reminder",
        minutesBefore: 10,
        selector: { date: "2025-01-10", summary: "https://untrusted.example" },
      }),
    ];

    for (const output_text of invalidOutputs) {
      const client = new FakeGeminiClient();
      client.response = { output_text };
      await expect(planner(client).plan(input)).resolves.toBeUndefined();
    }
  });

  it("fails closed for provider errors, missing output, and an oversized request", async () => {
    const providerError = new FakeGeminiClient();
    providerError.error = new Error("timeout");
    await expect(planner(providerError).plan(input)).resolves.toBeUndefined();

    const missingOutput = new FakeGeminiClient();
    await expect(planner(missingOutput).plan(input)).resolves.toBeUndefined();

    const tooLong = new FakeGeminiClient();
    await expect(planner(tooLong).plan({ ...input, text: "x".repeat(1_201) })).resolves.toBeUndefined();
    expect(tooLong.calls).toHaveLength(0);
  });
});
