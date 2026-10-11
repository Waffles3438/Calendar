# Bugfix Requirements Document

## Introduction

The `single-delete-confirmation` bugfix removes an unnecessary confirmation step from validated single named deletion. The reported behavior is a request such as `delete play among us` producing a `Review matches ... reminder ... Reply confirm ...` response even though the request resolves to exactly one private reminder. The same unnecessary confirmation currently applies to an exactly identified private, non-recurring Calendar event, while an exact private local task already follows the desired immediate-cancellation behavior.

The requirements below define an exact target as one eligible owner-scoped candidate remaining after the existing named-delete resolution across all applicable deletion domains. The change is limited to that validated single named-delete result. Shared Calendar events, ambiguous or multiple results, recurring operations, explicit commands, bulk operations, and all existing freshness and authorization safeguards remain protected.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a validated single named delete request from an authenticated owner resolves to exactly one active, eligible, owner-scoped, one-time scheduled reminder that is not shared with other people, THE system SHALL create or return a confirmation review identifying that reminder and SHALL leave the reminder active and otherwise unchanged until the authenticated owner supplies confirmation.

1.2 WHEN a validated single named delete request from the authenticated owner resolves to exactly one active, eligible, non-recurring Calendar event with no external guests or other attendees, THE system SHALL create or return a model-proposed confirmation for that event and SHALL leave the event unchanged until the authenticated owner supplies an explicit confirmation accepting the deletion, regardless of whether the event is private or unambiguous.

### Expected Behavior (Correct)

2.1 WHEN a validated delete request specifies exactly one task name and resolves to exactly one active, eligible, owner-scoped private local task, THE system SHALL apply the existing owner and revision checks before cancelling the resolved task, SHALL cancel it only after both checks pass and without displaying a confirmation prompt or requiring confirmation input, and SHALL leave every other task, reminder, and Calendar event unchanged.

2.2 WHEN a validated single named delete resolves to exactly one active, eligible, owner-scoped, one-time scheduled reminder and the existing owner, date/future-eligibility, and revision checks pass, THE system SHALL cancel that reminder without creating or requesting a confirmation. Upon successful cancellation, THE system SHALL change only that reminder’s lifecycle state from active to cancelled and its revision, leave all other reminder attributes and all other reminders unchanged, and exclude the cancelled reminder from eligibility for every subsequent delivery claim.

2.3 WHEN a validated single named delete resolves to exactly one Calendar event that is active, eligible for deletion, non-recurring, has zero external guests and zero other attendees, and passes the existing access, writable-calendar, freshness, ETag, and date/future-eligibility checks, THE system SHALL delete that event without creating or requesting any confirmation. The system SHALL not notify external guests and SHALL leave unchanged every Calendar event other than the deleted event, task, reminder, and reminder override.

2.4 WHEN a validated single named delete resolves to exactly one active, eligible Calendar event that is shared with an external guest or other attendee, THE system SHALL leave that event unchanged until it receives a valid confirmation bound to the event owner and whose validity period has not expired. IF the confirmation is valid and the existing freshness checks pass, THEN THE system SHALL delete only that resolved Calendar event and SHALL retain the existing guest-notification behavior.

2.5 WHEN a validated single named delete resolves to two or more eligible candidates—including candidates with the same title in different domains or multiple matching occurrences—THEN the system SHALL not apply the exact-single rule, SHALL retain the existing explicit selection or review flow, SHALL leave all eligible candidates unchanged until the user completes the required selection or confirmation, and SHALL neither select the first candidate by default nor delete all eligible candidates without explicit confirmation of that deletion scope.

2.6 WHEN, after an exact private target has been resolved and before the attempted immediate mutation is applied, any of the target’s status, owner, scheduled date, future-eligibility, revision, ETag, access, or sharing values differs from the corresponding value observed during resolution and causes the target to fail an existing safety rule, THE system SHALL fail closed using the existing safe failure behavior, SHALL make no mutation to the target, and SHALL not bypass the required confirmation.

2.7 WHEN this path successfully deletes an exact private local task, a one-time scheduled reminder, or a non-recurring Calendar event, THEN the system SHALL return the existing domain-appropriate success result for the resolved target, SHALL return no confirmation identifier and complete without requiring a pending confirmation, and SHALL expose the resolved target as deleted while leaving every other task, reminder, and Calendar event with the same observable attributes they had before the deletion.

**Bug condition and fix-checking property:** Let `F` be the current behavior and `F'` be the behavior after the bugfix.

```text
FUNCTION isBugCondition(X)
  INPUT: X containing a validated named-delete action, authenticated owner,
         resolved eligible candidates, current target state, and F(X)
  OUTPUT: boolean

  target := the only element of X.resolvedCandidates

  RETURN X.action.action = "delete_task"
         AND X.action.scope = "single"
         AND X.resolvedCandidates.count = 1
         AND target.owner = X.authenticatedOwner
         AND target.status = "active"
         AND target is eligible under the existing date/future rules
         AND (
           (
             target.domain = "scheduled_reminder"
             AND target.isRecurring = false
           )
           OR (
             target.domain = "calendar_event"
             AND target.hasExternalGuests = false
             AND target.isRecurring = false
           )
         )
         AND F(X).requestsConfirmation = true
END FUNCTION

// Property: Fix Checking
FOR ALL X WHERE isBugCondition(X) DO
  result := F'(X)
  ASSERT result.requestsConfirmation = false
  ASSERT result.mutationTargets = { target }
  ASSERT result.mutationTargets do not include any unrelated task, reminder,
         Calendar event, attendee, or reminder override
  ASSERT the target is cancelled/deleted only after the existing owner,
         freshness, revision, ETag, and eligibility checks pass
END FOR
```

**Exact-private-target property:** For every validated single named delete whose complete resolution contains exactly one private local task, one-time scheduled reminder, or non-recurring Calendar event without external participants, `F'` SHALL perform the existing domain mutation directly, without a confirmation prompt, and SHALL preserve the domain's existing authorization and freshness protections.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a named-delete resolution is ambiguous, has two or more eligible candidates, or has matching candidates across two or more domains, THE system SHALL require the existing explicit selection or review behavior before routing any candidate, leave all candidates unchanged until the user completes that action, and revalidate the selected candidate after the action and before routing it.

3.2 WHEN a deletion request targets a single Calendar event shared with external guests or other attendees, THE system SHALL require explicit confirmation before deletion; after receiving confirmation and before deleting the event, THE system SHALL re-read the event’s current ETag and sharing state and apply the existing owner and expiry checks; THE system SHALL delete the event and invoke the existing guest-notification behavior only when the confirmation and checks succeed, and SHALL leave the event undeleted when confirmation is absent or any check fails.

3.3 WHEN a Calendar event is recurring, a recurring scope is requested, or the requested deletion would affect a series or future occurrences, THE system SHALL apply the existing recurrence-scope clarification, master-version checks, confirmation, and series operation rules before deleting any affected occurrence, regardless of whether the initial candidate search returns exactly one candidate or more than one candidate, and SHALL NOT treat the operation as a private one-shot deletion solely because exactly one candidate was initially found.

3.4 WHEN the owner invokes an explicit deterministic task, reminder, Calendar, date-scoped, bulk, or recurring deletion command, THE system SHALL preserve the behavior established for that command type before this bugfix, including its target categories, matching rules, immediate-versus-review policy, confirmation behavior, applicable limits, response text, and mutation semantics.

3.5 IF a request is not a validated single named delete—that is, a deletion of exactly one named item in exactly one domain—or if the request uses a `delete_task` action with `today` or `all` scope, unsupported or untyped delete wording, a malformed action, planner-unavailable fallback routing, or is not a delete action, THEN the system SHALL continue to use the existing routing for that request and SHALL NOT automatically delete items from more than one domain (calendar, task, or reminder) as a result of that request.

3.6 IF a deletion request is owner-mismatched, cancelled, expired, malformed, stale, inaccessible, no longer writable, or fails any applicable existing revision, ETag, status, date, future-eligibility, or authorization check, THEN the system SHALL reject the deletion, provide a failure indication without disclosing any other owner's target, and leave the target and all related state unchanged.

3.7 WHEN a private exact local task or a one-time scheduled reminder is processed through the existing resolver and domain path, THE system SHALL preserve the existing behavior by enforcing owner scoping, requiring an exact title and date match, applying the existing lifecycle transition, producing the existing audit result and response text, incrementing the revision by exactly one, and preserving the existing reminder-delivery exclusion; THE system SHALL leave reminder creation, persistence, recurrence materialization, claims, retries, and delivery history unchanged.

3.8 WHEN a request targets Calendar creation, movement, attendee management, reminder overrides, listing, access checks, or any Calendar operation other than named-calendar deletion, THE system SHALL preserve the same externally observable safety, guest, recurrence, ETag, notification, and response behavior established before the named-delete change, for both successful and rejected requests.

3.9 WHEN two selector texts differ only by one or more of the existing case, punctuation, Unicode-token, generic-word, or optional-date normalization rules, THE system SHALL resolve both texts to the same eligible candidate set and SHALL produce the same confirmation decision for both texts; the confirmation decision SHALL be determined only by the resolved candidate count and sharing/recurrence safety state, and SHALL NOT vary because of superficial title-format differences.

**Preservation condition and preservation-checking property:**

```text
FUNCTION isPreservationCondition(X)
  INPUT: X from the same validated command and domain space
  OUTPUT: boolean

  RETURN NOT isBugCondition(X)
END FUNCTION

// Property: Preservation Checking
FOR ALL X WHERE isPreservationCondition(X) DO
  original := F(X)
  fixed := F'(X)
  ASSERT fixed.reply = original.reply
         OR the only difference is the intended no-confirmation success result
             for an exact private target covered by Requirements 2.1-2.3
  ASSERT fixed.pendingActionShape = original.pendingActionShape
         for every input outside the intended exact-private change
  ASSERT fixed.mutationTargets = original.mutationTargets
         for every input outside the intended exact-private change
  ASSERT fixed.owner, revision, ETag, recurrence, guest, delivery, and
         unrelated-state outcomes equal the original outcomes
END FOR
```
