import { describe, expect, it } from "vitest";

import type {
  NaturalLanguageAction,
  NaturalLanguageActionPlanningInput,
} from "../src/nlp/natural-language-action.js";
import type { NaturalLanguageActionPlanner } from "../src/nlp/natural-language-action-planner.js";
import {
  assertNaturalLanguageAccuracy,
  evaluateNaturalLanguageExamples,
} from "../src/nlp/natural-language-evaluator.js";
import {
  NATURAL_LANGUAGE_EVALUATION_EXAMPLES,
  naturalLanguageExampleToAction,
} from "../src/nlp/natural-language-examples.js";
import type { NaturalLanguageExample } from "../src/nlp/natural-language-types.js";

function exampleFor(text: string): NaturalLanguageExample | undefined {
  return NATURAL_LANGUAGE_EVALUATION_EXAMPLES.find((example) => example.text === text);
}

class CorpusActionPlanner implements NaturalLanguageActionPlanner {
  public readonly calls: NaturalLanguageActionPlanningInput[] = [];
  public wrongText: string | undefined;

  public async plan(input: NaturalLanguageActionPlanningInput): Promise<NaturalLanguageAction | undefined> {
    this.calls.push(input);
    const example = exampleFor(input.text);
    if (!example) {
      throw new Error(`Unexpected evaluation input: ${input.text}`);
    }
    if (input.text === this.wrongText) {
      return { action: "list_tasks" };
    }
    return naturalLanguageExampleToAction(example);
  }
}

describe("natural-language held-out evaluator", () => {
  it("evaluates the held-out corpus through one unified action planner", async () => {
    const actionPlanner = new CorpusActionPlanner();

    const summary = await evaluateNaturalLanguageExamples({ actionPlanner });

    expect(summary.total).toBe(NATURAL_LANGUAGE_EVALUATION_EXAMPLES.length);
    expect(summary.correct).toBe(summary.total);
    expect(summary.accuracy).toBe(1);
    expect(summary.failures).toEqual([]);
    expect(actionPlanner.calls).toHaveLength(summary.total);
    expect(summary.results.every((result) => result.stage === "action_planner")).toBe(true);
    expect(summary.buckets.map((bucket) => bucket.key)).toEqual(expect.arrayContaining([
      "calendar:create",
      "calendar:list",
      "calendar:update",
      "task:create",
      "task:list",
      "task:complete",
      "task:cancel",
      "clarify:ambiguous_domain",
    ]));

    expect(() => assertNaturalLanguageAccuracy(summary, 0.95)).not.toThrow();
  });

  it("reports unified action mismatches and rejects a result below the target", async () => {
    const actionPlanner = new CorpusActionPlanner();
    actionPlanner.wrongText = NATURAL_LANGUAGE_EVALUATION_EXAMPLES.find(
      (example) => "domain" in example.expected && example.expected.domain === "task",
    )?.text;

    const summary = await evaluateNaturalLanguageExamples({ actionPlanner });

    expect(summary.accuracy).toBeLessThan(1);
    expect(summary.failures.map((failure) => failure.failure)).toContain("action_mismatch");
    expect(summary.failures.every((failure) => failure.stage === "action_planner")).toBe(true);
    expect(() => assertNaturalLanguageAccuracy(summary, 1)).toThrow(/below the 100\.0% target/u);
  });

  it("prefers the unified planner when compatibility seams are also supplied", async () => {
    const actionPlanner = new CorpusActionPlanner();
    const classifier = { classify: async () => ({ domain: "task" as const }) };

    const summary = await evaluateNaturalLanguageExamples({ actionPlanner, classifier });

    expect(summary.accuracy).toBe(1);
    expect(actionPlanner.calls).toHaveLength(summary.total);
  });
});
