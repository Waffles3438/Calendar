import { describe, expect, it } from "vitest";

import { evaluateMutationSafety } from "../src/policy/mutation-policy.js";

describe("evaluateMutationSafety", () => {
  it("allows a clear, non-guest one-off update to proceed", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "update",
        target: { hasExternalGuests: false, isRecurring: false },
      }),
    ).toEqual({ disposition: "proceed", reasons: [], warnings: [] });
  });

  it("asks the user to select an event when confidence is low", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.4 },
        operation: "update",
        target: { hasExternalGuests: false, isRecurring: false },
      }),
    ).toMatchObject({
      disposition: "select_target",
      reasons: ["ambiguous_match"],
    });
  });

  it("requires confirmation for an event with guests", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "update",
        target: { hasExternalGuests: true, isRecurring: false },
      }),
    ).toMatchObject({
      disposition: "require_confirmation",
      reasons: ["guest_impact"],
    });
  });

  it("requires confirmation for deletions even when the match is clear", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "delete",
        target: { hasExternalGuests: false, isRecurring: false },
      }),
    ).toMatchObject({
      disposition: "require_confirmation",
      reasons: ["delete_event"],
    });
  });

  it("requires an explicit recurrence scope before a recurring update", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "update",
        target: { hasExternalGuests: false, isRecurring: true },
      }),
    ).toMatchObject({
      disposition: "require_clarification",
      reasons: ["recurrence_scope_required"],
    });
  });

  it("keeps local reminder overrides safe for recurring events with guests", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "set_reminder",
        target: { hasExternalGuests: true, isRecurring: true },
      }),
    ).toEqual({ disposition: "proceed", reasons: [], warnings: [] });
  });

  it("requires confirmation for all-future recurring edits and preserves conflict warnings", () => {
    expect(
      evaluateMutationSafety({
        hasCalendarConflict: true,
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "update",
        recurrenceScope: "all_future",
        target: { hasExternalGuests: false, isRecurring: true },
      }),
    ).toEqual({
      disposition: "require_confirmation",
      reasons: ["recurring_series_change"],
      warnings: ["calendar_conflict"],
    });
  });
});


describe("model provenance", () => {
  it("requires confirmation for a clear model-proposed mutation", () => {
    expect(
      evaluateMutationSafety({
        match: { candidateCount: 1, confidence: 0.95 },
        operation: "update",
        proposedByModel: true,
        target: { hasExternalGuests: false, isRecurring: false },
      }),
    ).toEqual({
      disposition: "require_confirmation",
      reasons: ["model_proposed"],
      warnings: [],
    });
  });
});