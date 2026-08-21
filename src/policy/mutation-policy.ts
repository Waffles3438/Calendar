import type { CalendarOperation, RecurrenceScope } from "../domain/calendar.js";

export type SafetyDisposition =
  | "proceed"
  | "require_clarification"
  | "require_confirmation"
  | "select_target";

export type SafetyReason =
  | "ambiguous_match"
  | "attendee_change"
  | "delete_event"
  | "guest_impact"
  | "model_proposed"
  | "recurrence_scope_required"
  | "recurring_series_change"
  | "target_not_found";

export type SafetyWarning = "calendar_conflict";

export interface EventSafetyTarget {
  readonly hasExternalGuests: boolean;
  readonly isRecurring: boolean;
}

export interface MutationSafetyInput {
  readonly hasCalendarConflict?: boolean;
  readonly introducesAttendees?: boolean;
  readonly match?: {
    readonly candidateCount: number;
    readonly confidence: number;
  };
  readonly operation: CalendarOperation;
  readonly proposedByModel?: boolean;
  readonly allowModelAutoExecution?: boolean;
  readonly recurrenceScope?: RecurrenceScope;
  readonly target?: EventSafetyTarget;
}

export interface MutationSafetyDecision {
  readonly disposition: SafetyDisposition;
  readonly reasons: readonly SafetyReason[];
  readonly warnings: readonly SafetyWarning[];
}

const AUTOMATIC_MATCH_CONFIDENCE = 0.85;

function decision(
  disposition: SafetyDisposition,
  reasons: readonly SafetyReason[],
  warnings: readonly SafetyWarning[],
): MutationSafetyDecision {
  return { disposition, reasons, warnings };
}

/**
 * Applies user-approved safety rules before a Calendar API write is attempted.
 * A model or parser may propose an action, but only this policy can authorize it.
 */
export function evaluateMutationSafety(input: MutationSafetyInput): MutationSafetyDecision {
  const warnings: SafetyWarning[] = input.hasCalendarConflict ? ["calendar_conflict"] : [];

  if (input.operation === "list") {
    return decision("proceed", [], warnings);
  }

  if (input.operation !== "create") {
    if (!input.match || input.match.candidateCount === 0) {
      return decision("require_clarification", ["target_not_found"], warnings);
    }

    if (input.match.candidateCount !== 1 || input.match.confidence < AUTOMATIC_MATCH_CONFIDENCE) {
      return decision("select_target", ["ambiguous_match"], warnings);
    }

    if (input.target?.isRecurring && input.operation !== "set_reminder" && !input.recurrenceScope) {
      return decision("require_clarification", ["recurrence_scope_required"], warnings);
    }
  }

  const reasons: SafetyReason[] = [];

  if (input.proposedByModel && !input.allowModelAutoExecution) {
    reasons.push("model_proposed");
  }

  if (input.operation === "delete") {
    reasons.push("delete_event");
  }

  if (input.operation === "manage_attendees" || input.introducesAttendees) {
    reasons.push("attendee_change");
  }

  if (input.target?.hasExternalGuests && input.operation !== "set_reminder") {
    reasons.push("guest_impact");
  }

  if (
    input.target?.isRecurring &&
    input.recurrenceScope &&
    input.recurrenceScope !== "this_instance"
  ) {
    reasons.push("recurring_series_change");
  }

  return reasons.length > 0 ? decision("require_confirmation", reasons, warnings) : decision("proceed", [], warnings);
}
