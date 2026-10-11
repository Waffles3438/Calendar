# delete-across-calendar-tasks-reminders Bugfix Design

## Overview

This bugfix closes a routing and resolution gap for a supported, single named natural-language request such as `delete play among us` or `cancel the dentist reminder`. The unified planner currently represents the request as `delete_task` with `scope: "single"`, and `OwnerCommandRouter` sends that action directly to `LocalTaskAssistant`. That route can see only legacy `local_tasks`; it cannot see a scheduled reminder in `scheduled_items` or an event in the owner's Google Calendars. The request can therefore report a local no-match while leaving the actual matching item active. A first-match implementation would be unsafe in the opposite direction because the same normalized name may exist in more than one domain.

The fix is deliberately limited to the validated unified action `delete_task` with `scope: "single"` and a title selector. A new named-delete coordinator will read every applicable domain before deciding: fresh owner-scoped writable Google Calendar events, active owner-scoped legacy local tasks, and active owner-scoped scheduled reminders. It will use one canonical request/title normalization and explicit domain-specific date eligibility. It will never infer a target from a partial read. Zero candidates produce no mutation; one candidate is handed to that domain's existing safe cancellation/deletion path using a captured identity and freshness token; multiple candidates produce an owner-bound, expiring selection/review and no mutation until one candidate is explicitly selected and the selected domain's normal confirmation policy is satisfied.

The coordinator is a resolution boundary, not a second mutation implementation. Calendar ETags, recurring-series checks, guest notification decisions, local-task revisions, scheduled-item revisions, pending-action ownership, expiry, audit records, and scheduler delivery behavior remain authoritative in the existing assistants and repositories. The planner still receives no rows, IDs, ETags, credentials, or tools. No database migration or `.env` access is required; the existing `.config.kiro` remains the requirements-first bugfix configuration.

### Current code path traced

1. `OwnerCommandRouter.handle` handles `confirm`, `cancel`, and `choose` instructions before planning. For ordinary owner text it calls the single `NaturalLanguageActionPlanner`, then `dispatchNaturalLanguageAction`.
2. In the current `dispatchNaturalLanguageAction`, `delete_task` is grouped with `list_tasks` and `complete_task` and always calls `LocalTaskAssistant.handleNaturalLanguageAction`. The `scope: "single"` branch calls `handleTransitionCommand`, which uses `findMatchingTasks` and then either directly calls `cancelLocalTask` or creates a legacy task selection.
3. `ScheduleAssistant.handleNaturalLanguageAction` currently accepts `cleanup_schedule`, creates, agenda, and event actions. Its existing `prepareCleanup` already reads materialized scheduled items, legacy local tasks, and writable Calendar events for explicit cleanup commands, but it is not offered a unified single-delete action and its cleanup payload is designed for reviewed sets.
4. `CalendarAssistant.handleNaturalLanguageAction` accepts `delete_calendar_event` separately. Its Calendar candidate lookup is date-based and its mutation path re-reads the event, checks status and ETag, checks the recurring master when needed, evaluates mutation safety, and calls `deleteEvent` or the recurrence operation with guest-aware `sendUpdates`.
5. `OwnerCommandRouter.routePendingAction` currently asks `ScheduleAssistant`, `LocalTaskAssistant`, and `CalendarAssistant` to consume only payloads they recognize. A new cross-domain selection payload must therefore be recognized before those domain-specific handlers and must route the selected snapshot to exactly one existing domain adapter.
6. `src/index.ts` constructs the three assistants and the router. Production wiring will construct the coordinator after those dependencies exist. Tests can inject narrow fakes without Google or Gemini access.

## Glossary

- **Bug_Condition (C)**: A validated unified `delete_task` action with `scope: "single"` and a named selector for which one or more eligible owner-scoped candidates exist, while the current route checks only the legacy local-task domain or otherwise discards candidates from another domain.
- **Property (P)**: Complete resolution over the applicable Calendar, legacy-task, and scheduled-reminder domains, followed by a safe result: no mutation for zero/blocked resolution, exact one-candidate routing for one candidate, and explicit disambiguation for multiple candidates.
- **Preservation**: Every input outside the new unified single-named route keeps its current parser, target scope, response, confirmation, freshness, notification, recurrence, and mutation behavior.
- **F**: The current/unfixed behavior in which `OwnerCommandRouter` dispatches every unified `delete_task` action to `LocalTaskAssistant`.
- **F'**: The fixed behavior after the router invokes the named-delete coordinator for only a validated unified single-named action.
- **Named single delete**: A validated `NaturalLanguageAction` with `action: "delete_task"`, `scope: "single"`, and `selector.title`; it may include one optional local ISO date. It is not an explicit `delete task`, `delete reminder`, or `delete event` command parsed deterministically.
- **Canonical selector terms**: The normalized, non-generic Unicode letter/number terms extracted from the named selector. Matching requires every request term to occur as a complete token in the candidate display title or Calendar summary; matching is case- and punctuation-insensitive but not fuzzy or substring-based.
- **Candidate**: One mutation-capable, owner-visible target snapshot from exactly one domain. It contains a display label for review and the domain identity/freshness token needed by the existing mutation path; it does not expose the identity or ETag to the planner.
- **Eligible candidate**: A candidate that is active, owner-scoped, within the request's date/future rule, and safe to hand to its domain adapter. A Calendar event also needs a current writable calendar and a usable ETag.
- **Fresh Calendar read**: A live `listCalendars` followed by live `listEvents` calls on the authenticated owner's current Calendar gateway. It must not use an agenda result, process-local interpretation cache, local event mirror, or stale candidate snapshot as the resolution read.
- **Resolution snapshot**: The ID plus revision or ETag captured after the complete read. It is an input to the existing revalidation/mutation path, not authorization to bypass that path.
- **Domain adapter**: A narrow exact-target method on the existing local-task, scheduled-reminder, or Calendar assistant. It accepts a previously resolved snapshot and invokes the assistant's existing pending, policy, repository, and audit behavior without re-running a broad title search.
- **Read failure**: Any required repository or Calendar read that throws, returns an unusable matching record, or leaves the resolver unable to establish a complete candidate set. A read failure is not equivalent to zero candidates.

## Bug Details

### Bug Condition

A model-proposed single named deletion is currently treated as a legacy local-task operation. The planner's `delete_task` label describes the user intent but does not identify the storage domain. The router therefore makes a domain decision before inspecting the owner-scoped scheduled reminder and Calendar stores. Existing explicit cleanup and Calendar paths have stronger reads and safety checks, but the generic action cannot reach them.

**Formal Specification:**

```text
FUNCTION isBugCondition(input)
  INPUT: input containing a validated NaturalLanguageAction,
         authenticatedOwner, currentTime, taskTimeZone,
         legacyTasks, scheduledItems, and freshCalendarRead
  OUTPUT: boolean

  IF input.action.action != "delete_task"
     OR input.action.scope != "single"
     OR input.action.selector is absent THEN
    RETURN false
  END IF

  selector := normalizeNamedDeleteSelector(input.action)
  IF selector is invalid OR selector.terms is empty THEN
    RETURN false
  END IF

  legacyMatches := eligibleLegacyTaskCandidates(
    owner = input.authenticatedOwner,
    selector = selector,
    now = input.currentTime,
  )
  reminderMatches := eligibleScheduledReminderCandidates(
    owner = input.authenticatedOwner,
    selector = selector,
    now = input.currentTime,
  )
  calendarMatches := eligibleFreshCalendarEventCandidates(
    owner = input.authenticatedOwner,
    selector = selector,
    calendarRead = input.freshCalendarRead,
    now = input.currentTime,
  )

  RETURN (legacyMatches UNION reminderMatches UNION calendarMatches) is not empty
         AND input.currentDispatch does not resolve all three domains
         AND no matching candidate has been safely cancelled/deleted
END FUNCTION
```

The absence of a complete Calendar read is not a `C(X)` no-match example; it is a separate blocked resolution state that must fail closed. A configured Calendar read failure must never be used to prove that only a local task or reminder exists.

### Candidate normalization and identity

The coordinator receives the title from the validated action, not raw generated prose. At its boundary it must normalize the selector once and pass the normalized terms to all three readers:

1. Apply Unicode compatibility normalization (`NFKC`), collapse whitespace, trim, and lowercase using the existing application locale-independent behavior.
2. Split on every non-letter/non-number Unicode character. Preserve letters and numbers inside a token; punctuation, apostrophes, slashes, and hyphens are separators.
3. Remove only command/record words that the existing named-delete grammar treats as generic: `a`, `an`, `appointment`, `appointments`, `class`, `classes`, `event`, `events`, `meeting`, `meetings`, `my`, `on`, `reminder`, `reminders`, `schedule`, `schedules`, `task`, `tasks`, `the`, and `to`. Date words are removed by date parsing, not used as title terms.
4. De-duplicate terms while retaining deterministic first-seen order. An all-generic selector is invalid and receives clarification/no mutation rather than falling back to an arbitrary whole-title search.
5. Normalize each candidate's display title or Calendar summary with the same tokenization. A candidate matches only if every selector term is present as a complete candidate token. `Play, Among Us` therefore matches `play among us tonight`; `run` does not match `runner`. No stemming, fuzzy distance, broad substring matching, or cross-field matching is introduced.
6. Preserve the original stored title/summary for display and audit. IDs, revisions, ETags, calendar IDs, and OAuth data remain application-only values.

This canonical matcher is used only by the new unified resolver. Existing deterministic task selectors, schedule cleanup terms, and Calendar selectors retain their current matching implementations so explicit-command behavior does not change. Once a candidate is resolved, the exact-target adapter uses its captured identity rather than performing a second title search that could select a different row.

Each candidate has a stable domain key:

- `legacy_task`: `{ domain: "legacy_task", taskId, expectedRevision, title, dueAt, localDate, timeZone }`.
- `scheduled_reminder`: `{ domain: "scheduled_reminder", itemId, expectedRevision, title, scheduledDate, dueAt?, timeZone, seriesId? }`. A generic single delete treats materialized occurrences as individual candidates. It does not infer that a repeated title authorizes cancellation of an entire recurring series; explicit recurring cleanup remains the path for that operation.
- `calendar_event`: `{ domain: "calendar_event", calendarId, eventId, expectedEtag, summary, calendarSummary, start, end, recurringEventId?, hasExternalGuests, recurrenceScope? }`. The candidate records the calendar and event identity returned by the fresh read. It is not reconstructed from a local cache.

### Examples

- **Reported scheduled-reminder counterexample**: At a fixed current time, the owner has one active future scheduled reminder titled `play among us`, created by `can you remind me in 30 min to play among us`. The planner returns `delete_task/single/{title: "play among us"}`. Before the fix, the router checks only `local_tasks`, replies with the legacy no-match message, and leaves the scheduled row active. After the fix, the scheduled reminder is the sole candidate, the existing reviewed scheduled cancellation is prepared, and only a valid confirmation can advance its revision and set it cancelled.
- **Calendar-only counterexample**: The owner has a future writable event titled `play among us` on a writable secondary calendar and no local row. The resolver must list the current calendars and read that calendar's current events before deciding. The old local-only route reports no match; the fixed route captures the event ETag and uses the Calendar deletion confirmation path. No local or scheduled row changes.
- **Same title in two domains**: An active legacy task and an active scheduled reminder both normalize to `call dentist`, or a matching Calendar event exists as well. The resolver returns all candidates after completing every read. It does not prefer Calendar, scheduled reminders, or legacy tasks and does not delete the first result. The owner must select one candidate; the selected domain then applies its own safety policy.
- **Multiple candidates in one domain**: Two active local tasks titled `run outside` and `run inside` both match selector term `run`, or two future reminders match `yoga`. The generic route presents an explicit selection and does not treat ordering as authorization. Existing explicit task/reminder cleanup commands continue to use their current selection/review behavior.
- **Date-scoped match**: A selector resolved to `2026-08-19` matches a legacy task whose due instant falls on that task's stored local date, a scheduled reminder whose stored `scheduledDate` is `2026-08-19`, and a Calendar event that overlaps that civil day in the event calendar's time zone. Current/past records on an explicitly supplied date remain eligible according to the existing date-scoped rules; records on other dates do not match.
- **Unscoped future eligibility**: Without a date, scheduled reminders and Calendar events must start/due strictly after `now`. A legacy task follows the existing single-transition rule and may match while active even if its due instant has passed; this preserves the legacy single-task operation. Explicit bulk cleanup retains its own stricter future-only rules.
- **Owner isolation**: A different owner's row or Calendar account contains the same title. The authenticated owner's repositories and OAuth gateway return no candidate from that data, and the response does not reveal that it exists.
- **Calendar read failure**: `listCalendars` or any required `listEvents` call fails after a local task with the same title was found. The coordinator reports that it could not safely review all matching items, performs no local/task/reminder/Calendar mutation, and does not fall through to the legacy assistant.
- **Freshness race**: A review or selection captures a task revision, reminder revision, or Calendar ETag; another operation changes the target before confirmation/selection. The existing revision/ETag revalidation rejects the stale target and leaves it unchanged. A canceled or already-deleted event is never treated as proof that another candidate should be selected.

## Expected Behavior

### Eligibility and read contract

The coordinator must finish all applicable reads before it decides whether the result is zero, exact, or ambiguous. It must retain the source status for each domain so that `skipped because integration is not configured` is distinguishable from `read failed`.

| Domain | Unscoped single-named eligibility | Supplied-date eligibility | Required snapshot |
|---|---|---|---|
| Legacy local task | `ownerId` matches, `status = active`, and the existing single-task title selector matches. The legacy single transition intentionally does not add a future-time gate. | Active task whose `localTaskDate(dueAt, task.timeZone)` equals the supplied ISO date. | `taskId`, active status, title/date display, `revision` |
| Scheduled reminder | `ownerId` matches, `kind = reminder`, `status = active`, title terms match, and `dueAt > now` (strictly future). Materialize occurrences through the existing cleanup horizon before reading. | Active `kind = reminder` with stored `scheduledDate` equal to the supplied date. Date-scoped matching may include a current or past due instant, as existing date-scoped cleanup does. | `itemId`, active status, title/date display, `revision`, and series metadata if present |
| Google Calendar event | Current writable calendar in the authenticated owner's existing Calendar scope; active event with matching summary, usable ETag, and start strictly after `now`. All-day events use their calendar-local start date. | Active event with matching summary and usable ETag that overlaps the calendar-local day. All-day intervals use inclusive start/exclusive end; timed events use interval intersection. | `calendarId`, `eventId`, calendar display, summary/time display, `etag`, guest flag, recurrence identity, and any required master ETag |

A missing `calendarGateway` means the optional Calendar domain is not configured and is skipped, allowing local tasks and scheduled reminders to continue working without Google. Once a gateway is configured, failure to read the calendar list, failure to read any required writable calendar event range, an invalid matching event, or a matching event without a usable ETag is a blocked resolution, not an empty Calendar domain. The coordinator must not use a partial result to delete a non-Calendar candidate.

For Calendar date ranges, the same resolved ISO civil date is evaluated separately in each Calendar's time zone, using the existing `calendarDayBounds`/overlap semantics. Calendar reads must use the gateway's paginated live `listEvents` behavior (`singleEvents: true` in the Google adapter) and must exclude cancelled events. Read-only calendars are not eligible deletion targets under the current Calendar cleanup rules; they are not silently made writable or mutated.

### Correctness specification

The required behavior for the bug condition and its safety branches is expressed by `P(result)` below. `resolveAllDomains` must complete before any adapter is called.

```text
FUNCTION expectedBehavior(input, result)
  resolution := resolveAllDomains(input.ownerId, input.selector, input.now)

  IF resolution.status = "read_failure" OR resolution.status = "unsafe_calendar" THEN
    ASSERT result.mutated = false
    ASSERT result.pendingAction = none
    ASSERT result.reply is a safe retry/review failure
    ASSERT no non-Calendar candidate was used as a fallback
    RETURN
  END IF

  IF resolution.candidates is empty THEN
    ASSERT result.mutated = false
    ASSERT result.reply is the existing safe no-match/fallback behavior
    RETURN
  END IF

  IF resolution.candidates.length = 1 THEN
    target := resolution.candidates[0]
    ASSERT result.routedDomain = target.domain
    ASSERT result.routedIdentity = target.identity
    ASSERT result.otherDomainsMutated = false
    ASSERT target uses its existing domain confirmation policy

    IF target.domain = "calendar_event" THEN
      ASSERT result.calendarMutation uses a fresh confirmation-time event read
      ASSERT result.calendarMutation requires expectedEtag equality
      ASSERT guest notifications are "all" only when the fresh target has external guests
      ASSERT recurring targets require the existing recurrence scope/master-version checks
    END IF

    IF target.domain = "legacy_task" THEN
      ASSERT cancellation uses target.expectedRevision and ownerId
    END IF

    IF target.domain = "scheduled_reminder" THEN
      ASSERT cancellation uses target.expectedRevision and ownerId
    END IF

    RETURN
  END IF

  ASSERT result.mutated = false
  ASSERT result.pendingAction is owner-bound and expiring
  ASSERT result.pendingAction contains the complete candidate set, not just the first domain
  ASSERT only an explicit selection can continue
  ASSERT a selected candidate is revalidated and routed to exactly one domain
END FUNCTION
```

### Preservation Requirements

**Unchanged behaviors:**

- Existing explicit domain-qualified commands remain on their current paths: `delete task <name>` and `cancel task <name>` use `LocalTaskAssistant`; `delete reminder <name>` and `delete event <name>` use deterministic `ScheduleAssistant` cleanup; Calendar-specific `delete ... <date/title/time>` uses `CalendarAssistant` or the existing deferred Calendar path. These commands do not acquire the new generic cross-domain interpretation.
- Unified `delete_task` actions with `scope: "today"` or `scope: "all"` continue to go directly to `LocalTaskAssistant`, including its date scope, bulk limits, review rules, responses, and revision-checked bulk cancellation. They never invoke the single-named coordinator.
- Existing `cleanup_schedule` actions, `My ... ended`, explicit plural/future cleanup, and `delete all ...` retain their current target categories, five-year/occurrence horizons, future/date eligibility, size limits, mixed-domain review payload, recurring-series behavior, and confirmation behavior. They are not translated into a single-candidate operation.
- Calendar event creation, move, attendee changes, deletion, reminder overrides, recurring scope handling, writable-calendar checks, fresh reads, ETag preconditions, guest disclosure, and `sendUpdates` policy remain in the existing Calendar paths. A generic named delete cannot bypass those rules.
- Legacy local-task creation, listing, completion, direct single cancellation, ambiguity selection, owner filtering, title/date matching, lifecycle retention, response text, and `revision` handling remain unchanged outside the new exact-target adapter.
- Scheduled reminder creation, recurrence materialization, durable delivery claims, retry/at-least-once behavior, completion, cancellation, and delivery history remain unchanged. Cancelling a resolved reminder changes only its existing lifecycle row; it does not delete delivery records or claims. A scheduler claim already accepted before cancellation retains the documented at-least-once race behavior, while later claims fail because the item is no longer active.
- A valid model-proposed local-only exact candidate retains the existing phase-one confirmation policy: the current local one-time single transition may execute directly, while scheduled cleanup and Calendar deletion retain their existing review/confirmation requirements. The coordinator does not impose a new policy on an existing domain.
- Pending actions remain encrypted, owner-bound, single-use, and time-limited. `confirm`, `cancel`, and `choose` from another owner, an expired action, malformed payload, or stale revision/ETag fail closed without target disclosure or mutation.
- If the unified planner is unavailable, returns malformed/unsupported output, or does not establish a supported single-named `delete_task` action, the current deterministic and classifier fallback behavior remains. The fix must not add an untyped broad-delete parser.
- Other Calendar accounts, task owners, scheduled-reminder owners, local task reminder delivery, and unrelated state remain isolated. A same-title record is not changed merely because another domain was selected.

**Scope:**

Inputs outside `C(X)` are unaffected. In particular, the new coordinator is not called for explicit/bulk/deterministic commands, non-delete actions, `complete_task`, Calendar-specific `delete_calendar_event`, `cleanup_schedule`, planner fallback, unsupported untyped text, or any request without a validated single title selector.

## Hypothesized Root Cause

1. **Intent label is mistaken for a storage domain**: The unified action schema calls the operation `delete_task`, but the same natural-language space creates scheduled reminders. `OwnerCommandRouter` currently treats the label as a guarantee that `LocalTaskAssistant` is the only authoritative store.

2. **Resolution stops before complete evidence exists**: `LocalTaskAssistant.findMatchingTasks` returns a result from `local_tasks` without consulting `scheduled_items` or the Calendar gateway. A no-match is therefore incorrectly treated as a global no-match, and a local match would be incorrectly treated as globally unique.

3. **Selector semantics are fragmented**: Legacy tasks, schedule cleanup, and Calendar selectors use different generic words and substring rules. Reusing one private method or re-running a domain search after resolution could lose candidates or select a different record. The fix needs a canonical generic resolver matcher while leaving explicit parsers intact.

4. **Existing safe mutation paths are not composable**: Local task transitions use task revisions, scheduled cleanup uses reviewed payloads and scheduled-item revisions, and Calendar deletes use ETags, recurrence master versions, and guest-aware policy. The current router has no interface for handing an exact candidate snapshot to one of those paths.

5. **Pending action routing is domain-specific**: The router recognizes only payloads owned by ScheduleAssistant, LocalTaskAssistant, or CalendarAssistant. Cross-domain ambiguity cannot safely be represented by any current `choose` payload without either discarding domains or turning a single request into a bulk cleanup.

6. **Calendar safety depends on fresh data**: Calendar contents are intentionally not mirrored locally. The generic path must list current writable calendars/events and preserve the existing confirmation-time re-read; a cached agenda, interpretation, or prior cleanup candidate cannot authorize deletion.

7. **Fallback behavior can become unsafe if errors are conflated with no-match**: A Calendar OAuth/API error must not fall through to a legacy cancellation, because the missing Calendar result may be the only matching or disambiguating candidate. Optional lack of Calendar integration is a skip; a configured read failure is a blocked resolution.

## Correctness Properties

Property 1: Bug Condition - Complete cross-domain resolution and safe exact cancellation

_For any_ input where the bug condition holds (isBugCondition returns true), the fixed single-named delete route SHALL complete owner-scoped candidate reads for fresh eligible Google Calendar events, active legacy local tasks, and active scheduled reminders before deciding; it SHALL produce no mutation for zero or failed resolution, route exactly one candidate only through that candidate domain's existing safe path with the captured ETag or revision, and require explicit disambiguation for multiple candidates without arbitrary or silent bulk deletion.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9**

Property 2: Preservation - Explicit, bulk, deterministic, and existing safety behavior

_For any_ input where the bug condition does NOT hold (isBugCondition returns false), the fixed code SHALL produce the same result as the original code, preserving explicit domain routing, bulk/date/recurring cleanup scope, Calendar ETag/recurrence/guest behavior, task and reminder revision/delivery behavior, owner and pending-action isolation, and planner-unavailable or unsupported fallback behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Narrow interfaces and data flow

Add a small application-level named-delete boundary rather than putting cross-domain reads in `OwnerCommandRouter` or adding direct writes to a parser. The exact names may be adjusted during task implementation, but the contracts below are required.

```text
NamedDeleteRequest {
  ownerId: string
  selectorTitle: string
  selectorDate?: ISODate
  now: Date
  source: "gemini"
}

NamedDeleteCandidate =
  | LegacyTaskCandidate { domain: "legacy_task"; taskId; expectedRevision; ...display }
  | ScheduledReminderCandidate { domain: "scheduled_reminder"; itemId; expectedRevision; ...display }
  | CalendarEventCandidate { domain: "calendar_event"; calendarId; eventId; expectedEtag; ...display }

NamedDeleteResolution =
  | { status: "none" }
  | { status: "exact"; candidate: NamedDeleteCandidate }
  | { status: "ambiguous"; candidates: readonly NamedDeleteCandidate[] }
  | { status: "read_failure" | "unsafe_calendar"; messageKey: string }

NamedDeleteResolver.resolve(input: NamedDeleteRequest): Promise<NamedDeleteResolution>

NamedDeleteHandler.handleNaturalLanguageAction(
  message,
  action: Extract<NaturalLanguageAction, { action: "delete_task" }>,
): Promise<void>

NamedDeleteHandler.canHandlePendingAction(payload: unknown): boolean
NamedDeleteHandler.handlePendingAction(message, instruction): Promise<boolean>
```

The coordinator owns only normalization, complete reads, candidate counting, and pending selection. It does not call `cancelLocalTask`, `cancelScheduledItems`, `deleteEvent`, or any Google API directly. Three exact-target adapter methods are required:

- `LocalTaskAssistant.handleResolvedNamedCancellation(message, candidate)`: use the captured task ID and expected revision, retain the current direct/review policy for a model-proposed single local transition, and call the existing `executeTransition`/audit path. Do not title-search again.
- `ScheduleAssistant.handleResolvedNamedReminderCancellation(message, candidate)`: construct the existing schedule-cleanup pending representation for exactly the captured reminder item, with `legacyItems` and `calendarEvents` empty, `responseSource: "gemini"`, and the captured expected revision. Reuse the current pending-action TTL, owner checks, `executeCleanup`, and `cancelScheduledItems`. If a selected reminder is no longer active or its revision changed, report the existing safe stale-target result. Do not invoke `cancelScheduleSeries` for a generic request merely because `seriesId` is present; explicit recurring cleanup retains that operation.
- `CalendarAssistant.handleResolvedNamedDeletion(message, candidate)`: build the existing `PendingMutation`/safety decision for the captured Calendar target without running the primary-calendar/title search again. Reuse `evaluateMutationSafety`, `queueConfirmation`, `executeMutation`, and the current audit/reply path. A delete always remains guarded under the existing Calendar policy, even for one private non-recurring event.

For a Calendar target, the adapter must re-read the event at confirmation time and verify the calendar still exists and is writable, the event is not cancelled, its ETag equals `expectedEtag`, and the target still satisfies current future/date eligibility. A target with external guests discloses the impact and uses `sendUpdates: "all"`; a target without external guests uses `"none"`. A missing/changed ETag fails closed. A recurring event is never assigned an implicit series scope by this generic task-shaped action: if no recurrence scope was explicitly represented, the adapter asks for the existing recurrence clarification and performs no write. If an existing compatible scope is supplied by a future action adapter, capture and revalidate the recurring master ETag and delegate to the existing `deleteEvent`/`truncateRecurringEvent` path; do not invent a new recurrence mutation.

For multiple candidates, store one new encrypted pending payload, for example `kind: "named_delete_selection"`, containing the complete candidate display list and each candidate's domain identity/freshness snapshot. It must include the authenticated owner through the existing `createPendingAction` owner binding, expire using the existing ten-minute policy, and contain no bulk operation. The coordinator handles `choose <id> <number>` and `cancel <id>` before domain handlers. Choosing a number consumes the pending action once, verifies the selected snapshot still belongs to the owner and is eligible, then calls exactly one domain adapter. The adapter may create a second domain-specific confirmation for scheduled or Calendar deletion. Invalid choices, expiry, owner mismatch, or stale snapshots make no change and do not reveal other candidates.

### Changes required by file/area

1. **`src/application/named-delete-resolver.ts` (new, or equivalent application module)**
   - Define the request, candidate, resolution, and pending-payload types.
   - Implement the pure canonical selector normalizer/matcher and domain-neutral candidate display formatting.
   - Read the three sources completely: materialize scheduled occurrences through the same owner/horizon contract used by `ScheduleAssistant.prepareCleanup`; query only active owner-scoped reminder rows; query active owner-scoped legacy tasks; list the authenticated owner's current writable calendars and fresh event ranges.
   - Track `skipped`, `complete-empty`, `complete-with-candidates`, and `failed` per source. If any configured source fails, return a blocked resolution and do not expose a partial candidate set.
   - Deduplicate only identical Calendar `(calendarId,eventId)` records. Do not deduplicate distinct domains or distinct scheduled occurrences with the same title.
   - Apply the date/future table above and return deterministic candidate ordering for review only; ordering is never authorization.

2. **`src/application/named-delete-handler.ts` (new, or coordinator portion of the resolver)**
   - Implement the unified action entry point and pending selection handling.
   - Accept only `delete_task` with `scope: "single"` and a selector. Normalize `selector.date` and any action-level date once; reject conflicting dates rather than guessing. Do not accept `today`/`all`, IDs, Calendar fields, or bulk target kinds.
   - Call `resolve` before any exact adapter. For `none`, reply with the safe generic no-match result and make no repository/API write. For a read failure, use the existing safe retry/review style and make no fallback write. For `exact`, invoke the adapter for that candidate. For `ambiguous`, persist the selection payload and render only owner-visible title/date/domain/calendar labels.
   - Never expose IDs, ETags, OAuth values, encrypted payloads, or raw provider errors in replies/logs. Keep model attribution on the initial response and any pending confirmation/selection response.

3. **`src/application/owner-command-router.ts`**
   - Add an optional `namedDeleteHandler`/equivalent to the router interfaces and pending-handler order before the domain-specific handlers.
   - In `dispatchNaturalLanguageAction`, invoke it only for `delete_task` with `scope: "single"` and a selector. If it is not wired, retain the current LocalTaskAssistant fallback for compatibility with minimal/test configurations; production wiring must provide it.
   - Leave `scope: "today"` and `scope: "all"`, all other action cases, pending handler order for existing payloads, deterministic routes, and classifier fallback unchanged.

4. **`src/application/calendar-assistant.ts`**
   - Add the narrow exact-target deletion entry point described above, reusing `PendingMutation`, `evaluateMutationSafety`, `handleConfirmation`, and `executeMutation` internals.
   - Keep `findCandidates`, primary-calendar selection, Calendar-specific selectors, recurrence scopes, reminder overrides, and explicit command behavior unchanged.
   - Ensure the exact-target route captures/uses the ETag from the resolver only as the expected version and still performs the latest `getEvent` check before writing.

5. **`src/scheduling/schedule-assistant.ts`**
   - Add the narrow exact scheduled-reminder adapter and, if useful, extract existing scheduled-item freshness helpers without changing their semantics.
   - Reuse `PendingScheduleCleanup`/`executeCleanup` or a narrowly equivalent one-item reviewed path; ensure the payload cannot contain a legacy task or Calendar target for this generic exact reminder route.
   - Keep `prepareCleanup` behavior for `cleanup_schedule`, explicit deterministic cleanup, recurring series, mixed-domain cleanup, caps, and date/future rules unchanged.

6. **`src/tasks/local-task-assistant.ts`**
   - Add the exact-target adapter using the existing `cancelLocalTask` expected-revision transition and audit/reply path. Do not alter `findMatchingTasks`, deterministic selector parsing, or legacy selection behavior.
   - If a shared normalization helper is introduced, use it only in the new resolver; do not replace the legacy selector matcher unless tests prove byte-for-byte preservation for existing commands.

7. **`src/index.ts`**
   - Construct the resolver/handler after the three assistants and the optional Calendar gateway exist, passing the owner ID, configured time zone, repositories, gateway, logger, and existing assistants through narrow interfaces.
   - When Google is not configured, construct the handler with an explicitly skipped Calendar source so local task/reminder deletion remains available. Do not load or inspect `.env` in tests or implementation.

8. **`src/nlp/gemini-action-planner.ts` and action contract tests**
   - Revise only the instruction that currently describes `scope: "single"` as local-only: say that a supported single named private delete/cancel is resolved by the application across eligible local tasks, scheduled reminders, and Calendar events, while explicit Calendar actions use `delete_calendar_event` and bulk scopes remain local-only.
   - Keep the `NaturalLanguageAction` schema, forbidden ID/ETag fields, and model isolation unchanged unless validation needs the narrow conflicting-date check. Do not add model-side domain selection or execution tools.

9. **Persistence and schedulers**
   - Do not add a table or migration. Reuse encrypted `pending_actions` for `named_delete_selection` and existing domain payloads.
   - Do not change `SchedulingRepository`, `AppStateRepository`, `GoogleCalendarApi`, `TrackedCalendarGateway`, `ScheduledReminderScheduler`, or local reminder delivery for routing. Add only regression assertions if needed to prove their current revision/claim/ETag contracts remain intact.

### Fixed data flow

```text
Owner DM: "delete play among us"
  -> unified planner returns delete_task(scope=single, selector={title, optional date})
  -> OwnerCommandRouter invokes NamedDeleteHandler
  -> normalize selector once
  -> read all applicable sources:
       fresh writable Calendar list/events (or explicit Calendar-not-configured skip)
       active owner legacy local tasks
       materialized active owner scheduled reminders
  -> if a configured read fails:
       safe failure reply; no fallback and no mutation
  -> if zero candidates:
       safe no-match reply; no mutation
  -> if one candidate:
       local task -> LocalTaskAssistant exact revision-checked transition
       scheduled reminder -> ScheduleAssistant reviewed exact cancellation
       Calendar event -> CalendarAssistant policy/ETag/recurrence/guest path
  -> if multiple candidates:
       encrypted owner-bound named_delete_selection pending action
       no mutation; reply choose <id> <number> or cancel <id>
       -> selected exact snapshot revalidated
       -> one domain adapter only
       -> scheduled/Calendar adapter may require its normal confirm <id>
       -> confirm re-reads/rechecks and mutates only selected target
```

## Testing Strategy

### Validation approach

Validation follows the bug-condition methodology: first demonstrate the current single-domain counterexample without changing source, then implement the narrow coordinator and verify fix properties, then run preservation checks. Tests use fixed clocks, in-memory SQLite repositories, owner-scoped fakes, and fake Calendar gateways. No test needs an active `.env`, OAuth network access, Gemini provider access, or a development server.

### Exploratory bug-condition checking

**Goal:** Prove that the unfixed router loses a scheduled reminder and a Calendar event because it dispatches only to `LocalTaskAssistant`, while the existing legacy-only behavior remains a valid baseline.

**Test plan:** Add a focused regression suite before implementation, preferably `test/delete-across-calendar-tasks-reminders.test.ts` with the existing `OwnerCommandRouter` and real in-memory `SchedulingRepository`, or extend `test/schedule-assistant-integration.test.ts` if its fakes are reusable. Seed candidates, inject a planner returning the validated action, and run the current route.

**Counterexample cases:**

1. Seed one future scheduled reminder `play among us`; send a planner-proposed `delete_task` single selector; observe the legacy local no-match response, active scheduled row, no pending schedule cleanup, and no Calendar call on unfixed code.
2. Seed one future writable Calendar event `play among us` on a secondary writable calendar and no local row; observe no Calendar read/mutation on unfixed code and the event remains present.
3. Seed both a matching legacy task and scheduled reminder; observe that the current route cannot report the complete candidate set and must not be accepted as a safe result.
4. Seed only one matching legacy task; verify the current direct local cancellation baseline so the fix does not accidentally add confirmation to the existing legacy-only operation.
5. Use `delete_task` with `scope: "today"` and `scope: "all"`, explicit `delete reminder`, explicit `delete event`, and deterministic `delete task`; record that none should enter the new resolver.

**Expected unfixed observations:** The scheduled/Calendar candidate remains active, the local-only path emits its no-match or local result, and no cross-domain pending selection exists. The final regression assertions must be written for the intended fixed behavior, so they are expected to fail on the unfixed implementation rather than being weakened to preserve the defect.

### Fix checking

**Goal:** Verify every branch of `C(X)` and the safety consequences of an exact route.

```text
FOR ALL generated supported single-named inputs WHERE isBugCondition(input) DO
  resolution := fixedResolver.resolve(input)
  ASSERT every configured domain was read before resolution.status is returned
  ASSERT resolution.candidates = eligibleFreshCalendarEvents
                         UNION eligibleLegacyTasks
                         UNION eligibleScheduledReminders

  IF resolution.status is read_failure OR unsafe_calendar THEN
    ASSERT no state or Calendar mutation
  ELSE IF resolution.candidates is empty THEN
    ASSERT no mutation
  ELSE IF resolution.candidates has exactly one target THEN
    ASSERT only target.domain adapter is called
    ASSERT no other domain adapter is called
    ASSERT no mutation before that domain's required confirmation
    confirm/execute using the existing path
    ASSERT selected target is changed only when its ETag/revision/owner checks pass
  ELSE
    ASSERT a selection pending action is stored
    ASSERT no mutation before explicit choose
    choose one candidate
    ASSERT exactly that candidate is revalidated and routed
  END IF
END FOR
```

**Fix cases by concern:**

- **Candidate completeness:** One match in each domain; verify all reads happen even when the first source has a match. Verify candidate count and domain labels include all three.
- **Exactly one:** One legacy task, one scheduled reminder, and one Calendar event in separate tests. Verify the corresponding adapter is called once and unrelated records remain active.
- **Cross-domain ambiguity:** Same normalized title in two or three domains; verify no direct mutation, complete pending display, valid `choose` selects only one, and a scheduled/Calendar selection then follows its own confirmation policy.
- **Within-domain ambiguity:** Multiple local tasks, multiple scheduled reminders, and multiple Calendar events. Verify no ordering-based deletion and no conversion to bulk cancellation.
- **Normalization:** Case changes, punctuation separators, Unicode letters/numbers, generic command words, duplicate terms, token-boundary false positives, and all-generic selectors. Verify the same canonical terms are used for all domains while explicit parsers retain their current semantics.
- **Dates:** Legacy task time zone conversion, scheduled `scheduledDate`, Calendar timed/all-day overlap, date-scoped current/past inclusion, unscoped strict future exclusion, and DST/calendar-time-zone boundaries.
- **Read failures:** Calendar list failure, one Calendar event-range failure after another calendar succeeded, matching event with empty ETag, scheduling repository throw, legacy repository throw, and no configured Calendar gateway. Verify configured failures block all mutation; unconfigured Calendar is skipped.
- **Calendar safety:** Non-guest delete uses `sendUpdates: "none"`; external guests disclose impact and use `"all"`; stale event ETag, cancelled event, read-only calendar, missing event, and precondition failure all fail closed. Recurring candidates without an explicit scope ask for the existing recurrence clarification; explicit recurring Calendar commands still exercise master ETag/truncate behavior.
- **Task/reminder safety:** Stale legacy revision, stale scheduled-item revision, completed/cancelled target, expired/owner-mismatched/cancelled pending action, and scheduler claim after reminder cancellation. Verify no unrelated row changes and no delivery history deletion.
- **Planner isolation:** Planner output containing IDs, ETags, Calendar IDs, or tools remains rejected; planner unavailable or malformed action follows the existing fallback and never invokes the resolver.

### Preservation checking

**Goal:** For every input outside `C(X)`, compare the fixed path with the current behavior captured by the existing suite and do not broaden the generic route.

```text
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT behavior_original(input) = behavior_fixed(input)
END FOR
```

**Preservation cases:**

1. `delete task run`, `cancel task run tomorrow`, `delete reminder dentist`, `delete event planning`, and Calendar-specific date/time deletion retain their current parser, domain, response, immediate/review disposition, and mutation.
2. `delete all tasks`, `delete all tasks for today`, `delete all events`, `delete all reminders`, `delete all tasks/events/reminders`, `My yoga classes ended`, and named/recurring `cleanup_schedule` retain target categories, limits, date/future eligibility, series handling, review payload, and confirmation behavior.
3. Calendar creation, move, attendee changes, reminder overrides, guest notifications, stale ETag rejection, recurring split/truncate, and read failures retain existing tests and API calls.
4. Scheduled reminder creation, relative-time rounding, recurrence materialization, durable claims, delivery retry, completion, and cancellation retain existing tests and state transitions.
5. Legacy task creation, listing, completion, direct single cancellation, multi-match `choose`, bulk cancellation, date filtering, and stale revision behavior retain existing tests and response text.
6. Planner unavailable, invalid/unsupported action, deterministic fallback, clarification context, dry-run mode, owner isolation, and pending action expiry remain fail-closed.

### Unit Tests

- Add a pure normalizer/matcher suite for canonical terms, generic-word removal, punctuation/case/Unicode normalization, token boundaries, duplicate terms, all-generic rejection, and deterministic ordering.
- Add resolver-source unit tests with fake repositories/gateways for owner filtering, active-status filtering, date/future eligibility, scheduled occurrence materialization, Calendar writable-scope filtering, Calendar day overlap, usable ETag requirements, and complete-read failure propagation.
- Add coordinator tests for zero/exact/ambiguous/blocked resolutions, no mutation before decision, complete candidate payloads, candidate display redaction, pending expiry/owner binding, invalid selection, and exact-one adapter routing.
- Add exact-target adapter tests for local task expected revisions, scheduled reminder expected revisions and schedule-only pending payload, Calendar ETag re-read, guest `sendUpdates`, recurrence clarification/master ETag, and no cross-domain side effects.
- Keep `test/natural-language-action.test.ts` focused on the unchanged action schema plus any single-selector conflicting-date validation; keep `test/gemini-action-planner.test.ts` focused on the wording/schema boundary and planner isolation.

### Property-Based Tests

Use the repository's existing Vitest setup and deterministic generators/table-driven property harnesses; do not add an unpinned dependency solely for this feature.

- Generate combinations of candidate domains, normalized title token sets, punctuation/case variants, and optional dates. Assert that every matching candidate is returned, none is dropped because another domain matched, and no arbitrary candidate is selected.
- Generate owner IDs/statuses/revisions/ETags and mutations between review and confirmation. Assert that a target changes only when owner, active status, and exact revision/ETag all match, and that unrelated candidates remain unchanged.
- Generate Calendar event shapes (timed/all-day, time zones, guest/no guest, recurring/non-recurring, date overlap/non-overlap) and assert the eligibility table, guest notification decision, recurrence blocking, and fresh-read failure behavior.
- Generate scope/action variants and assert the resolver is invoked only for `delete_task/single` with a selector; explicit, bulk, date-scoped, recurring, deterministic, and unsupported inputs preserve their original route.
- Generate read outcomes where one or more domains fail. Assert failure is never converted into zero candidates or a fallback mutation, while an explicitly unconfigured optional Calendar source is safely skipped.

### Integration Tests

- Extend `test/unified-router.test.ts` to assert single-delete coordinator dispatch, exact-one domain routing, all-domain read completion, ambiguous pending selection, `choose` routing, bulk bypass, and fallback when the coordinator is not configured.
- Extend or add `test/delete-across-calendar-tasks-reminders.test.ts` using real `SchedulingRepository` plus the existing `FakeState`/`FakeGateway` patterns to cover the reported reminder and Calendar counterexamples, same-title cross-domain ambiguity, date eligibility, configured Calendar read failure, and no mutation before confirmation.
- Extend `test/schedule-assistant-integration.test.ts` for schedule-only exact cancellation, same-title legacy preservation, scheduled revision races, recurrence materialization, and later delivery-claim rejection after cancellation.
- Extend `test/calendar-assistant.test.ts` for exact-target Calendar deletion on a secondary calendar, fresh ETag changes, cancelled/read-only/missing-event behavior, guest notification, and recurring master-version handling. Existing explicit Calendar command tests must continue to pass unchanged.
- Extend `test/local-task-assistant.test.ts` for exact captured-task cancellation and stale revision behavior, while retaining direct deterministic/Gemini single cancellation and existing multi-match selection tests.
- Run the targeted suites first, then `npm test`, `npm run check`, and `npm run build`. These are finite commands (`vitest run` through the repository script); no development server, watcher, interactive process, network provider, or active `.env` is required.
