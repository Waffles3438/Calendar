import type { CalendarCommandPlanner } from "./calendar-command-planner.js";
import type { NaturalLanguageDomainClassifier } from "./natural-language-domain-classifier.js";
import {
  NATURAL_LANGUAGE_EVALUATION_EXAMPLES,
  naturalLanguageExampleToAction,
} from "./natural-language-examples.js";
import { validateNaturalLanguageAction, type NaturalLanguageAction } from "./natural-language-action.js";
import type { NaturalLanguageActionPlanner } from "./natural-language-action-planner.js";
import type {
  NaturalLanguageDomainDecision,
  NaturalLanguageExample,
  NaturalLanguageExpected,
} from "./natural-language-types.js";
import type { ParsedCalendarCommand } from "./deterministic-command-parser.js";
import type { TaskCommandPlanner } from "../tasks/task-command-planner.js";
import type { ParsedTaskCommand } from "../tasks/deterministic-task-parser.js";

export type NaturalLanguageEvaluationStage = "action_planner" | "calendar_planner" | "classifier" | "task_planner";

export type NaturalLanguageEvaluationFailure =
  | "action_mismatch"
  | "classifier_mismatch"
  | "planner_mismatch"
  | "planner_unavailable"
  | "provider_error";

export type NaturalLanguageEvaluationActual =
  | NaturalLanguageAction
  | NaturalLanguageDomainDecision
  | ParsedCalendarCommand
  | ParsedTaskCommand;

export interface NaturalLanguageEvaluationResult {
  readonly actual: NaturalLanguageEvaluationActual | null;
  readonly correct: boolean;
  readonly expected: NaturalLanguageExpected;
  readonly failure?: NaturalLanguageEvaluationFailure;
  readonly id: string;
  readonly stage: NaturalLanguageEvaluationStage;
}

export interface NaturalLanguageEvaluationBucket {
  readonly accuracy: number;
  readonly correct: number;
  readonly key: string;
  readonly total: number;
}

export interface NaturalLanguageEvaluationSummary {
  readonly accuracy: number;
  readonly buckets: readonly NaturalLanguageEvaluationBucket[];
  readonly correct: number;
  readonly failures: readonly NaturalLanguageEvaluationResult[];
  readonly results: readonly NaturalLanguageEvaluationResult[];
  readonly total: number;
}

export interface NaturalLanguageEvaluationOptions {
  /** The canonical single hosted interpretation seam. */
  readonly actionPlanner?: NaturalLanguageActionPlanner;
  /** Compatibility-only seams for evaluating the retired split pipeline. */
  readonly calendarPlanner?: CalendarCommandPlanner;
  readonly classifier?: NaturalLanguageDomainClassifier;
  readonly examples?: readonly NaturalLanguageExample[];
  readonly taskPlanner?: TaskCommandPlanner;
}

/**
 * Runs the held-out corpus through the unified action planner when supplied.
 * The legacy classifier/planner seams remain available only for compatibility
 * with older evaluation callers; they are never used when actionPlanner exists.
 * This harness never constructs an assistant or receives a repository/gateway.
 */
export async function evaluateNaturalLanguageExamples(
  options: NaturalLanguageEvaluationOptions,
): Promise<NaturalLanguageEvaluationSummary> {
  const examples = options.examples ?? NATURAL_LANGUAGE_EVALUATION_EXAMPLES;
  if (!options.actionPlanner && !options.classifier) {
    throw new Error("An action planner or compatibility classifier is required for evaluation");
  }

  const results: NaturalLanguageEvaluationResult[] = [];
  for (const example of examples) {
    results.push(await evaluateExample(example, options));
  }

  const correct = results.filter((result) => result.correct).length;
  return {
    accuracy: examples.length === 0 ? 0 : correct / examples.length,
    buckets: createBuckets(results),
    correct,
    failures: results.filter((result) => !result.correct),
    results,
    total: examples.length,
  };
}

/** Fails a CI/evaluation run when the held-out accuracy target is not met. */
export function assertNaturalLanguageAccuracy(
  summary: NaturalLanguageEvaluationSummary,
  minimumAccuracy = 0.95,
): void {
  if (!Number.isFinite(minimumAccuracy) || minimumAccuracy < 0 || minimumAccuracy > 1) {
    throw new Error("The minimum natural-language accuracy must be between 0 and 1");
  }

  if (summary.accuracy >= minimumAccuracy) {
    return;
  }

  const failedIds = summary.failures.map((failure) => failure.id).join(", ");
  throw new Error(
    `Natural-language accuracy ${(summary.accuracy * 100).toFixed(1)}% is below the ${(minimumAccuracy * 100).toFixed(1)}% target. Failed examples: ${failedIds || "none"}`,
  );
}

async function evaluateExample(
  example: NaturalLanguageExample,
  options: NaturalLanguageEvaluationOptions,
): Promise<NaturalLanguageEvaluationResult> {
  if (options.actionPlanner) {
    return evaluateWithActionPlanner(example, options.actionPlanner);
  }
  return evaluateWithLegacyPipeline(example, options);
}

async function evaluateWithActionPlanner(
  example: NaturalLanguageExample,
  actionPlanner: NaturalLanguageActionPlanner,
): Promise<NaturalLanguageEvaluationResult> {
  const input = planningInput(example);
  let actual: NaturalLanguageAction | undefined;
  try {
    actual = await actionPlanner.plan(input);
  } catch {
    return result(example, null, false, "action_planner", "provider_error");
  }

  const expected = naturalLanguageExampleToAction(example);
  const validExpected = expected !== undefined && validateNaturalLanguageAction(expected, input);
  const validActual = actual !== undefined && validateNaturalLanguageAction(actual, input);
  const correct = Boolean(validExpected && validActual && structurallyEqual(validActual, validExpected));
  return result(
    example,
    actual ?? null,
    correct,
    "action_planner",
    correct ? undefined : "action_mismatch",
  );
}

async function evaluateWithLegacyPipeline(
  example: NaturalLanguageExample,
  options: NaturalLanguageEvaluationOptions,
): Promise<NaturalLanguageEvaluationResult> {
  const classifier = options.classifier;
  if (!classifier) {
    throw new Error("A compatibility classifier is required when actionPlanner is not supplied");
  }

  const input = planningInput(example);
  let classification: NaturalLanguageDomainDecision | undefined;
  try {
    classification = await classifier.classify(input);
  } catch {
    return result(example, null, false, "classifier", "provider_error");
  }

  if (!("domain" in example.expected)) {
    const correct = classification !== undefined &&
      "kind" in classification &&
      classification.kind === "clarify" &&
      classification.reason === example.expected.reason;
    return result(
      example,
      classification ?? null,
      correct,
      "classifier",
      correct ? undefined : "classifier_mismatch",
    );
  }

  if (!classification || "kind" in classification || classification.domain !== example.expected.domain) {
    return result(
      example,
      classification ?? null,
      false,
      "classifier",
      "classifier_mismatch",
    );
  }

  if (classification.domain === "calendar") {
    if (!options.calendarPlanner) {
      return result(example, classification, false, "calendar_planner", "planner_unavailable");
    }
    try {
      const actual = await options.calendarPlanner.plan(input);
      const correct = structurallyEqual(actual, example.expected.command);
      return result(
        example,
        actual ?? null,
        correct,
        "calendar_planner",
        correct ? undefined : "planner_mismatch",
      );
    } catch {
      return result(example, null, false, "calendar_planner", "provider_error");
    }
  }

  if (!options.taskPlanner) {
    return result(example, classification, false, "task_planner", "planner_unavailable");
  }
  try {
    const actual = await options.taskPlanner.plan(input);
    const correct = structurallyEqual(actual, example.expected.command);
    return result(
      example,
      actual ?? null,
      correct,
      "task_planner",
      correct ? undefined : "planner_mismatch",
    );
  } catch {
    return result(example, null, false, "task_planner", "provider_error");
  }
}

function planningInput(example: NaturalLanguageExample): {
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
} {
  return {
    now: new Date(example.now),
    text: example.text,
    timeZone: example.timeZone,
  };
}

function result(
  example: NaturalLanguageExample,
  actual: NaturalLanguageEvaluationActual | null,
  correct: boolean,
  stage: NaturalLanguageEvaluationStage,
  failure: NaturalLanguageEvaluationFailure | undefined,
): NaturalLanguageEvaluationResult {
  return {
    actual,
    correct,
    expected: example.expected,
    ...(failure ? { failure } : {}),
    id: example.id,
    stage,
  };
}

function createBuckets(
  results: readonly NaturalLanguageEvaluationResult[],
): readonly NaturalLanguageEvaluationBucket[] {
  const grouped = new Map<string, { correct: number; total: number }>();
  for (const result of results) {
    const key = evaluationKey(result.expected);
    const bucket = grouped.get(key) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (result.correct) {
      bucket.correct += 1;
    }
    grouped.set(key, bucket);
  }

  return [...grouped.entries()].map(([key, bucket]) => ({
    accuracy: bucket.total === 0 ? 0 : bucket.correct / bucket.total,
    correct: bucket.correct,
    key,
    total: bucket.total,
  }));
}

function evaluationKey(expected: NaturalLanguageExpected): string {
  return "domain" in expected
    ? `${expected.domain}:${expected.command.kind}`
    : `clarify:${expected.reason}`;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
