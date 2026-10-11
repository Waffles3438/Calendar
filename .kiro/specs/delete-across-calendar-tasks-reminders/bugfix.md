# Bugfix Requirements Document

## Introduction

Feature scope/name: `delete-across-calendar-tasks-reminders`.

This bugfix addresses the mismatch in which a single named natural-language request such as `delete play among us` is checked in only one item domain. A reminder created by `can you remind me in 30 min to play among us` may remain active because the later delete/cancel request is treated as a legacy task operation even though the matching item is a scheduled reminder; the same failure can occur when the matching item is a Google Calendar event. The request must instead resolve against the authenticated owner's eligible Google Calendar events, legacy local tasks, and owner-owned scheduled reminders before deciding whether any mutation is safe.

For this document, an eligible Calendar event is one returned by an authoritative fresh read within the authenticated owner's existing Calendar scope and current Calendar eligibility rules. An eligible legacy task or scheduled reminder is an active owner-scoped record selected through its existing repository and matching rules. The bug condition `C(X)` is a supported single named natural-language delete/cancel request for which one or more eligible candidates exist in these domains, but resolution stops after checking only one domain or does not preserve the complete candidate set. The fix property `P(X)` is complete owner-scoped resolution followed by no arbitrary deletion: zero candidates produce no mutation, one candidate uses that domain's existing safe path, and multiple candidates remain explicitly disambiguated or reviewed. Inputs outside `C(X)` retain their existing behavior.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an authenticated owner submits a supported single named natural-language delete or cancel request and an eligible matching event, legacy local task, or scheduled reminder exists outside the first domain checked THEN the system can stop after that single-domain lookup, return a no-match result, and leave the matching item unchanged.

1.2 WHEN the matching item is a Google Calendar event but the named request is dispatched only to a local task or scheduled-reminder path THEN the system does not resolve the event through an authoritative fresh Calendar read or reach the existing Calendar ETag and confirmation protections.

1.3 WHEN a named request matches more than one eligible item within a domain or matches eligible items across domains THEN the current single-domain or first-match behavior does not produce a complete candidate set, so it cannot safely distinguish an exact target from an ambiguous request and may select or report based only on the domain encountered first.

### Expected Behavior (Correct)

2.1 WHEN an authenticated owner submits a supported single named natural-language delete or cancel request THEN the system SHALL resolve the normalized title and any supplied date against all three eligible domains before deciding the result: the owner's eligible Google Calendar events, the owner's active legacy local tasks, and the owner's active scheduled reminders; resolution SHALL NOT stop after the first domain with no match or after the first domain with a match.

2.2 WHEN complete resolution finds zero eligible candidates across Calendar events, legacy local tasks, and scheduled reminders THEN the system SHALL make no mutation and SHALL retain the existing deterministic no-match or fallback behavior, without broadening the request to unrelated records or treating a read failure as proof that no item exists.

2.3 WHEN complete resolution finds exactly one eligible candidate in total THEN the system SHALL target only that candidate and SHALL use the existing safe mutation path for its domain. The system SHALL apply that path's current confirmation requirement, and SHALL make no change to any other event, legacy task, or scheduled reminder merely because its title is similar.

2.4 WHEN complete resolution finds multiple eligible candidates within one domain THEN the system SHALL preserve the existing ambiguity, review, or selection behavior for that domain, SHALL not choose a candidate arbitrarily, and SHALL make no mutation until the required owner confirmation or explicit selection is completed and still valid.

2.5 WHEN complete resolution finds eligible candidates in more than one domain THEN the system SHALL treat the request as ambiguous rather than giving precedence to Calendar events, legacy tasks, or scheduled reminders. It SHALL identify the safely visible candidates through the existing review or disambiguation behavior and SHALL mutate only the exact candidate or candidate set explicitly selected and authorized under the existing policy; a single named request SHALL NOT silently become a bulk deletion.

2.6 WHEN an eligible Calendar event is considered as a candidate THEN the system SHALL match it only from an authoritative fresh Calendar read for the authenticated owner's eligible calendars, never from stale cached or local data. If the event is authorized for deletion, the system SHALL use the existing Calendar mutation and confirmation policy, including the latest event ETag (and any existing recurring-series version check), access and writable-calendar checks, and the current guest-impact/send-update behavior; a missing, changed, cancelled, or otherwise unsafe event SHALL not be deleted.

2.7 WHEN an eligible scheduled reminder is considered as a candidate THEN the system SHALL use the existing scheduled-reminder repository and cancellation safety path, including owner scope, active/future or date eligibility, selector matching, required confirmation, pending-action ownership and expiry, and revision checks; it SHALL change no Calendar event or legacy local task as a side effect.

2.8 WHEN an eligible legacy local task is considered as a candidate THEN the system SHALL use the existing legacy-task repository and cancellation safety path, including owner scope, active/date eligibility, selector matching, required confirmation, pending-action ownership and expiry, and revision checks; it SHALL change no Calendar event or scheduled reminder as a side effect.

2.9 WHEN a required authoritative Calendar read cannot complete or returns unusable event data THEN the system SHALL follow the existing Calendar error or fallback behavior, SHALL not substitute stale or non-Calendar data for the read, and SHALL not delete the event without the existing fresh-read and ETag protections.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an owner submits an existing explicit domain-qualified command, such as an explicit task, reminder, or event deletion/cancellation request THEN the system SHALL CONTINUE TO use its current domain routing, selector scope, confirmation behavior, and mutation policy rather than applying the new generic cross-domain resolution.

3.2 WHEN an owner submits an existing bulk, date-scoped, recurring, or otherwise explicitly scoped cleanup command THEN the system SHALL CONTINUE TO use its current target categories, limits, confirmation requirements, responses, and mutation behavior; the single named request SHALL NOT redefine or broaden those commands.

3.3 WHEN a Calendar event is created, changed, moved, cancelled, or deleted, or when a Calendar reminder override is handled THEN the system SHALL CONTINUE TO respect the existing Calendar routing boundaries, authoritative-read requirements, ETag checks, recurrence rules, access and writable-calendar checks, guest-impact decisions, and notification/send-update policy.

3.4 WHEN a scheduled reminder is created, persisted, scheduled, delivered, retried, cancelled, or otherwise processed THEN the system SHALL CONTINUE TO use its existing owner scope, timing, delivery, durable-claim, and cancellation behavior; resolving a generic delete/cancel request SHALL NOT alter reminder delivery behavior.

3.5 WHEN a legacy local task is created, listed, completed, cancelled, or otherwise processed outside the new cross-domain resolution THEN the system SHALL CONTINUE TO use its existing repository, owner filtering, title/date matching, response, revision, and mutation behavior.

3.6 WHEN a request involves another owner's event, task, or scheduled reminder, or when confirmation is cancelled, expires, belongs to another owner, or carries a stale ETag or revision THEN the system SHALL CONTINUE TO isolate owner data, avoid revealing another owner's matching item, and fail closed without mutating the target.

3.7 WHEN the natural-language planner is unavailable, returns an invalid or unsupported action, cannot establish a supported single named request, or the request uses an existing deterministic fallback path THEN the system SHALL CONTINUE TO use the current deterministic fallback, unsupported-request response, and safety behavior without silently converting the request into a broader cross-domain deletion.
