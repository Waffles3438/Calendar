# Implementation Plan

## Overview

This plan follows the bug-condition workflow in `design.md`: establish the defect on the unfixed behavior, observe and lock preservation behavior, implement the smallest route-local correction, then rerun both property sets and the full validation suite. Tasks are ordered and must be completed in order; task 3 depends on tasks 1 and 2, and task 4 depends on task 3.

## Task Dependency Graph

- Required sequence: Task 1 (bug-condition exploration) → Task 2 (preservation baseline) → Task 3 (implementation and post-fix verification) → Task 4 (full checkpoint).
- Task 3 depends on Tasks 1 and 2; within Task 3, implementation subtask 3.1 must complete before verification subtasks 3.2 and 3.3.
- Task 4 depends on subtasks 3.1, 3.2, and 3.3.
- Dependency flow: `1 → 2 → 3.1 → (3.2, 3.3) → 4`.

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1"],
      "dependsOn": []
    },
    {
      "wave": 2,
      "tasks": ["2"],
      "dependsOn": ["1"]
    },
    {
      "wave": 3,
      "tasks": ["3.1"],
      "dependsOn": ["1", "2"]
    },
    {
      "wave": 4,
      "tasks": ["3.2", "3.3"],
      "dependsOn": ["3.1"]
    },
    {
      "wave": 5,
      "tasks": ["4"],
      "dependsOn": ["3.2", "3.3"]
    }
  ]
}
```

## Notes

- The exploration property intentionally fails on unfixed code and must pass after the correction; the preservation property must pass both before and after the correction.
- Reuse the same property-based fixtures for post-fix verification, keep all task statuses and requirement mappings unchanged, and run only the one-shot validation commands specified below.
- Keep the implementation route-local and preserve the stated source, configuration, environment, unrelated-spec, and scope constraints.

## Tasks

- [x] 1. Write the bug-condition exploration test
  - **Property 1: Bug Condition** - Exact Private Named Delete Executes Without Confirmation
  - **IMPORTANT**: Write and run this property before changing implementation code. The expected failure on the unfixed behavior is evidence that the bug is reproduced; do not weaken the assertion to make the baseline pass.
  - **Bug condition `C(X)`**: a validated `delete_task` with `scope: "single"`, complete owner-scoped resolution containing exactly one active eligible candidate owned by the authenticated owner, where the candidate is either (a) a one-time scheduled reminder with no `seriesId` or `occurrenceKey`, or (b) a non-recurring Calendar event with no external guests/other attendees, and the current behavior requests confirmation.
  - **Expected behavior `P(F'(X))`**: no confirmation or selection pending action is created; exactly the resolved candidate is sent through its existing mutation path only after the existing safety checks; the reminder changes from active to cancelled with one revision increment, or the private Calendar event is deleted with `sendUpdates: "none"`; unrelated records remain unchanged.
  - Use the existing resolver/handler seams and fakes in `test/named-delete-resolver.test.ts`, with focused adapter assertions in `test/schedule-assistant.test.ts` and `test/calendar-assistant.test.ts` as appropriate.
  - Exercise at least these concrete counterexamples on the unfixed code:
    - one future private one-time reminder currently creates a `schedule_cleanup` pending action and leaves the reminder active;
    - one future private non-recurring Calendar event currently creates a `mutation` confirmation and leaves the event present;
    - retain an exact private local-task control showing its existing direct cancellation;
    - retain shared Calendar and recurring reminder controls showing that they still require confirmation/review or clarification.
  - Use a deterministic generated fixture matrix (domain, date scope, title normalization, and eligible target state) or Vitest `test.each` cases to provide property-style coverage while keeping the two reported counterexamples reproducible. Do not add a property-testing or production dependency; `package.json` currently provides Vitest only.
  - Assert pending-action absence/presence, reply/confirmation identifiers, repository/API calls, target lifecycle state, revision, and unrelated-state snapshots rather than relying only on response text.
  - Run the focused test on the UNFIXED code and record the observed counterexamples in the test/task notes. **EXPECTED OUTCOME**: the bug-condition assertions fail for the reminder and private Calendar cases and the safety controls behave as documented.
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests before implementing the fix
  - **Property 2: Preservation** - Non-Buggy Inputs Retain Existing Routing and Outcomes
  - **IMPORTANT**: Follow observation-first methodology. Run each non-buggy fixture through the unfixed code, record the actual pending-action shape, reply class, mutation calls, notifications, and state deltas, then encode those observations as property-based assertions. These tests must pass before implementation.
  - **Preservation condition `¬C(X)`**: every validated command outside the exact-private one-time-reminder/private-non-recurring-Calendar exception, including exact local tasks, shared or recurring targets, ambiguous/multiple candidates, explicit or bulk commands, malformed/unsupported input, and unsafe or stale state.
  - Generate a finite state-space matrix with candidate domain/count, owner match, active status, date/future eligibility, reminder revision, Calendar ETag/access, sharing, recurrence metadata, command scope, source availability, and selector-normalization variants. Compare the observed unfixed and fixed contract on pending-action shape, confirmation requirement, mutation target set, notifications, response class, and unrelated state.
  - Cover and preserve:
    - complete all-domain reads, cross-domain/same-domain ambiguity, owner-bound selection, selected-candidate revalidation, and no first/all-candidate deletion;
    - exact private local-task cancellation through `LocalTaskAssistant.handleResolvedNamedCancellation`, including owner and expected-revision checks, one revision increment, terminal lifecycle state, no pending action, and unchanged unrelated tasks;
    - shared Calendar deletion requiring owner-bound confirmation, fresh ETag/access/status/date/future checks, and `sendUpdates: "all"` only after valid confirmation;
    - recurring reminders/materialized occurrences and recurring Calendar events retaining review, recurrence-scope clarification, master-version checks, and series rules;
    - explicit deterministic, date-scoped, `today`, `all`, bulk, recurring, malformed, unsupported, planner-fallback, and non-delete routes remaining on their existing handlers;
    - resolver read failures, owner mismatch, cancelled/inactive targets, expired/malformed actions, stale reminder revisions, changed Calendar ETags, inaccessible/read-only calendars, invalid date/future eligibility, and other fail-closed paths producing no unsafe mutation or disclosure;
    - case, punctuation, Unicode-token, generic-word, and optional-date selector normalization resolving the same candidate set and confirmation decision.
  - Place assertions in the existing focused suites: `test/named-delete-resolver.test.ts`, `test/local-task-assistant.test.ts`, `test/schedule-assistant.test.ts`, `test/calendar-assistant.test.ts`, and `test/delete-across-calendar-tasks-reminders-preservation.test.ts` where the end-to-end preservation contract belongs.
  - Use generated fixture builders/loops or `test.each` for property-style coverage; keep the test runtime dependency-free and do not change production behavior to satisfy the baseline.
  - Run the preservation property tests on the UNFIXED code. **EXPECTED OUTCOME**: all preservation assertions pass, while the intentionally excluded bug-condition cases remain covered by task 1.
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 3. Implement the exact-private single named-delete correction
  - **Dependencies:** Tasks 1 and 2 must be complete; use their counterexamples and observed preservation behavior as the implementation oracle.
  - Keep the change route-local. Do not alter `NamedDeleteResolver`, global `evaluateMutationSafety`, pending-action formats, title/date normalization, recurrence materialization, delivery claims, `.config.kiro`, requirements, design, `.env`, or unrelated specs.

  - [x] 3.1 Execute exact one-time scheduled reminders through the existing cleanup mutation
    - Update `src/scheduling/schedule-assistant.ts` in `handleResolvedNamedReminderCancellation` to distinguish a candidate with neither `seriesId` nor `occurrenceKey` from recurring/materialized candidates.
    - For the one-time candidate, build the existing cleanup payload in memory with the resolver-captured item ID, expected revision, and selector-derived cleanup scope, then call the existing `executeCleanup` path directly instead of persisting `schedule_cleanup` or requesting confirmation.
    - Preserve dry-run behavior, future-only/date-scoped eligibility, owner/status/expected-revision guards, existing audit and response behavior, cancellation lifecycle transition, exactly-one revision increment, and exclusion from later delivery claims.
    - Keep recurring/materialized candidates on the existing reviewed cleanup flow and do not broaden the mutation to a series or other matching item.
    - _Bug_Condition: `isBugCondition(X)` for an exact active owner-scoped one-time scheduled reminder whose unfixed result requests confirmation._
    - _Expected_Behavior: `expectedBehavior(result, X)` cancels only the target through `executeCleanup`, creates no pending confirmation, and preserves all reminder invariants._
    - _Preservation: recurring/materialized reminder review, explicit/bulk cleanup, future/date scope, audit, persistence, claims, retries, and delivery behavior remain unchanged._
    - _Requirements: 2.2, 2.6, 2.7, 3.3, 3.4, 3.6, 3.7_

  - [x] 3.2 Execute exact private non-recurring Calendar events with a narrow internal intent
    - Update `src/application/calendar-assistant.ts` so `handleResolvedNamedDeletion` retains complete candidate/safety routing, obtains the writable Calendar through the existing access check, constructs the existing named-delete `PendingMutation` fields, and invokes `executeMutation` with an internal `exactPrivateNamedDelete` execution intent instead of creating a pending action when the resolver snapshot is private and non-recurring.
    - Keep the intent internal and non-persisted; do not change the generic pending mutation schema or ordinary Calendar policy behavior.
    - In `executeMutation`, keep the fresh event read and all existing status, usable-ETag, ETag, access/read-only, requested-date/future, recurrence, and API precondition checks. Permit direct execution only when the fresh event is still non-recurring, has no external guests/other attendees, and no recurrence scope is applied.
    - Delete the private event with `sendUpdates: "none"`, return the existing domain success result, create no confirmation identifier, and mutate no unrelated event, attendee, reminder override, task, or reminder.
    - If the fresh event became shared, refresh the mutation notification state and use the existing confirmation flow with `sendUpdates: "all"`; if it became recurring, stale, cancelled, inaccessible, read-only, outside the requested date/future range, or otherwise unsafe, fail closed or clarify through the existing behavior without writing.
    - Do not weaken `evaluateMutationSafety`, ordinary model-proposed deletion, recurring operations, or shared-event confirmation.
    - _Bug_Condition: `isBugCondition(X)` for an exact active owner-scoped non-recurring Calendar event with no external guests/attendees whose unfixed result requests confirmation._
    - _Expected_Behavior: `expectedBehavior(result, X)` performs one fresh-checked delete with `sendUpdates: "none"` only while the private invariant holds._
    - _Preservation: shared/recurring Calendar confirmation, guest notification, ETag/access/status/date/future checks, and all non-named Calendar operations remain unchanged._
    - _Requirements: 2.3, 2.4, 2.6, 2.7, 3.2, 3.3, 3.6, 3.8_

  - [x] 3.3 Preserve centralized resolution, ambiguity handling, and direct local-task behavior
    - Confirm `src/application/named-delete-handler.ts` and `src/application/named-delete-resolver.ts` still read every configured domain before declaring an exact result, route only the sole candidate, retain owner-bound selection/revalidation for ambiguity, and never select the first candidate or delete multiple candidates.
    - Leave `src/tasks/local-task-assistant.ts` on its existing `handleResolvedNamedCancellation`/expected-revision transition path; do not add confirmation or route local tasks through scheduling or Calendar code.
    - Ensure unsupported, `today`/`all`, explicit, bulk, recurring, planner-fallback, malformed, and non-delete commands cannot acquire the exact-private execution intent.
    - _Bug_Condition: the new exception is reachable only after validated single named-delete resolution and only for the two affected private domains._
    - _Expected_Behavior: exact private local tasks remain direct and exact candidate isolation is maintained across all domains._
    - _Preservation: resolver candidate sets, normalization, source failure handling, selection payloads, and local-task authorization/revision semantics are unchanged._
    - _Requirements: 2.1, 2.5, 3.1, 3.4, 3.5, 3.7, 3.9_

  - [x] 3.4 Verify the bug-condition exploration test now passes
    - **Property 1: Expected Behavior** - Exact Private Named Delete Direct Mutation
    - Re-run the SAME test and generated fixture set from task 1; do not write a replacement test that bypasses the original reproduction.
    - Assert that exact one-time reminders cancel directly with no `schedule_cleanup` pending action or confirmation, and exact private non-recurring Calendar events delete once with `sendUpdates: "none"`; assert local-task control and unrelated-state isolation.
    - Include post-resolution race fixtures for changed reminder revision and changed Calendar sharing/recurrence/ETag/access/date/future state; each must remain fail-closed or enter the existing required confirmation/clarification flow.
    - **EXPECTED OUTCOME**: the former counterexamples now pass the expected behavior assertions, with no unsafe writes.
    - _Requirements: 2.2, 2.3, 2.6, 2.7_

  - [x] 3.5 Verify preservation property tests still pass
    - **Property 2: Preservation** - Existing Non-Buggy Routing and Safety
    - Re-run the SAME property-based tests and generated fixtures from task 2; do not create a second preservation oracle after implementation.
    - Confirm ambiguity/selection, shared Calendar confirmation and `sendUpdates: "all"`, recurring clarification/review, direct local-task cancellation, explicit/bulk routes, normalization, authorization, freshness, access, failure, notification, delivery, and unrelated-state assertions remain green.
    - **EXPECTED OUTCOME**: all preservation tests pass after the fix; the only intentional behavior difference is direct execution for exact private one-time reminders and private non-recurring Calendar events.
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 4. Checkpoint - ensure all tests and checks pass
  - Run the focused one-shot suites (no watcher):
    - `npm test -- test/named-delete-resolver.test.ts test/schedule-assistant.test.ts test/calendar-assistant.test.ts test/local-task-assistant.test.ts test/delete-across-calendar-tasks-reminders-preservation.test.ts`
  - Run the complete one-shot test suite: `npm test`
  - Run the TypeScript check: `npm run check`
  - Run the production build check when implementation changes are complete: `npm run build`
  - Confirm no development server, watcher, or interactive process was started (`npm run dev`, `npm start`, and `npm run test:watch` are out of scope).
  - Confirm the final implementation changes are limited to the affected source/test paths and that `.config.kiro`, `bugfix.md`, `design.md`, `.env`, unrelated specs, and task statuses were not modified.
  - **EXPECTED OUTCOME**: focused tests, all tests, type checking, and build succeed; exact private direct paths are covered, and all preservation/fail-closed behavior remains green.
