import {
  assertNaturalLanguageAccuracy,
  evaluateNaturalLanguageExamples,
  type NaturalLanguageEvaluationOptions,
  type NaturalLanguageEvaluationSummary,
} from "./natural-language-evaluator.js";

export interface NaturalLanguageDryRunOptions extends NaturalLanguageEvaluationOptions {
  readonly minimumAccuracy?: number;
}

export interface NaturalLanguageDryRunResult {
  readonly evaluation: NaturalLanguageEvaluationSummary;
  readonly writesAttempted: 0;
}

/**
 * Evaluates the unified model boundary without constructing an execution handler.
 * The input type exposes only the action-planner seam (plus a compatibility
 * evaluator path), so Calendar gateways, task repositories, pending actions,
 * and Discord writes cannot be reached by this harness.
 */
export async function runNaturalLanguageDryRun(
  options: NaturalLanguageDryRunOptions,
): Promise<NaturalLanguageDryRunResult> {
  const evaluation = await evaluateNaturalLanguageExamples(options);
  if (options.minimumAccuracy !== undefined) {
    assertNaturalLanguageAccuracy(evaluation, options.minimumAccuracy);
  }
  return { evaluation, writesAttempted: 0 };
}
