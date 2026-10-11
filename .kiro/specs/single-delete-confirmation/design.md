# Single Delete Confirmation Bugfix Design

## Overview

The unified named-delete route already performs the important first safety step: `NamedDeleteResolver` searches every configured owner-scoped deletion domain and returns an exact result only when the complete eligible candidate set contains one item. The defect occurs after that resolution. The scheduled-reminder and Calendar adapters still treat an exact private result as a model-proposed destructive action that must be reviewed, while the local-task adapter already executes the existing revision-checked transition directly.

The focused correction is to preserve `NamedDeleteHandler`'s exact-candidate routing and expose the existing domain mutation paths for the two affected private cases:

- an exact, active, owner-scoped, one-time scheduled reminder is passed directly to the existing scheduled cleanup execution;
- an exact, active, writable, non-recurring Calendar event with no external guests or other attendees is passed directly to the existing Calendar mutation execution.

The Calendar execution must still perform its fresh read, access/read-only, status, ETag, requested-date or future-eligibility, recurrence, and mutation safety checks immediately before the write. A private Calendar deletion sends `sendUpdates: "none"`. A shared Calendar deletion remains a confirmation flow and sends `sendUpdates: "all"` only after valid confirmation and successful revalidation. The change is route-local; `evaluateMutationSafety` is not weakened globally and no new mutation mechanism is introduced.

### Affected Components

- `src/application/named-delete-handler.ts`: retain the existing complete-resolution, exact routing, ambiguity selection, and owner-bound pending-selection behavior. No new mutation path is needed here.
- `src/application/named-delete-resolver.ts`: retain the existing all-domain resolution, exact candidate count, owner scoping, date/future filtering, recurrence metadata, and `hasExternalGuests` snapshot. No matching or normalization changes are required.
- `src/scheduling/schedule-assistant.ts`: narrow `handleResolvedNamedReminderCancellation` so only a one-time reminder executes the existing cleanup payload immediately; recurring/materialized series candidates continue to create the existing reviewed cleanup action.
- `src/application/calendar-assistant.ts`: add a private exact-named-delete execution intent that reuses `executeMutation` and allows no-confirmation completion only while the fresh event remains private and non-recurring. Shared or newly unsafe targets use the existing confirmation/rejection behavior.
- `src/tasks/local-task-assistant.ts`: preserve the current direct `handleResolvedNamedCancellation` path and its owner/revision/lifecycle safeguards.
- `src/policy/mutation-policy.ts`: do not change the policy implementation or its behavior for ordinary Calendar operations.
- Primary tests: `test/named-delete-resolver.test.ts`, with focused domain assertions in `test/schedule-assistant.test.ts`, `test/calendar-assistant.test.ts`, and `test/local-task-assistant.test.ts` as appropriate.

## Glossary

- **Bug_Condition (C)**: A validated single named-delete request whose complete resolution has exactly one eligible private one-time scheduled reminder or exactly one eligible private non-recurring Calendar event, while the current implementation still requests confirmation.
- **Property (P)**: The desired result for a buggy input: perform exactly the existing domain mutation without creating a confirmation, after all existing safety checks pass, and change no unrelated state.
- **Preservation**: Every behavior outside the intended exact-private exception remains unchanged, including ambiguity review, recurring scope handling, explicit and bulk commands, guest confirmation and notifications, freshness checks, and failure behavior.
- **F**: The current, unfixed behavior.
- **F'**: The behavior after this focused change.
- **Validated single named delete**: A `delete_task` action with `scope: "single"` and one usable selector that is resolved across all configured deletion domains before routing.
- **Exact candidate**: The sole candidate in the resolver's complete eligible candidate set. It is not merely the first match in one domain.
- **One-time scheduled reminder**: An active reminder candidate without `seriesId` or `occurrenceKey`, so the request cannot affect a recurring series or materialized occurrence scope.
- **Private Calendar event**: A candidate with `hasExternalGuests === false` and no recurrence metadata. In the resolver's Calendar model, this represents zero external guests or other attendees relevant to guest notification.
- **Fresh safety check**: The existing domain revalidation performed after resolution and immediately before mutation, including owner/status/revision checks for local state and status/ETag/access/date/future/recurrence checks for Calendar state.
- **Pending action**: An owner-bound, expiring state record used for selection or confirmation. An exact private direct result must not create one; shared, ambiguous, or recurring flows continue to use their existing pending-action shapes.

## Bug Details

### Bug Condition

The resolver correctly returns an exact candidate, but the affected adapters convert that exact result into a confirmation flow. The current scheduled-reminder adapter always creates a `schedule_cleanup` pending action, and the current Calendar adapter always queues a `mutation` confirmation for a model-proposed named deletion. As a result, an owner request such as `delete play among us` can leave one private reminder or one private non-recurring event active even though the target is unambiguous and safe under the named-delete requirements.

**Formal Specification:**

```text
FUNCTION isBugCondition(X)
  INPUT: X containing a validated named-delete action, authenticated owner,
         complete resolver result, target snapshot, and F(X)
  OUTPUT: boolean

  target := the only element of X.resolution.candidates

  RETURN X.action.action = "delete_task"
         AND X.action.scope = "single"
         AND X.resolution.status = "exact"
         AND X.resolution.candidates.count = 1
         AND target.owner = X.authenticatedOwner
         AND target.status = "active"
         AND target is eligible under the existing date/future rules
         AND (
           (
             target.domain = "scheduled_reminder"
             AND target.seriesId is absent
             AND target.occurrenceKey is absent
           )
           OR (
             target.domain = "calendar_event"
             AND target.hasExternalGuests = false
             AND target.recurrence is absent
             AND target.recurringEventId is absent
           )
         )
         AND F(X).requestsConfirmation = true
END FUNCTION

FUNCTION expectedBehavior(result, X)
  INPUT: result produced by F'(X), with target as the sole resolved candidate
  OUTPUT: boolean

  RETURN result.requestsConfirmation = false
         AND result.pendingActionCreated = false
         AND result.mutationTargets = { target }
         AND result.targetMutationOccurs only after existingSafetyChecksPass
         AND (
           (
             target.domain = "scheduled_reminder"
             AND target.status changes from "active" to "cancelled"
             AND target.revision increases by exactly one
           )
           OR (
             target.domain = "calendar_event"
             AND target is deleted
             AND result.sendUpdates = "none"
           )
         )
         AND result.unrelatedTasksRemindersEventsAttendeesAndOverridesUnchanged = true
END FUNCTION
```

The exact local-task path is not normally a current bug condition because it already routes directly. It remains part of the preservation surface and of the complete exact-private behavior contract.

### Examples

1. **Private one-time reminder:** The resolver finds one active reminder titled `Play among us` for the authenticated owner. F creates a review such as `Review: cancel reminder ... Reply confirm ...`; the reminder remains active. F' calls the existing scheduled cleanup mutation, cancels only that reminder with its expected revision, and returns the existing successful cleanup result without a pending action or confirmation identifier.
2. **Private non-recurring Calendar event:** The resolver finds one future event titled `Play among us` with no external guests and a usable ETag. F queues a model-proposed Calendar confirmation. F' performs the existing fresh-read mutation with `sendUpdates: "none"`; the event is deleted and no guest notification is sent.
3. **Shared Calendar event:** The resolver finds one otherwise exact event with an external guest or other attendee. F' does not use the private exception. It creates the existing owner-bound confirmation, leaves the event unchanged, and after valid confirmation and fresh checks deletes only that event with `sendUpdates: "all"`.
4. **Ambiguous cross-domain match:** One local task and one reminder share the selector. The resolver returns `ambiguous`; F' preserves the choose flow, creates a selection pending action, and does not cancel either item before the owner selects one.
5. **Recurring target:** A reminder candidate has a `seriesId`/`occurrenceKey`, or a Calendar candidate has recurrence metadata. F' does not classify it as one-time/private exact. Existing recurring review, recurrence-scope clarification, master-version checks, and series operation rules remain in force.
6. **Concurrent change:** A private Calendar candidate gains an attendee, becomes recurring, changes ETag, becomes read-only/inaccessible, is cancelled, or no longer satisfies the requested date/future rule after resolution. F' must not delete it automatically. It must either use the existing confirmation path when the fresh state is a shared confirmation case or fail closed with the existing safe failure behavior; no write occurs before any required confirmation.
7. **Stale local state:** A reminder or local task revision changes after resolution. The existing repository expected-revision/owner/status guard rejects the mutation, leaves the target active, and returns the existing changed-item failure result.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- `NamedDeleteResolver` continues to read every configured source before declaring an exact result, so a same-title item in another domain still prevents automatic deletion.
- Ambiguous, multiple, cross-domain, or selection-based requests continue to use the existing owner-bound selection pending action and revalidation flow.
- Exact local-task named deletion continues to call `LocalTaskAssistant.handleResolvedNamedCancellation`, which uses the existing owner-scoped expected-revision transition and produces the existing cancellation response.
- Recurring reminders, materialized occurrences, recurring Calendar events, and any request that could affect a series continue to require the existing review or recurrence-scope clarification and master-version checks.
- Shared Calendar events continue to require explicit confirmation. Confirmation remains bound to the authenticated owner and expiry, re-reads the event, checks access/status/ETag/date/future/recurrence state, deletes only the selected event, and sends Calendar updates to guests with `sendUpdates: "all"`.
- Private Calendar deletion uses `sendUpdates: "none"` and never notifies external guests; the private route is allowed only when the fresh target still has no external guests or other attendees and is non-recurring.
- Explicit deterministic task, reminder, Calendar, date-scoped, bulk, and recurring commands retain their established target categories, limits, confirmation policy, response text, and mutation semantics.
- Owner mismatch, cancelled/inactive state, expired action, malformed input, read failure, inaccessible or read-only Calendar, stale revision, changed ETag, invalid date, and failed future-eligibility checks fail closed and disclose no other owner's target.
- Reminder lifecycle, revision increment, delivery-claim exclusion, recurrence materialization, claims, retries, delivery history, local task state, Calendar attendee state, reminder overrides, and unrelated records remain unchanged except for the intended target mutation.

**Scope:**

The only intended behavioral difference is the absence of a confirmation prompt and pending confirmation action for a validated exact private local task, exact one-time scheduled reminder, or exact private non-recurring Calendar event. The local-task portion preserves behavior that already exists; the new behavior is observable for the reminder and Calendar cases. All non-single named deletes, all unsafe or stale cases, all shared/recurring cases, and all unrelated Calendar/task/reminder operations are outside the change.

## Hypothesized Root Cause

1. **Scheduled-reminder adapter unconditionally reviews resolver-captured candidates**: `ScheduleAssistant.handleResolvedNamedReminderCancellation` constructs a `PendingScheduleCleanup` and always replies with a confirmation request. It does not distinguish a one-time reminder from a recurring/materialized occurrence before creating the pending action.
2. **Calendar adapter applies the generic model-proposed deletion policy without a named-delete exception**: `CalendarAssistant.handleResolvedNamedDeletion` evaluates the candidate and, whenever the policy requires confirmation, queues a `PendingMutation`. The generic policy correctly protects ordinary model-proposed Calendar deletes, but the exact private named-delete route has already established a stronger candidate-count and sharing invariant.
3. **The existing mutation functions are not exposed with an exact-private execution intent**: `executeCleanup` and `executeMutation` already contain the repository/API safety checks needed for direct execution, but the adapters currently enter them only after confirmation or through a different command flow.
4. **A naïve confirmation bypass would be unsafe under concurrency**: Passing the ordinary `confirmationAccepted` flag for an exact private route without a fresh private-state gate could delete an event that gained guests or recurrence after resolution. The fix therefore needs a narrow internal execution mode and must re-evaluate the latest event before deciding whether the private exception still applies.
5. **Resolver metadata is already sufficient**: candidate revision, ETag, recurrence identifiers, sharing state, title, date, and owner-scoped source resolution are already captured. Changing title matching, cross-domain resolution, or the global safety policy would expand the risk without addressing the defect.

## Correctness Properties

Property 1: Bug Condition - Exact Private Named Delete Executes Without Confirmation

_For any_ input where `isBugCondition(X)` returns true, the fixed behavior F' SHALL create no confirmation or selection pending action, SHALL invoke exactly the existing mutation path for the sole target, and SHALL mutate that target only after the existing owner, active-status, revision or ETag, access, date/future, and non-recurring/private checks pass. A private Calendar event SHALL be deleted with `sendUpdates: "none"`; a one-time reminder SHALL be cancelled through the existing scheduled cleanup repository operation; and unrelated records SHALL remain unchanged.

**Validates: Requirements 2.2, 2.3, 2.7**

Property 2: Preservation - Non-Buggy Inputs Retain Existing Routing and Outcomes

_For any_ input where `isBugCondition(X)` returns false and the input is outside the intended exact-private reminder/Calendar exception, F' SHALL produce the same pending-action shape, confirmation/selection requirement, mutation target set, notifications, response class, and success or failure outcome as F, preserving ambiguous, recurring, shared, explicit, bulk, malformed, inaccessible, stale, and non-delete behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9**

Property 3: Preservation - Exact Private Local Tasks Continue to Use the Existing Transition

_For any_ validated exact single named delete whose sole candidate is an active owner-scoped local task, F' SHALL route through the existing local-task cancellation adapter, apply the expected-revision owner check, increment the task revision by exactly one on success, leave other state unchanged, and create no confirmation pending action.

**Validates: Requirements 2.1, 2.7, 3.7**

Property 4: Fresh-State Fail-Closed Behavior

_For any_ exact private target whose owner, status, date/future eligibility, revision, ETag, access, writable-calendar state, sharing state, or recurrence state changes after resolution such that an existing safety rule fails, F' SHALL perform no target mutation and SHALL not bypass a confirmation or recurrence clarification required by the fresh state. If the fresh Calendar target is now shared but otherwise valid for a named delete, the system MAY enter the existing confirmation flow, but it SHALL not delete until that confirmation is valid and the target is revalidated again.

**Validates: Requirements 2.4, 2.6, 3.2, 3.3, 3.6**

Property 5: Exact-Target Isolation and Notification Semantics

_For any_ validated exact private local task, one-time reminder, or non-recurring Calendar event, F' SHALL mutate exactly one resolved target, create no confirmation identifier on the direct-success path, and preserve every unrelated task, reminder, Calendar event, attendee, and reminder override. For any shared Calendar target that reaches confirmed deletion, F' SHALL notify guests with `sendUpdates: "all"`; for any private Calendar target that reaches direct deletion, F' SHALL use `sendUpdates: "none"`.

**Validates: Requirements 2.2, 2.3, 2.4, 2.7, 3.2, 3.8**

## Fix Implementation

### Changes Required

The implementation should be the smallest route-local change and should not alter the resolver's candidate set or introduce a second mutation implementation.

1. **Keep exact routing centralized in `NamedDeleteHandler`**
   - Leave `handleNaturalLanguageAction` and `routeExactCandidate` responsible for complete resolution and domain dispatch.
   - Keep ambiguous results in `queueSelection`, including owner binding, expiry, candidate identity, and selected-candidate revalidation.
   - Do not make the handler choose a domain, bypass resolution, or perform a repository/API mutation itself.

2. **Execute exact one-time reminders through the existing cleanup path** (`src/scheduling/schedule-assistant.ts`)
   - In `handleResolvedNamedReminderCancellation`, build the same `PendingScheduleCleanup` shape currently used for review, preserving `cleanupScope` from `selectorDate` and the captured `expectedRevision`/item ID.
   - Treat the candidate as directly executable only when it has neither `seriesId` nor `occurrenceKey`. This is the one-time guard; a recurring/materialized candidate continues to create the existing pending cleanup confirmation.
   - For a directly executable candidate, call the existing private `executeCleanup` method immediately instead of calling `createPendingAction` and replying with `confirm`. This reuses `arePendingScheduledItemsStillFuture` where applicable and `cancelScheduledItems` with owner and expected revision. It also preserves existing audit, lifecycle transition, revision increment, and delivery exclusion behavior.
   - Do not change `prepareCleanup`, bulk cleanup, recurring series cancellation, manual command parsing, or the pending cleanup validator.

3. **Build the existing Calendar mutation and select a narrow exact-private execution intent** (`src/application/calendar-assistant.ts`)
   - In `handleResolvedNamedDeletion`, continue to construct the synthetic event from the resolver candidate and call `evaluateMutationSafety` for the existing recurrence/target checks. Preserve the current confirmation path for shared candidates and the current clarification path for recurring candidates.
   - For an initially private, non-recurring candidate, obtain the current Calendar reference through the existing `getCalendar` access check, construct the same `PendingMutation` fields (`namedDelete`, `namedDeleteDate` or `namedDeleteFutureOnly`, expected ETag, and source), and call `executeMutation` with an internal `exactPrivateNamedDelete` intent rather than creating a pending action. This intent is an execution-mode parameter or equivalent private method state; it is not persisted in the pending-action payload and is not a new mutation API.
   - In `executeMutation`, keep the current fresh `getEvent` read and all existing preconditions. After the latest event is known, permit the no-confirmation exception only if the internal intent is present, the operation is the named single delete, the latest target is still non-recurring, the latest target has no external guests or other attendees, and no recurrence scope is being applied. The existing `evaluateMutationSafety` implementation remains unchanged; the exception is consumed only by this exact-private named route after the fresh target invariant is checked.
   - If the latest event is now shared but otherwise valid, do not write automatically. Reuse `queueConfirmation` with a refreshed mutation whose notification state is `sendUpdates: "all"`, so deletion remains pending until owner confirmation. If it is recurring, inaccessible, read-only, cancelled, ETag-stale, outside the requested date/future range, or otherwise fails a safety check, use the existing fail-closed rejection/clarification behavior.
   - Preserve `executeMutation`'s existing final write target, recurrence handling, precondition failure handling, audit behavior, and reply behavior. The direct private success response must be the existing `Deleted ...` result, not a new response format.

4. **Preserve the local-task path** (`src/tasks/local-task-assistant.ts`)
   - Leave `handleResolvedNamedCancellation` calling `executeTransition` with the resolver's expected revision.
   - Do not route local tasks through scheduling cleanup or Calendar code, and do not add confirmation for this already-correct path.

5. **Keep pending-action and notification contracts explicit**
   - Direct exact-private success creates no pending action, no confirmation identifier, and requires no follow-up message.
   - Ambiguous named deletes retain `named_delete_selection`; recurring/shared reminder cleanup retains `schedule_cleanup`; shared/unsafe Calendar deletion retains `mutation` confirmation where the current flow permits it.
   - Private Calendar writes use `sendUpdates: "none"`; shared confirmed writes use `sendUpdates: "all"`. The notification value must be recalculated from the fresh target when a private candidate changes to shared before execution.

6. **Do not alter global safety policy or resolver semantics**
   - Leave `evaluateMutationSafety` unchanged for ordinary Calendar deletes, attendee changes, recurring operations, and all non-named routes.
   - Leave `NamedDeleteResolver`'s all-source read, normalization, candidate sort, ownership filters, date/future checks, and read-failure behavior unchanged.

### Control Flow

```text
validated delete_task(scope=single)
  -> NamedDeleteHandler builds request
  -> NamedDeleteResolver reads all configured domains
  -> read_failure / unsafe_calendar -> existing safe failure reply
  -> none -> existing no-match reply
  -> ambiguous -> existing owner-bound selection pending action
  -> exact candidate
       -> legacy_task -> existing LocalTaskAssistant transition
       -> scheduled_reminder
            -> seriesId or occurrenceKey present -> existing reviewed cleanup confirmation
            -> neither present -> existing executeCleanup directly
       -> calendar_event
            -> recurring metadata present -> existing recurrence clarification/review behavior
            -> external guests/attendees present -> existing mutation confirmation, then fresh executeMutation
            -> private and non-recurring -> get current calendar, executeMutation with exact-private intent
                 -> fresh target still private/non-recurring and safe -> delete with sendUpdates=none
                 -> fresh target shared -> existing confirmation with sendUpdates=all
                 -> any other failed precondition -> existing fail-closed behavior
```

### State and Concurrency Handling

- Resolution remains a snapshot, not authorization to write. Local tasks and reminders must still be mutated using the resolver-captured expected revision, owner ID, active status, and the existing repository compare-and-transition operation.
- Unscoped reminder deletion retains the existing future-only check. Date-scoped reminder deletion retains the existing date scope and repository revision/status guard.
- Calendar direct execution must re-read the event and current calendar after resolution. It must reject read-only or inaccessible calendars, cancelled events, missing or changed ETags, date/future mismatches, recurrence changes, and any invalid interval according to the existing execution checks.
- A fresh sharing change invalidates the private exception. It must never be silently treated as a private delete. The safe fallback is the existing confirmation payload with refreshed notification state, or an existing rejection/clarification when the target no longer satisfies the operation.
- The mutation operation remains one-target-only. No retry may broaden the candidate set, switch domains, delete a series, or delete an attendee/override as a side effect.

### Error Behavior

- Resolver read failures and unsafe Calendar snapshots continue to stop the operation before any domain adapter is invoked.
- Missing adapters continue to return the existing safe routing failure.
- Reminder repository failures, revision mismatches, elapsed future-only targets, and partial cleanup failures continue to use the existing cleanup audit and response behavior.
- Calendar access, fresh-read, ETag, status, date/future, recurrence, API precondition, and write failures continue to use `executeMutation`'s existing audit and fail-closed replies. No direct path may fall back to deleting without the existing checks.
- A malformed or unsupported action, `today`/`all` scope, explicit/bulk command, planner-unavailable route, or non-delete action continues through its pre-existing handler and cannot acquire this exact-private exception.

### Non-Goals

- No source implementation is included in this design phase.
- No global change to `evaluateMutationSafety` or its ordinary model-proposed deletion policy.
- No new repository mutation method, Calendar API operation, pending-action kind, confirmation syntax, or alternate mutation path.
- No changes to title tokenization, Unicode/punctuation normalization, date parsing, source scan limits, candidate ordering, or cross-domain ambiguity rules.
- No automatic deletion of multiple candidates, recurring series, future occurrences, shared Calendar events, or targets selected by explicit/bulk commands.
- No changes to Calendar creation, movement, attendee management, reminder overrides, listing, access checks outside this route, recurrence materialization, reminder claims/retries/delivery history, or unrelated specs/task statuses.

## Testing Strategy

### Validation Approach

Validation follows the bug-condition methodology:

1. Establish counterexamples against the current behavior for an exact one-time reminder and an exact private non-recurring Calendar event.
2. Add focused fix checks showing direct mutation, no confirmation/pending action, exact target isolation, and correct private notification semantics.
3. Run preservation checks for the existing local-task path, shared/recurring/ambiguous flows, explicit and bulk routes, stale state, and failure conditions.
4. Run type checking and the complete one-shot test suite. Do not use a watcher or start a development server.

Suggested one-shot commands after implementation are `npm test` (already configured as `vitest run`) and `npm run check`. The design phase does not run or modify source tests.

### Exploratory Bug-Condition Checking

**Goal:** Confirm the two reported counterexamples before the fix and ensure the hypothesis is specific enough to test.

**Cases:**

1. Resolve one active owner-scoped one-time reminder and invoke the named-delete handler. The current implementation should create a `schedule_cleanup` pending action and request confirmation instead of cancelling.
2. Resolve one active owner-scoped private non-recurring Calendar event and invoke the named-delete handler. The current implementation should create a `mutation` pending action and request confirmation instead of deleting.
3. Resolve one exact private local task as a control. The existing implementation should already call the local transition directly without a confirmation.
4. Resolve one shared Calendar event and one recurring reminder as safety controls. The current implementation should continue to require review/confirmation or clarification.

The exploratory tests should inspect the pending repository, domain state, and Calendar gateway calls rather than relying only on reply text.

### Fix Checking

**Goal:** Verify the desired behavior for every input satisfying the bug condition.

**Pseudocode:**

```text
FOR ALL X WHERE isBugCondition(X) DO
  result := F'(X)
  ASSERT expectedBehavior(result, X)
  ASSERT no confirmation or selection pending action was created
  ASSERT exactly one domain mutation targets X.target
  ASSERT all unrelated state is unchanged
END FOR
```

**Focused examples:**

- Exact one-time reminder: assert no `confirm` identifier, no pending action, status changes from active to cancelled, revision increments once, and the item is excluded from subsequent active/delivery eligibility.
- Exact private Calendar event: assert no `confirm` identifier, one `deleteEvent` call, `sendUpdates: "none"`, and no mutation of other events or reminder overrides.
- Exact private local task: assert the existing direct transition and revision behavior remain unchanged.
- Direct-path errors: mutate the fake repository/event between resolution and execution and assert no unsafe write occurs.

### Preservation Checking

**Goal:** Verify that all behavior outside the intended exact-private exception is unchanged from F.

**Pseudocode:**

```text
FOR ALL X WHERE NOT isBugCondition(X) DO
  original := F(X)
  fixed := F'(X)
  ASSERT fixed.pendingActionShape = original.pendingActionShape
         for every input outside the intended exact-private exception
  ASSERT fixed.mutationTargets = original.mutationTargets
  ASSERT fixed.owner, revision, ETag, recurrence, guest, delivery,
         notification, and unrelated-state outcomes equal original outcomes
END FOR
```

**Preservation cases:**

1. Cross-domain or same-domain ambiguity still creates an owner-bound selection and does not mutate candidates before selection/revalidation.
2. Shared Calendar event still creates confirmation, remains unchanged before confirmation, rechecks ETag/sharing/access on confirmation, and sends `sendUpdates: "all"` only on successful deletion.
3. Recurring Calendar event/reminder still uses recurrence clarification, reviewed cleanup, master-version checks, or series rules; it never takes the one-time path.
4. Explicit deterministic, date-scoped, bulk, `today`, and `all` commands retain their existing immediate/review policy and target limits.
5. Owner mismatch, stale revision/ETag, read-only Calendar, inaccessible target, cancelled target, invalid date, and elapsed future-only target fail closed with no mutation or disclosure.
6. Selector normalization variants continue to resolve the same candidates and confirmation decision.

### Unit Tests

- Extend `test/named-delete-resolver.test.ts` to assert an exact one-time reminder is executed directly, with no pending action and the expected lifecycle/revision result.
- Add a recurring reminder/materialized occurrence case proving `seriesId` or `occurrenceKey` still produces the existing confirmation.
- Extend the exact Calendar test to cover a private non-recurring event: direct deletion, no pending action, and `sendUpdates: "none"`.
- Retain and strengthen the shared Calendar test: confirmation is required, the event is unchanged before confirmation, and confirmed deletion uses `sendUpdates: "all"`.
- Add fresh-state Calendar tests for changed ETag, newly added guest, newly recurring event, read-only calendar, cancelled event, date mismatch, and no-longer-future event; each must prove no unsafe automatic deletion.
- Keep the exact local-task test as a regression control for direct owner/revision-checked cancellation and no confirmation.
- Test resolver read failure, unsafe Calendar interval, missing adapters, malformed action/date, and ambiguous cross-domain candidates remain fail-closed.

### Property-Based Tests

Use generated fixture combinations over the finite deletion state space (domain, candidate count, owner match, active status, date/future eligibility, revision/ETag freshness, recurrence metadata, sharing state, command scope, and source availability). The project currently exposes Vitest but no property-testing runtime in `package.json`; the test implementation should use the repository's approved property-test approach without adding a production dependency.

- **Property 1 / Fix:** For every generated exact private target in the three supported domains, the direct result creates no confirmation, mutates only the target, and satisfies the domain-specific postcondition. For reminders and local tasks, revision/lifecycle and delivery eligibility are checked; for Calendar, deletion and `sendUpdates: "none"` are checked.
- **Property 2 / Preservation:** For every generated non-buggy input, compare F and F' on pending-action shape, reply class, mutation targets, notification mode, and state deltas. The only permitted difference is the intended no-confirmation success for the exact private reminder/Calendar cases.
- **Property 3 / Safety:** For every generated post-resolution state change that invalidates owner, status, revision, ETag, access, date/future, sharing, or recurrence safety, assert no automatic mutation and either existing safe failure or a newly required existing confirmation.
- **Property 4 / Isolation:** Generate unrelated tasks, reminders, events, attendees, and overrides around the target and assert their observable state is identical before and after a successful exact deletion.
- **Property 5 / Scope:** Generate recurring, ambiguous, cross-domain, explicit, bulk, and unsupported inputs and assert none is routed through the private exact exception.

### Integration Tests

- Exercise the full `NamedDeleteHandler -> NamedDeleteResolver -> ScheduleAssistant` path with one reminder and assert direct cancellation, no pending confirmation, and post-cancellation delivery exclusion.
- Exercise the full `NamedDeleteHandler -> NamedDeleteResolver -> CalendarAssistant` path with one private non-recurring event and assert direct deletion with `sendUpdates: "none"`.
- Exercise the shared Calendar path through confirmation and assert the event remains until confirmation, then deletes with `sendUpdates: "all"`.
- Exercise cross-domain ambiguity and selection, including selected-candidate revalidation, to prove the exact exception cannot delete the first or all candidates.
- Exercise recurrence and state races across resolver and mutation execution to prove the system fails closed or falls back to the existing confirmation/clarification flow.
- Run the existing domain suites and the full one-shot test suite plus TypeScript check; do not start `npm run dev`, `npm run start`, or any watcher.
