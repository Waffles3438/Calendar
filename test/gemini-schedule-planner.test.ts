import type { Interactions } from "@google/genai";
import { describe, expect, it } from "vitest";

import type { ScheduleCommandPlanningInput } from "../src/scheduling/schedule-command-planner.js";
import { GeminiSchedulePlanner } from "../src/scheduling/gemini-schedule-planner.js";
import {
  GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
  type GeminiInteractionClient,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
} from "../src/nlp/gemini-structured-planner.js";

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

const input: ScheduleCommandPlanningInput = {
  now: new Date("2026-08-18T12:00:00.000Z"),
  text: "Could you arrange a focus block next Friday from 09:00 to 10:00?",
  timeZone: "America/Toronto",
};

function planner(client: FakeGeminiClient): GeminiSchedulePlanner {
  return new GeminiSchedulePlanner({ apiKey: "test-api-key", client, model: "gemini-3.6-flash" });
}

describe("GeminiSchedulePlanner", () => {
  it("uses a fixed structured tool-free request and normalizes a valid plan", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({
        date: "2026-08-21",
        endTime: "10:00",
        kind: "event",
        startTime: "09:00",
        title: "Focus block",
      }),
    };

    await expect(planner(client).plan(input)).resolves.toEqual({
      date: "2026-08-21",
      endTime: "10:00",
      kind: "event",
      startTime: "09:00",
      title: "Focus block",
    });
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call?.request).toMatchObject({
      model: "gemini-3.6-flash",
      response_format: { mime_type: "application/json", type: "text" },
      store: false,
    });
    expect(call?.request).not.toHaveProperty("tools");
    expect(call?.options).toEqual({ timeout_ms: GEMINI_REQUEST_TIMEOUT_MILLISECONDS });
    expect(String(call?.request.input)).toContain(input.text);
    expect(String(call?.request.input)).not.toMatch(/oauth|calendarId|etag|eventId|credential/iu);
  });

  it("normalizes model cleanup as a reviewed all-target cleanup", async () => {
    const client = new FakeGeminiClient();
    client.response = { output_text: JSON.stringify({ kind: "cleanup", title: "Yoga" }) };

    await expect(planner(client).plan(input)).resolves.toEqual({
      kind: "cleanup",
      mode: "reviewed",
      targetKinds: ["task", "reminder", "event"],
      terms: ["yoga"],
      title: "Yoga",
    });
  });

  it("fails closed for malformed, over-privileged, invalid-time, and incomplete output", async () => {
    const invalid = [
      "not json",
      JSON.stringify({ date: "2026-08-21", endTime: "10:00", kind: "event", startTime: "09:00", title: "Focus", tool: "write" }),
      JSON.stringify({ date: "2026-08-21", endTime: "09:00", kind: "event", startTime: "10:00", title: "Focus" }),
      JSON.stringify({ date: "2026-03-08", kind: "local", scheduleKind: "reminder", startTime: "02:30", title: "DST gap" }),
      JSON.stringify({ date: "2026-08-21", kind: "local", scheduleKind: "reminder", title: "Missing start" }),
    ];
    for (const output_text of invalid) {
      const client = new FakeGeminiClient();
      client.response = { output_text };
      await expect(planner(client).plan(input)).resolves.toBeUndefined();
    }
  });
});
