import type { ParsedCalendarCommand } from "./deterministic-command-parser.js";
import type { ParsedTaskCommand } from "../tasks/deterministic-task-parser.js";

export type NaturalLanguageDomain = "calendar" | "task";

export type NaturalLanguageExampleSplit = "evaluation" | "prompt";

export type NaturalLanguageCalendarCommand = Extract<
  ParsedCalendarCommand,
  { readonly kind: "create" | "list" | "update" | "delete" | "manage_attendees" | "set_reminder" }
>;

export type NaturalLanguageTaskCommand = Extract<
  ParsedTaskCommand,
  { readonly kind: "cancel" | "complete" | "create" | "list" }
>;

export type NaturalLanguageClarificationReason =
  | "ambiguous_domain"
  | "ambiguous_intent"
  | "invalid_value"
  | "missing_required_detail"
  | "unsupported_intent";

export type NaturalLanguageExpected =
  | {
    readonly command: NaturalLanguageCalendarCommand;
    readonly domain: "calendar";
  }
  | {
    readonly command: NaturalLanguageTaskCommand;
    readonly domain: "task";
  }
  | {
    readonly kind: "clarify";
    readonly reason: NaturalLanguageClarificationReason;
  };

export interface NaturalLanguageExample {
  readonly expected: NaturalLanguageExpected;
  readonly id: string;
  readonly now: string;
  readonly split: NaturalLanguageExampleSplit;
  readonly text: string;
  readonly timeZone: string;
}

export type NaturalLanguageDomainDecision =
  | { readonly domain: NaturalLanguageDomain }
  | { readonly kind: "clarify"; readonly reason: NaturalLanguageClarificationReason };

export function isNaturalLanguageDomain(value: unknown): value is NaturalLanguageDomain {
  return value === "calendar" || value === "task";
}

export function isNaturalLanguageClarificationReason(
  value: unknown,
): value is NaturalLanguageClarificationReason {
  return value === "ambiguous_domain" ||
    value === "ambiguous_intent" ||
    value === "invalid_value" ||
    value === "missing_required_detail" ||
    value === "unsupported_intent";
}

export function formatNaturalLanguageExample(example: NaturalLanguageExample): string {
  const output = "kind" in example.expected
    ? { kind: example.expected.kind, reason: example.expected.reason }
    : {
      command: example.expected.command,
      domain: example.expected.domain,
    };
  return [
    `User: ${example.text}`,
    `Output: ${JSON.stringify(output)}`,
  ].join("\n");
}

export function formatNaturalLanguageCommandExample(
  example: NaturalLanguageExample,
  domain: NaturalLanguageDomain,
): string | undefined {
  let output: unknown;
  if ("domain" in example.expected) {
    if (example.expected.domain !== domain) {
      return undefined;
    }
    output = example.expected.command;
  } else {
    const reason = example.expected.reason === "ambiguous_domain" || example.expected.reason === "ambiguous_intent"
      ? "unsupported_intent"
      : example.expected.reason;
    output = { kind: "clarify", reason };
  }

  return [
    `User: ${example.text}`,
    `Output: ${JSON.stringify(output)}`,
  ].join("\n");
}
