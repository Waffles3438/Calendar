# reminder-delete-task-mismatch Bugfix Design

## Overview

This bugfix closes a domain-routing gap in named natural-language deletion. A natural-language reminder can be created in the new owner-private scheduled-item domain (`scheduled_items`), but a model-proposed request such as `delete play among us` is currently validated as `delete_task` and dispatched only to the legacy `local_tasks` assistant. When no legacy row matches, the bot returns the legacy no-match response and leaves the scheduled reminder active.

The fix is deliberately narrow. A single-item, model-proposed `delete_task` action will first ask the scheduling assistant whether an eligible owner-scoped scheduled reminder matches the supplied title and optional date. If a scheduled reminder matches, the scheduling assistant will use its existing reviewed cleanup payload, confirmation flow, owner check, future-eligibility check, revision check, audit path, and scheduled-item cancellation operation. If no scheduled reminder matches, the action will fall through to the existing `LocalTaskAssistant`, preserving legacy local-task matching, response text, and direct one-time transition behavior. Bulk `delete_task` actions continue to use the legacy task path. Calendar actions, explicit deterministic scheduling cleanup, reminder delivery, and persistence formats are not broadened or rewritten.

The existing `.kiro/specs/reminder-delete-task-mismatch/.config.kiro` already contains the required requirements-first bugfix configuration. This phase creates only this design document; it does not implement source changes or read the active `.env`.

## Glossary

- **Bug_Condition (C)**: An authorized owner's single named deletion is represented as a `delete_task` action, an active eligible scheduled reminder owned by that owner matches the normalized title and optional date, and routing sends the action only to the legacy local-task domain.
- **Property (P)**: A matching scheduled reminder is resolved through the scheduling domain and cancelled only through the existing safe mutation policy; no unrelated task, reminder, Calendar event, or Calendar reminder override is changed.
- **Preservation**: For inputs outside the bug condition, the fixed behavior remains the original behavior: legacy local-task operations remain legacy operations, explicit deterministic scheduling cleanup remains unchanged, and Calendar routing remains separate.
- **F**: The current/unfixed dispatch and mutation behavior.
- **F'**: The fixed dispatch and mutation behavior after the design is implemented.
- **ScheduledItem**: A new owner-private date-only task or timed reminder persisted by `SchedulingRepository` in `scheduled_items`; a timed reminder has `kind = "reminder"`, a UTC `dueAt`, a local `scheduledDate`, an encrypted title, status, and revision.
- **Legacy LocalTask**: A one-time timed task persisted by `AppStateRepository` in `local_tasks`; it has a UTC `dueAt`, encrypted title, owner, status, and revision. Existing local-task commands and delivery use this domain.
- **Eligible scheduled reminder**: An active owner-scoped scheduled reminder matching the title terms and optional date under the existing cleanup scope. An unscoped request considers strictly future timed reminders; a date-scoped request retains the current date-scoped behavior for active records on that local scheduled date.
- **Selector matching semantics**: Lowercase, punctuation-separated title terms with the current generic selector words excluded and every remaining term required to occur in the stored title. A missing date matches by title; a supplied date matches the item's existing local scheduled date.
- **Reviewed cleanup**: The existing `ScheduleAssistant` flow that snapshots IDs and revisions, stores an owner-bound expiring pending action, requires confirmation for model-proposed changes, revalidates the snapshot, and calls the repository cancellation methods.

## Bug Details

### Bug Condition

The reported creation request can be accepted by the unified natural-language planner as `create_task_or_reminder` with `scheduleKind = "reminder"`. `OwnerCommandRouter` sends that action to `ScheduleAssistant`, which persists the owner-scoped reminder through `SchedulingRepository.createScheduledItem`. The scheduled reminder scheduler later reads only active owner rows from `scheduled_items` and uses durable delivery claims.

The subsequent named deletion is commonly returned by the unified planner as `delete_task` with `scope = "single"` and a title selector. The router currently sends every `delete_task` action to `LocalTaskAssistant`. That assistant calls `AppStateRepository.listActiveLocalTasks`, so it cannot see the scheduled reminder in `scheduled_items`. It then emits `I could not find an active local task matching that description.` without attempting scheduled-item cleanup.

The deterministic parser intentionally leaves the untyped phrase `delete play among us` unsupported; the fix must not turn every untyped delete into a broad deterministic cleanup. Explicit deterministic forms such as `delete reminder play among us` already enter the existing scheduling cleanup path and must remain unchanged.

**Formal Specification:**

```text
FUNCTION isBugCondition(input)
  INPUT: input containing authenticatedOwner, requestAction, currentTime,
         scheduledItems, legacyLocalTasks, and currentDispatch
  OUTPUT: boolean

  selectorTerms := normalizeTaskSelectorTerms(input.requestAction.selector.title)
  scheduledMatches := all item in input.scheduledItems where
    item.ownerId = input.authenticatedOwner AND
    item.kind = "reminder" AND
    item.status = "active" AND
    titleMatches(item.title, selectorTerms) AND
    optionalDateMatches(item.scheduledDate, input.requestAction.selector.date) AND
    eligibleForNamedDeletion(item, input.requestAction.selector.date, input.currentTime)

  RETURN input.requestAction.action = "delete_task"
         AND input.requestAction.scope = "single"
         AND input.requestAction.selector exists
         AND scheduledMatches is not empty
         AND input.currentDispatch = "LocalTaskAssistant only"
         AND no scheduled item in scheduledMatches is cancelled
END FUNCTION
```

In set notation, `C(X)` is the set of owner-authenticated single named delete inputs for which `scheduledMatches(X) != empty` and the current dispatch does not consult the scheduled-reminder domain. The reported `delete play among us` case is one member of `C(X)` when the owner has an active future reminder titled `play among us`.

### Examples

- **Reported counterexample**: At `2026-08-18T12:00Z`, the owner creates `can you remind me in 30 min to play among us`. The accepted reminder action stores an active scheduled reminder with a rounded future due instant, encrypted title `play among us`, the configured local time zone, and revision `1`. The owner then sends `delete play among us`. Before the fix, only `local_tasks` is searched, the legacy no-match response is returned, and the scheduled reminder remains active. After the fix, the scheduling domain is reviewed for this model-proposed deletion; confirmation cancels that reminder and no future slot is claimable.
- **Exactly one scheduled match**: One active owner reminder titled `play among us` and unrelated reminders titled `call dentist` and `buy milk` exist. A model-proposed `delete play among us` creates a review containing only the matching scheduled reminder. Before confirmation it remains active; after a valid confirmation only its status changes to `cancelled` and its revision increments.
- **Multiple scheduled matches**: Two active owner reminders whose titles contain all selector terms match, for example `play among us tonight` and `play among us with Alex`. The request produces the existing candidate review and does not select one by ordering or cancel either before confirmation. A date selector limits the candidates to that scheduled local date.
- **Legacy compatibility**: No eligible scheduled reminder matches `call plumber`, but one active legacy local task matches. The scheduling probe returns “not applicable” and the existing local-task assistant handles the action, retaining its current cancellation response and revision-checked transition.
- **Cross-domain same title**: A scheduled reminder and a legacy local task both have the same normalized title. The scheduled-reminder match takes the new named-reminder path and the review contains only scheduled-reminder targets; the legacy task is not silently changed. The owner can use the existing explicit legacy local-task command to cancel the legacy row separately.
- **Owner isolation**: A different owner has a matching scheduled reminder, but the authenticated owner has none. The query is owner-scoped and returns no candidate; the system does not reveal the other owner's row or cancel it.
- **Stale review**: The owner receives a review, then another operation completes or changes the target before `confirm <id>`. The existing revision check rejects the stale cancellation and leaves the changed target untouched.

## Expected Behavior

### Correctness Specification

The desired result for the bug condition is expressed by `P(result)` below. The confirmation branch is part of the property: model-proposed deletion must not mutate before confirmation, while the existing deterministic scheduling cleanup branch keeps its current disposition.

```text
FUNCTION expectedBehavior(input, result)
  scheduledMatches := resolveOwnerScopedEligibleScheduledReminders(input)

  IF scheduledMatches is not empty THEN
    ASSERT result.domain = "scheduled_reminder"
    ASSERT result.calendarQueries = 0
    ASSERT result.targets are exactly the scheduledMatches selected by the existing scope
    ASSERT result.legacyLocalTaskTargets = empty

    IF input.source = "gemini" OR input.requiresReview THEN
      ASSERT result.beforeConfirmation.mutated = false
      ASSERT validUnexpiredOwnerConfirmation(input.confirmation) is required
    END IF

    IF validUnexpiredOwnerConfirmation(input.confirmation) THEN
      ASSERT every target cancellation uses input.ownerId
      ASSERT every target cancellation uses its captured expectedRevision
      ASSERT only result.targets become cancelled
      ASSERT unrelated scheduled items, legacy tasks, Calendar events, and overrides are unchanged
    END IF
  ELSE
    ASSERT result is the existing LocalTaskAssistant behavior
  END IF

  ASSERT no request is broadened to Calendar data or unrelated scheduled kinds
END FUNCTION
```

### Preservation Requirements

**Unchanged Behaviors:**

- Relative and scheduled reminder creation continues to persist the same title, UTC due instant, configured time zone, owner scope, status, recurrence/materialization behavior, and revision. The relative `30 min` rounding rule remains unchanged.
- `ScheduledReminderScheduler` continues to deliver the upcoming, due, and late reminder slots with durable claim, send, record, and retry semantics. Cancellation only changes the scheduled item's lifecycle state; it does not rewrite delivery history or claim behavior.
- Legacy local-task creation, listing, completion, cancellation, title/date matching, response messages, owner filtering, and revision handling remain in `LocalTaskAssistant` and `AppStateRepository`.
- Explicit deterministic cleanup such as `delete reminder <title>`, bulk cleanup, recurring cleanup, and date-scoped cleanup keeps its current target categories, future/date eligibility, review policy, and response behavior.
- Model-proposed local-task creates, completions, single cancellations, and bulk cancellations retain their current confirmation policy. The new scheduling probe must not force a confirmation on a legacy-only result that previously executed directly.
- Owner scoping remains enforced at every read, pending-action lookup, confirmation consume, and mutation. No response may disclose another owner's matching item.
- Pending confirmation cancellation, expiration, malformed payload rejection, owner mismatch, and stale revision behavior remain fail-closed. A confirmation is not an authorization or freshness bypass.
- Calendar event creation, move, deletion, attendee changes, recurrence, guest notifications, reminder overrides, and legacy Calendar routing remain in `CalendarAssistant`; the new named-reminder path performs no Calendar query.

**Scope:**

Inputs outside `C(X)` must remain unaffected. This includes non-single and bulk `delete_task` actions, requests with no eligible scheduled reminder, legacy-only local-task requests, non-delete actions, other keyboard/command inputs, Calendar actions, explicit deterministic cleanup, and planner-unavailable fallback. The fix must not add an untyped broad delete parser or reinterpret an unsupported request as deletion.

## Hypothesized Root Cause

1. **Cross-domain action routing mismatch**: The unified action contract names the operation `delete_task`, but the router treats that name as synonymous with the legacy `LocalTaskAssistant` domain. The same action can follow a scheduled-reminder creation path, so the deletion path does not mirror creation's domain.

2. **Existing scheduled cleanup is unreachable for this action**: `ScheduleAssistant.prepareCleanup` already searches active scheduled items and, for existing explicit reminder cleanup, can snapshot and cancel them safely. The `OwnerCommandRouter` never offers that handler the single model-proposed `delete_task` action.

3. **No cross-domain fallback boundary**: `LocalTaskAssistant.findMatchingTasks` can correctly match legacy rows, but its no-match response is terminal. There is no preceding scheduling probe that distinguishes “no scheduled reminder” from “a scheduled reminder exists.”

4. **Selector implementations are separate**: Legacy tasks use a title-term selector and scheduled cleanup uses title-term filtering in a different module. A new route must share or explicitly reuse the existing normalized selector semantics rather than introduce exact-string matching, fuzzy matching, or broad substring behavior.

5. **Safety logic is already centralized elsewhere**: Owner/revision checks, pending-action expiry, model attribution, future eligibility, and durable scheduled delivery checks are implemented in repository and `ScheduleAssistant` paths. Reimplementing cancellation in the router or changing the scheduler would risk bypassing those safeguards and delivery guarantees.

6. **Deterministic fallback must stay narrow**: The schedule parser deliberately defers legacy phrases and leaves untyped delete wording unsupported. Expanding its grammar as part of this fix would make provider failures mutate a broader domain than the owner explicitly identified.

## Correctness Properties

Property 1: Bug Condition - Named scheduled reminders are resolved and safely cancelled

_For any_ input where the bug condition holds (isBugCondition returns true), the fixed routing SHALL resolve the authenticated owner's matching active scheduled reminder through `ScheduleAssistant`, preserve the existing review requirement for model-proposed deletion, and after a valid unexpired owner confirmation cancel only the captured scheduled-reminder target(s) with owner and revision checks; no unrelated task, reminder, Calendar event, or override SHALL change.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation - Non-buggy domain routing and existing behavior

_For any_ input where the bug condition does NOT hold (isBugCondition returns false), the fixed function SHALL produce the same result as the original function, preserving legacy local-task matching and mutation, deterministic fallback, owner scoping, confirmation/expiration/revision safety, Calendar routing, bulk policy, and scheduled-reminder creation and delivery semantics.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

The implementation should reuse existing repository and pending-action contracts. No database migration, new delivery table, new reminder slot, or Calendar API change is required.

1. **`src/application/owner-command-router.ts` — offer single named deletion to scheduling before legacy fallback**
   - Extend the `ScheduleMessageHandler.handleNaturalLanguageAction` action union to accept `delete_task` and retain its boolean handled/not-applicable result.
   - In `dispatchNaturalLanguageAction`, split the `delete_task` case by scope. For `scope = "single"` with a selector, call the schedule assistant first. If it returns `true`, stop routing. If it returns `false`, call `LocalTaskAssistant.handleNaturalLanguageAction` exactly as today. Route `scope = "today"` and `scope = "all"` directly to the existing local-task assistant without a scheduling probe.
   - Do not alter the `delete_calendar_event` branch, the legacy Calendar-delete pre-routing, the pending-action handler order, or the planner/fallback entry points.
   - Treat a scheduling repository read failure as handled-but-failed: log and reply with the existing safe retry style rather than falling through to a potentially wrong legacy mutation.

2. **`src/scheduling/schedule-assistant.ts` — add a named model-deletion entry point**
   - Add a `delete_task` case to `handleNaturalLanguageAction`. It must return `false` only when there is no eligible owner-scoped scheduled reminder for the selector; this is the explicit signal for legacy fallback. It must return `true` for a scheduled candidate, a safe no-match/error response, or a scheduled review.
   - Add a private `tryHandleNamedScheduledReminderDeletion` operation that accepts the validated selector title and optional date. It must:
     1. Normalize selector terms with the shared selector helper described below.
     2. Ensure recurring scheduled occurrences are materialized using the same horizon/current-owner call already used by `prepareCleanup`.
     3. Query `SchedulingRepository.listActiveScheduledItems` with `ownerId`, `kinds: ["reminder"]`, and a date range beginning at the current local date when no date is supplied, or the exact selector date when one is supplied.
     4. Filter with the shared title-term matcher and the existing eligibility rule: strictly future for an unscoped request, or active records on the supplied date for a date-scoped request.
     5. Return `false` if that scheduled candidate set is empty, without creating a pending action or changing state.
     6. If candidates exist, construct the existing named cleanup command with `targetKinds: ["reminder"]`, the normalized terms, the original display title, and the optional date, then enter the existing cleanup preparation path with `responseSource = "gemini"`.
   - Add an internal `includeLegacy`/schedule-only option to `prepareCleanup`, defaulting to the current behavior for all existing callers. The new scheduled-reminder action must pass `includeLegacy: false`, so a same-title legacy task is not changed as a side effect of a scheduled-reminder deletion. Existing explicit deterministic cleanup callers retain `includeLegacy: true` and their current mixed-domain behavior.
   - Reuse `PendingScheduleCleanup` without a new payload kind. The new pending payload contains scheduled item IDs and expected revisions, `legacyItems: []`, `calendarEvents: []`, any existing series representation required by the current recurrence policy, `cleanupScope`, and `responseSource: "gemini"`.
   - Reuse `executeCleanup` unchanged for scheduled-item mutation and response attribution. It must continue to call `cancelScheduledItems` transactionally with the owner ID and captured revisions, reject stale/unavailable targets, record `schedule_cleanup` audit data, and produce the normal scheduled-item response. A model-proposed one-target request must remain reviewed because `deleteImmediately` is already disabled for `responseSource = "gemini"`.
   - Do not make this path query `calendarGateway`, target `kind = "task"`, or call `cancelLocalTask` directly.

3. **`src/tasks/task-selector.ts` (new pure helper) and `src/tasks/local-task-assistant.ts` — share selector semantics without changing legacy behavior**
   - Extract the current legacy title-term normalization into a small dependency-free helper, for example `normalizeTaskSelectorTerms` and `titleMatchesTaskSelector`. Preserve the current lowercase tokenization and generic-term handling, including the nonempty fallback for an all-generic title.
   - Update `LocalTaskAssistant.findMatchingTasks` to call the helper with the same owner-scoped active-task query and date calculation. This is a refactor-only preservation change.
   - Use the same helper for the new scheduled-reminder preflight so `play among us` has identical selector semantics in both domains. Do not replace existing `schedule-parser` cleanup term behavior for explicit deterministic cleanup; that path is outside the bug fix.

4. **`src/scheduling/scheduling-repository.ts` — retain existing persistence contracts**
   - Use the existing active range query and existing `cancelScheduledItems`; no new SQL is needed.
   - Preserve `owner_id = ?`, `status = 'active'`, and `revision = ?` conditions. A successful cancellation continues to set `status = 'cancelled'`, `cancelled_at`, `updated_at`, and increments `revision`.
   - Do not delete delivery records or claims. `tryClaimScheduledReminderDelivery` already requires an active owner-scoped reminder, so a cancelled item cannot acquire another slot. Existing in-flight/at-least-once behavior remains as documented.

5. **`src/nlp/gemini-action-planner.ts` — clarify the existing action contract only if needed**
   - Keep the `delete_task` schema unchanged; the model still returns a validated `scope` and title selector and never receives rows or IDs.
   - Update the planner instruction to say that a single named private task/reminder deletion is resolved by the application against scheduled reminders first and legacy local tasks as fallback, while Calendar deletions use `delete_calendar_event`. This prevents the prompt from asserting that every single deletion is necessarily legacy-only.
   - Do not add IDs, Calendar fields, execution tools, or a new model action.

### Interfaces and Data Flow

**Creation path (unchanged):**

```text
Owner DM: "can you remind me in 30 min to play among us"
  -> unified planner returns create_task_or_reminder(reminder, resolved date/time, title)
  -> OwnerCommandRouter.dispatchNaturalLanguageAction
  -> ScheduleAssistant.handleNaturalLanguageAction
  -> SchedulingRepository.createScheduledItem
       ownerId, kind=reminder, encrypted title, dueAt UTC, scheduledDate,
       timeZone, status=active, revision=1
  -> ScheduledReminderScheduler.listDueScheduledReminders(ownerId)
  -> durable claim -> Discord send -> delivery record
```

**Fixed named deletion path:**

```text
Owner DM: "delete play among us"
  -> unified planner returns delete_task(scope=single, selector={title, optional date})
  -> OwnerCommandRouter tries ScheduleAssistant for this scope only
  -> ScheduleAssistant queries active owner-scoped scheduled reminders
  -> if a scheduled reminder matches:
       build schedule-only PendingScheduleCleanup with IDs + expected revisions
       responseSource=gemini; no mutation
       reply with existing Review matches / confirm <id>
       -> confirm/cancel routed through owner-bound pending action
       -> on confirm, re-read owner/revision/future eligibility
       -> SchedulingRepository.cancelScheduledItems
       -> scheduled status=cancelled; future delivery claims fail
       -> existing scheduled cleanup response and audit
  -> if no scheduled reminder matches:
       return false to router
       -> LocalTaskAssistant.handleNaturalLanguageAction
       -> existing AppStateRepository local-task match/transition/response
```

The schedule probe is intentionally a domain-resolution step, not a model decision. The model never sees storage rows, IDs, revisions, or Calendar data. The authenticated owner and repository methods remain authoritative.

### Edge Cases and Invariants

- **Zero scheduled matches**: Do not create a schedule pending action. Fall through once to the legacy assistant; do not issue a second hosted interpretation and do not broaden to all scheduled kinds.
- **One scheduled match, no legacy mutation**: The schedule-only pending payload must contain no `legacyItems`, even if a legacy task has the same title. This enforces the requirement that cancelling the matching reminder does not change a task.
- **Multiple scheduled matches**: Preserve the current scheduled cleanup review and deterministic ordering. Do not choose the first ID. The confirmation applies only to the displayed, revision-snapshotted scheduled candidates.
- **Optional date**: A supplied date uses the stored scheduled local date and the existing date-scoped inclusion rule. Without a date, past/current timed reminders are not selected by the unscoped future cleanup rule.
- **Recurring scheduled reminders**: Keep the existing series policy. A matching recurring occurrence without a date remains a reviewed series cleanup under the existing `series` payload; it is never silently collapsed into a one-off direct cancellation. A date-scoped occurrence follows the existing date-scoped behavior.
- **Same title across owners**: Every scheduled query, legacy fallback query, pending read, pending consume, and mutation carries the authenticated owner ID. Another owner's row must be indistinguishable from no match.
- **Confirmation cancelled or expired**: Consume the pending action using the existing owner/expiry checks, leave the scheduled item active, and retain the current response. No retry action is synthesized.
- **Target changed after review**: A completed/cancelled target, revision mismatch, or lost eligibility causes the existing safe failure response. Bulk scheduled cancellation remains transactionally all-or-nothing for its scheduled target set.
- **Scheduler race**: If a scheduler claim was already acquired before cancellation, the existing at-least-once delivery semantics still apply. The fix does not promise to retract a Discord message already accepted or alter claim leases; it prevents later claims once status is cancelled.
- **Planner unavailable or malformed**: No new scheduled probe is invoked without a validated `delete_task` action. Existing deterministic handlers and clarification/fallback responses remain authoritative.
- **Calendar wording**: `delete_calendar_event` continues directly to `CalendarAssistant`; named-reminder resolution never searches event summaries, reminder overrides, or Google data.
- **Dry run**: Existing dry-run handling remains before pending creation or mutation, and no reminder/task state changes.

## Testing Strategy

### Validation Approach

Validation follows the bug-condition methodology in two phases. First, add and run an exploratory test against the current/unfixed routing to capture the concrete counterexample. Then implement the narrow route change and run fix and preservation checks. All tests use in-memory repositories, fake owner messages, fixed clocks, and fake planners/gateways; no `.env` or external provider is needed.

### Exploratory Bug Condition Checking

**Goal**: Demonstrate that the current code fails specifically because the model-proposed named deletion is sent to the legacy local-task domain, and distinguish that failure from creation or scheduler delivery defects.

**Test Plan**: Seed an active owner scheduled reminder in `SchedulingRepository`, provide a unified planner returning `delete_task` with `scope = "single"`, route the message through `OwnerCommandRouter`, and run the test on the unfixed code. Use a legacy state double that records whether it was queried. Confirm the legacy no-match response and that the scheduled item remains active.

**Test Cases**:

1. **Reported model deletion**: One scheduled reminder titled `play among us`, no legacy row; `delete play among us` produces `I could not find an active local task matching that description.` and leaves the scheduled item active on unfixed code.
2. **Relative-reminder creation followed by deletion**: Route a planner-proposed `create_task_or_reminder` first, verify the scheduled row and due instant, then route the delete action; the unfixed second step leaves the row active.
3. **Multiple scheduled candidates**: Seed two matching reminders; the unfixed route still reports only a legacy no-match rather than exposing a scheduled review.
4. **Legacy control**: Seed only a legacy local task; confirm the existing local-task path still handles its single cancellation, establishing the preservation baseline.
5. **Calendar control**: Provide a `delete_calendar_event` action and a Calendar double; confirm it remains on the Calendar assistant and never enters the reminder probe.

**Expected Counterexamples**:

- The scheduler repository contains an active matching reminder after the delete response.
- No `schedule_cleanup` pending action is stored for the model-proposed reminder deletion.
- The legacy no-match response is emitted even though the scheduled repository has a matching owner row.
- No Calendar call is expected for the bug reproduction; if one occurs, the fix has crossed a domain boundary.

### Fix Checking

**Goal**: Verify the fix for every input in `C(X)`, including confirmation and delivery consequences.

**Pseudocode:**

```text
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedRouter(input)
  ASSERT result.beforeConfirmation.mutated = false
  ASSERT result.pending.ownerId = input.authenticatedOwner
  ASSERT result.pending.targets = resolveEligibleScheduledReminders(input)

  confirmationResult := confirmWithSameOwnerBeforeExpiry(result.pending.id)
  ASSERT expectedBehavior(input, confirmationResult)
  ASSERT scheduledReminderScheduler.cannotClaimFutureSlot(input.targetId)
END FOR
```

The concrete fix checks should cover a unique scheduled reminder, multiple candidates, optional date filtering, recurring candidates under existing review policy, same-title legacy coexistence, owner isolation, cancellation/expiry, and stale revision. The unique-reminder assertion must verify that unrelated scheduled reminders remain `active`, legacy rows remain unchanged, no Calendar gateway method was called, and the cancelled reminder's revision increased exactly once.

### Preservation Checking

**Goal**: Verify that for every input outside the bug condition the fixed function produces the same observable behavior and state transitions as the original function.

**Pseudocode:**

```text
FOR ALL input WHERE NOT isBugCondition(input) DO
  original := runWithOriginalRoutingAndStateSnapshot(input)
  fixed := runWithFixedRoutingAndEquivalentStateSnapshot(input)
  ASSERT fixed.reply = original.reply
  ASSERT fixed.pendingActionShape = original.pendingActionShape
  ASSERT fixed.localTaskState = original.localTaskState
  ASSERT fixed.scheduledItemState = original.scheduledItemState
  ASSERT fixed.calendarCalls = original.calendarCalls
  ASSERT fixed.deliveryClaimsAndRecords = original.deliveryClaimsAndRecords
END FOR
```

Preservation cases must include legacy-only single deletion, model-proposed local-task completion/cancellation, bulk and date-scoped local deletion, explicit deterministic `delete reminder` and `delete task` cleanup, planner unavailable/malformed output, Calendar deletion and reminder override operations, owner mismatch, expired/invalid confirmation, and all reminder creation/delivery paths.

### Unit Tests

- **Router dispatch** (`test/unified-router.test.ts`): single `delete_task` tries the schedule assistant before local fallback; a `false` schedule result invokes local exactly once; `all`/`today` never invoke the schedule probe; Calendar actions retain their existing handler.
- **Schedule named-deletion resolution** (`test/schedule-assistant.test.ts`): one scheduled reminder produces a Gemini review and no mutation before confirmation; no scheduled match returns `false`; repository failure fails closed; the pending payload is schedule-only and contains no Calendar or legacy targets.
- **Selector matching**: test case normalization, punctuation, generic terms, required all-term matching, optional date matching, and distinction between scheduled `scheduledDate` and legacy task local-date calculation.
- **Scheduled repository safety** (`test/scheduling-repository.test.ts`): existing owner/revision cancellation remains valid, stale revisions return no result, cancelled reminders cannot acquire a delivery claim, and unrelated delivery records are untouched.
- **Legacy task preservation** (`test/local-task-assistant.test.ts`): existing unique/multiple/no-match cancellation assertions remain unchanged, including direct model-proposed legacy cancellation without a new confirmation.
- **Pending action safety**: owner-bound lookup, expiration, cancel, malformed payload, and stale target behavior continue to use existing responses and no-mutation guarantees.

### Property-Based Tests

The repository currently uses Vitest and does not declare a property-testing dependency. The implementation can use a seeded Vitest generator for bounded generated cases without adding a dependency; if a property library is selected, it must be added as an exact pinned development dependency during implementation.

- **Fix property**: Generate owners, normalized titles, optional dates, due instants, unrelated reminders, and one or more active scheduled candidates. For every generated `C(X)`, route a validated single deletion, assert no pre-confirmation mutation, confirm as the same owner, and assert exactly the matching scheduled target set is cancelled while unrelated scheduled items, legacy tasks, and Calendar doubles remain unchanged.
- **Selector property**: Generate titles with whitespace, punctuation, case variation, and generic words. Assert that scheduled matching and legacy matching agree with the shared selector-term function and never match when any required non-generic term is absent.
- **Preservation property**: Generate non-buggy actions—bulk scopes, no scheduled matches, legacy-only matches, other action kinds, invalid/expired confirmations, and different owners—and compare fixed routing/state to a captured original behavior model. Assert no new pending action or mutation is introduced outside `C(X)`.
- **Delivery property**: For generated future reminder times and cancellation points, assert an active item can claim its eligible slot under the existing scheduler rules, while a successfully cancelled item cannot claim a later slot; already accepted sends retain the documented at-least-once behavior.

### Integration Tests

- **End-to-end reproduction** (`test/schedule-assistant-integration.test.ts`): create a timed scheduled reminder through the typed `create_task_or_reminder` path, send the model-proposed named delete through the router, verify review/no mutation, confirm it, and verify only the reminder is cancelled.
- **Mixed-domain compatibility**: use a real `SchedulingRepository` and a legacy state double with the same title; verify scheduled precedence cancels only the scheduled reminder, while a legacy-only request still reaches the local assistant.
- **Ambiguity and stale review**: seed multiple scheduled reminders, verify all candidates are displayed and remain active before confirmation, then exercise valid confirmation, cancellation, expiry, and a revision change before confirmation.
- **Owner isolation**: seed same-title rows for two owners and verify the active owner sees only its own candidate and cannot confirm or mutate the other owner's pending action.
- **Reminder delivery semantics** (`test/scheduled-reminder-scheduler.test.ts`): verify a cancelled reminder is excluded from future delivery claims and that creation, early/due/late slot selection, durable claim, send failure retry, and delivery recording remain unchanged.
- **Routing regression**: verify `delete_calendar_event`, Calendar reminder overrides, explicit deterministic cleanup, unsupported untyped deletes, and planner-unavailable fallback retain their current handlers and replies.
