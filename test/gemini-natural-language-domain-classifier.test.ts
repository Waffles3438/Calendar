import type { Interactions } from "@google/genai";
import { describe, expect, it } from "vitest";

import {
  GEMINI_REQUEST_TIMEOUT_MILLISECONDS,
  type GeminiInteractionClient,
  type GeminiInteractionRequestOptions,
  type GeminiInteractionResponse,
} from "../src/nlp/gemini-structured-planner.js";
import { GeminiNaturalLanguageDomainClassifier } from "../src/nlp/gemini-natural-language-domain-classifier.js";

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
  text: "I need to remember to call the plumber tomorrow.",
  timeZone: "America/Toronto",
};

function classifier(client: FakeGeminiClient): GeminiNaturalLanguageDomainClassifier {
  return new GeminiNaturalLanguageDomainClassifier({
    apiKey: "test-key",
    client,
    model: "gemini-test",
  });
}

describe("GeminiNaturalLanguageDomainClassifier", () => {
  it("uses a tool-free stored-disabled request with only classification context", async () => {
    const client = new FakeGeminiClient();
    client.response = { output_text: JSON.stringify({ domain: "task" }) };

    await expect(classifier(client).classify(input)).resolves.toEqual({ domain: "task" });

    const call = client.calls[0];
    expect(call?.request).toMatchObject({ model: "gemini-test", store: false });
    expect(call?.request).toHaveProperty("response_format.mime_type", "application/json");
    expect(call?.request).not.toHaveProperty("tools");
    expect(call?.options).toEqual({ timeout_ms: GEMINI_REQUEST_TIMEOUT_MILLISECONDS });
    expect(String(call?.request.input)).toContain(input.text);
    expect(String(call?.request.system_instruction)).toContain("Decision");
    expect(String(call?.request.system_instruction)).not.toMatch(/oauth|refresh token|calendarId|eventId|taskId/iu);
  });

  it("returns clarification decisions without inventing an action", async () => {
    const client = new FakeGeminiClient();
    client.response = {
      output_text: JSON.stringify({ kind: "clarify", reason: "ambiguous_domain" }),
    };

    await expect(classifier(client).classify({
      ...input,
      text: "Remind me about the dentist.",
    })).resolves.toEqual({ kind: "clarify", reason: "ambiguous_domain" });
  });

  it("rejects malformed, extra-field, and invalid responses", async () => {
    for (const output_text of [
      "not JSON",
      JSON.stringify({ domain: "task", confidence: 0.99 }),
      JSON.stringify({ kind: "clarify", reason: "unknown_reason" }),
    ]) {
      const client = new FakeGeminiClient();
      client.response = { output_text };
      await expect(classifier(client).classify(input)).resolves.toBeUndefined();
    }
  });

  it("fails closed for provider errors and oversized requests", async () => {
    const providerError = new FakeGeminiClient();
    providerError.error = new Error("provider unavailable");
    await expect(classifier(providerError).classify(input)).resolves.toBeUndefined();

    const oversized = new FakeGeminiClient();
    await expect(classifier(oversized).classify({ ...input, text: "x".repeat(1_201) })).resolves.toBeUndefined();
    expect(oversized.calls).toHaveLength(0);
  });
});
