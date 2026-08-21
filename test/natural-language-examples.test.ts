import { describe, expect, it } from "vitest";

import {
  NATURAL_LANGUAGE_EVALUATION_EXAMPLES,
  NATURAL_LANGUAGE_EXAMPLES,
  NATURAL_LANGUAGE_PROMPT_EXAMPLES,
  naturalLanguageExampleToAction,
} from "../src/nlp/natural-language-examples.js";
import { validateNaturalLanguageAction } from "../src/nlp/natural-language-action.js";

function expectedKind(example: (typeof NATURAL_LANGUAGE_EXAMPLES)[number]): string {
  return "kind" in example.expected ? example.expected.kind : example.expected.command.kind;
}

describe("natural-language example corpus", () => {
  it("contains a starter prompt and held-out corpus with unique IDs", () => {
    expect(NATURAL_LANGUAGE_PROMPT_EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(NATURAL_LANGUAGE_EVALUATION_EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(NATURAL_LANGUAGE_EXAMPLES.map((example) => example.id)).size)
      .toBe(NATURAL_LANGUAGE_EXAMPLES.length);
    expect(NATURAL_LANGUAGE_EXAMPLES.every((example) => example.text.trim().length > 0)).toBe(true);
  });

  it("keeps prompt and evaluation examples in separate splits", () => {
    expect(NATURAL_LANGUAGE_PROMPT_EXAMPLES.every((example) => example.split === "prompt")).toBe(true);
    expect(NATURAL_LANGUAGE_EVALUATION_EXAMPLES.every((example) => example.split === "evaluation")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "create")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "list")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "update")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "complete")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "cancel")).toBe(true);
    expect(NATURAL_LANGUAGE_EXAMPLES.some((example) => expectedKind(example) === "clarify")).toBe(true);
  });

  it("does not include credentials or execution identifiers", () => {
    const serialized = JSON.stringify(NATURAL_LANGUAGE_EXAMPLES);
    expect(serialized).not.toMatch(/(?:api[_-]?key|oauth|refresh\s+token|etag|event[_-]?id|task[_-]?id)/iu);
    expect(serialized).not.toMatch(/https?:\/\//iu);
  });
  it("converts every corpus example to a semantically valid unified action", () => {
    for (const example of NATURAL_LANGUAGE_EXAMPLES) {
      const action = naturalLanguageExampleToAction(example);
      expect(action).toBeDefined();
      expect(validateNaturalLanguageAction(action, {
        now: new Date(example.now),
        timeZone: example.timeZone,
      })).toEqual(action);
    }
  });
});