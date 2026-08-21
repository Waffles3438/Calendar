import { createHash, randomUUID } from "node:crypto";

import { DateTime } from "luxon";

import { SecretBox } from "../persistence/secret-box.js";
import { SqliteStore } from "../persistence/database.js";
import { validateLocalTaskDateTime } from "../tasks/task-time.js";
import { expandScheduleDates } from "./recurrence.js";
import {
  MAX_BULK_SCHEDULE_CANCELLATIONS,
  type CreateScheduledItemInput,
  type CreateScheduleSeriesInput,
  type ScheduleKind,
  type ScheduleRecurrence,
  type ScheduledItem,
  type ScheduledItemCancellationTarget,
  type ScheduledItemTransitionInput,
  type ScheduleSeries,
} from "./schedule-domain.js";

export interface SchedulingRepositoryOptions {
  readonly databasePath: string;
  readonly encryptionSecret: string;
}

export interface ScheduledItemRangeQuery {
  readonly kinds?: readonly ScheduleKind[];
  readonly ownerId: string;
  readonly scheduledDateEarliest: string;
  readonly scheduledDateLatest: string;
}

export interface DueScheduledReminderQuery {
  readonly dueAtEarliest: Date;
  readonly dueAtLatest: Date;
  readonly ownerId: string;
}

export interface ScheduledReminderClaimInput {
  readonly claimToken: string;
  readonly itemId: string;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
  readonly ownerId: string;
  readonly scheduledFor: Date;
}

export interface ScheduleInterpretationCacheInput {
  readonly command: unknown;
  readonly expiresAt: Date;
  readonly input: string;
  readonly now: Date;
  readonly ownerId: string;
  readonly source: "gemini" | "manual";
}

export interface ScheduleInterpretationCacheEntry {
  readonly command: unknown;
  readonly source: "gemini" | "manual";
}

interface ScheduledItemRow {
  readonly cancelled_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly due_at: string | null;
  readonly encrypted_title: string;
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly occurrence_key: string | null;
  readonly owner_id: string;
  readonly revision: number;
  readonly scheduled_date: string;
  readonly series_id: string | null;
  readonly status: "active" | "cancelled" | "completed";
  readonly time_zone: string;
  readonly updated_at: string;
}

interface ScheduleSeriesRow {
  readonly cancelled_at: string | null;
  readonly created_at: string;
  readonly encrypted_title: string;
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly owner_id: string;
  readonly recurrence_json: string;
  readonly start_date: string;
  readonly start_time: string | null;
  readonly status: "active" | "cancelled";
  readonly time_zone: string;
  readonly updated_at: string;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error(`${name} must be a valid Date`);
  }
}

function assertDateOnly(value: string, timeZone: string, name: string): void {
  const parsed = DateTime.fromFormat(value, "yyyy-LL-dd", { zone: timeZone });
  if (!parsed.isValid || parsed.toFormat("yyyy-LL-dd") !== value) {
    throw new Error(`${name} must be a valid local ISO date`);
  }
}

function assertTime(value: string, name: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new Error(`${name} must be HH:mm`);
  }
}

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/gu, " ").trim();
  assertNonEmpty(title, "title");
  if (title.length > 160) {
    throw new Error("title must be 160 characters or fewer");
  }
  return title;
}

function validRecurrence(value: unknown): value is ScheduleRecurrence {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ScheduleRecurrence>;
  const interval = candidate.interval;
  if ((candidate.frequency !== "daily" && candidate.frequency !== "weekly" &&
    candidate.frequency !== "monthly" && candidate.frequency !== "yearly") ||
    !Number.isInteger(interval) || interval === undefined || interval < 1 || interval > 366) {
    return false;
  }
  if (candidate.weekdays !== undefined &&
    (!Array.isArray(candidate.weekdays) || candidate.weekdays.length === 0 ||
      candidate.weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7))) {
    return false;
  }
  return true;
}

function dateFromStored(value: string | null, name: string): Date | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Stored ${name} is invalid`);
  }
  return parsed;
}

function inputHash(input: string): string {
  return createHash("sha256")
    .update(input.replace(/\s+/gu, " ").trim().toLocaleLowerCase(), "utf8")
    .digest("base64url");
}

class ScheduledItemBulkCancellationConflict extends Error { }

/**
 * Persistence for new date-only tasks, local reminders, recurrence materialization,
 * daily agenda delivery claims, and private interpretation cache entries. It uses a
 * separate SQLite connection so legacy local-task APIs remain fully compatible.
 */
export class SchedulingRepository {
  private readonly secretBox: SecretBox;
  private readonly store: SqliteStore;

  public constructor(options: SchedulingRepositoryOptions) {
    this.secretBox = new SecretBox(options.encryptionSecret);
    this.store = new SqliteStore(options.databasePath);
  }

  public close(): void {
    this.store.close();
  }

  public createScheduledItem(input: CreateScheduledItemInput): ScheduledItem {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.ownerId, "ownerId");
    assertDateOnly(input.scheduledDate, input.timeZone, "scheduledDate");
    assertValidDate(input.now, "now");
    const title = normalizeTitle(input.title);
    if (input.kind !== "task" && input.kind !== "reminder") {
      throw new Error("kind must be task or reminder");
    }
    if (input.kind === "task" && input.dueAt) {
      throw new Error("all-day tasks cannot have dueAt");
    }
    if (input.kind === "reminder" && !input.dueAt) {
      throw new Error("reminders require dueAt");
    }
    if (input.dueAt) {
      assertValidDate(input.dueAt, "dueAt");
    }

    const timestamp = input.now.toISOString();
    this.store.connection.prepare(
      `
        INSERT INTO scheduled_items (
          id, owner_id, series_id, occurrence_key, kind, encrypted_title,
          scheduled_date, due_at, time_zone, status, created_at, updated_at,
          completed_at, cancelled_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1)
      `,
    ).run(
      input.id,
      input.ownerId,
      input.seriesId ?? null,
      input.occurrenceKey ?? null,
      input.kind,
      this.secretBox.encrypt(title),
      input.scheduledDate,
      input.dueAt?.toISOString() ?? null,
      input.timeZone,
      timestamp,
      timestamp,
    );
    const created = this.getScheduledItem({ id: input.id, ownerId: input.ownerId });
    if (!created) {
      throw new Error("Created scheduled item could not be read");
    }
    return created;
  }

  public createScheduleSeries(input: CreateScheduleSeriesInput, materializeThroughDate: string): ScheduleSeries {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.ownerId, "ownerId");
    assertDateOnly(input.startDate, input.timeZone, "startDate");
    assertDateOnly(materializeThroughDate, input.timeZone, "materializeThroughDate");
    assertValidDate(input.now, "now");
    const title = normalizeTitle(input.title);
    if (!validRecurrence(input.recurrence)) {
      throw new Error("recurrence is invalid");
    }
    if (input.kind === "reminder") {
      if (!input.startTime) {
        throw new Error("reminder series requires startTime");
      }
      assertTime(input.startTime, "startTime");
      if (validateLocalTaskDateTime(input.startDate, input.startTime, input.timeZone).kind !== "valid") {
        throw new Error("series start time is invalid in the configured time zone");
      }
    } else if (input.startTime) {
      throw new Error("all-day task series cannot have startTime");
    }

    const timestamp = input.now.toISOString();
    this.store.connection.transaction(() => {
      this.store.connection.prepare(
        `
          INSERT INTO schedule_series (
            id, owner_id, kind, encrypted_title, start_date, start_time,
            time_zone, recurrence_json, status, created_at, updated_at, cancelled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
        `,
      ).run(
        input.id,
        input.ownerId,
        input.kind,
        this.secretBox.encrypt(title),
        input.startDate,
        input.startTime ?? null,
        input.timeZone,
        JSON.stringify(input.recurrence),
        timestamp,
        timestamp,
      );
      this.materializeSeries(input.id, materializeThroughDate, input.now);
    })();

    const series = this.getScheduleSeries({ id: input.id, ownerId: input.ownerId });
    if (!series) {
      throw new Error("Created schedule series could not be read");
    }
    return series;
  }

  public ensureOccurrencesThrough(input: { now: Date; ownerId: string; throughDate: string }): void {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.now, "now");
    const rows = this.store.connection.prepare(
      `SELECT id FROM schedule_series WHERE owner_id = ? AND status = 'active'`,
    ).all(input.ownerId) as readonly { id: string }[];
    const materialize = this.store.connection.transaction(() => {
      for (const row of rows) {
        this.materializeSeries(row.id, input.throughDate, input.now);
      }
    });
    materialize();
  }

  public getScheduledItem(input: { id: string; ownerId: string }): ScheduledItem | undefined {
    const row = this.store.connection.prepare(
      `
        SELECT id, owner_id, series_id, occurrence_key, kind, encrypted_title,
               scheduled_date, due_at, time_zone, status, created_at, updated_at,
               completed_at, cancelled_at, revision
        FROM scheduled_items WHERE id = ? AND owner_id = ?
      `,
    ).get(input.id, input.ownerId) as ScheduledItemRow | undefined;
    return row ? this.toScheduledItem(row) : undefined;
  }

  public listActiveScheduledItems(input: ScheduledItemRangeQuery): readonly ScheduledItem[] {
    assertNonEmpty(input.ownerId, "ownerId");
    const kinds = input.kinds && input.kinds.length > 0 ? [...new Set(input.kinds)] : undefined;
    const kindSql = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.store.connection.prepare(
      `
        SELECT id, owner_id, series_id, occurrence_key, kind, encrypted_title,
               scheduled_date, due_at, time_zone, status, created_at, updated_at,
               completed_at, cancelled_at, revision
        FROM scheduled_items
        WHERE owner_id = ? AND status = 'active' AND scheduled_date >= ? AND scheduled_date <= ?${kindSql}
        ORDER BY scheduled_date ASC, CASE kind WHEN 'task' THEN 0 ELSE 1 END ASC, due_at ASC, id ASC
      `,
    ).all(input.ownerId, input.scheduledDateEarliest, input.scheduledDateLatest, ...(kinds ?? [])) as ScheduledItemRow[];
    return rows.map((row) => this.toScheduledItem(row));
  }

  public listActiveScheduledItemsByTitle(input: {
    nowDate: string;
    ownerId: string;
    terms: readonly string[];
  }): readonly ScheduledItem[] {
    const items = this.listActiveScheduledItems({
      ownerId: input.ownerId,
      scheduledDateEarliest: input.nowDate,
      scheduledDateLatest: "9999-12-31",
    });
    const terms = input.terms.map((term) => term.toLocaleLowerCase()).filter(Boolean);
    return items.filter((item) => terms.every((term) => item.title.toLocaleLowerCase().includes(term)));
  }

  public listDueScheduledReminders(input: DueScheduledReminderQuery): readonly ScheduledItem[] {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.dueAtEarliest, "dueAtEarliest");
    assertValidDate(input.dueAtLatest, "dueAtLatest");
    const rows = this.store.connection.prepare(
      `
        SELECT id, owner_id, series_id, occurrence_key, kind, encrypted_title,
               scheduled_date, due_at, time_zone, status, created_at, updated_at,
               completed_at, cancelled_at, revision
        FROM scheduled_items
        WHERE owner_id = ? AND kind = 'reminder' AND status = 'active'
          AND due_at >= ? AND due_at <= ?
        ORDER BY due_at ASC, id ASC
      `,
    ).all(input.ownerId, input.dueAtEarliest.toISOString(), input.dueAtLatest.toISOString()) as ScheduledItemRow[];
    return rows.map((row) => this.toScheduledItem(row));
  }

  public completeScheduledItem(input: ScheduledItemTransitionInput): ScheduledItem | undefined {
    return this.transitionScheduledItem(input, "completed");
  }

  public cancelScheduledItem(input: ScheduledItemTransitionInput): ScheduledItem | undefined {
    return this.transitionScheduledItem(input, "cancelled");
  }

  public cancelScheduledItems(input: {
    now: Date;
    ownerId: string;
    targets: readonly ScheduledItemCancellationTarget[];
  }): readonly ScheduledItem[] | undefined {
    if (input.targets.length === 0 || input.targets.length > MAX_BULK_SCHEDULE_CANCELLATIONS) {
      throw new Error(`targets must contain between 1 and ${MAX_BULK_SCHEDULE_CANCELLATIONS} entries`);
    }
    assertValidDate(input.now, "now");
    const timestamp = input.now.toISOString();
    const cancel = this.store.connection.transaction((): readonly ScheduledItem[] => {
      const update = this.store.connection.prepare(
        `UPDATE scheduled_items SET status = 'cancelled', updated_at = ?, cancelled_at = ?, revision = revision + 1
         WHERE id = ? AND owner_id = ? AND status = 'active' AND revision = ?`,
      );
      const cancelled: ScheduledItem[] = [];
      for (const target of input.targets) {
        if (update.run(timestamp, timestamp, target.id, input.ownerId, target.expectedRevision).changes !== 1) {
          throw new ScheduledItemBulkCancellationConflict();
        }
        const item = this.getScheduledItem({ id: target.id, ownerId: input.ownerId });
        if (!item) {
          throw new ScheduledItemBulkCancellationConflict();
        }
        cancelled.push(item);
      }
      return cancelled;
    });
    try {
      return cancel();
    } catch (error: unknown) {
      if (error instanceof ScheduledItemBulkCancellationConflict) {
        return undefined;
      }
      throw error;
    }
  }

  public cancelScheduleSeries(input: {
    anchor: ScheduledItemCancellationTarget;
    fromDate: string;
    now: Date;
    ownerId: string;
    seriesId: string;
  }): number {
    const anchor = input.anchor;
    if (!anchor || typeof anchor.id !== "string" || !anchor.id.trim()) {
      throw new Error("anchor.id must not be empty");
    }
    if (!Number.isInteger(anchor.expectedRevision) || anchor.expectedRevision < 1) {
      throw new Error("anchor.expectedRevision must be a positive integer");
    }
    assertNonEmpty(input.seriesId, "seriesId");
    assertDateOnly(input.fromDate, "UTC", "fromDate");
    assertValidDate(input.now, "now");
    const timestamp = input.now.toISOString();
    const cancel = this.store.connection.transaction(() => {
      const series = this.store.connection.prepare(
        `UPDATE schedule_series SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM scheduled_items
             WHERE id = ? AND owner_id = ? AND series_id = ? AND status = 'active'
               AND revision = ? AND scheduled_date = ?
           )`,
      ).run(
        timestamp,
        timestamp,
        input.seriesId,
        input.ownerId,
        anchor.id,
        input.ownerId,
        input.seriesId,
        anchor.expectedRevision,
        input.fromDate,
      );
      if (series.changes !== 1) {
        return 0;
      }
      return this.store.connection.prepare(
        `UPDATE scheduled_items SET status = 'cancelled', cancelled_at = ?, updated_at = ?, revision = revision + 1
         WHERE series_id = ? AND owner_id = ? AND status = 'active' AND scheduled_date >= ?`,
      ).run(timestamp, timestamp, input.seriesId, input.ownerId, input.fromDate).changes;
    });
    return Number(cancel());
  }

  public getScheduleSeries(input: { id: string; ownerId: string }): ScheduleSeries | undefined {
    const row = this.store.connection.prepare(
      `SELECT id, owner_id, kind, encrypted_title, start_date, start_time, time_zone,
              recurrence_json, status, created_at, updated_at, cancelled_at
       FROM schedule_series WHERE id = ? AND owner_id = ?`,
    ).get(input.id, input.ownerId) as ScheduleSeriesRow | undefined;
    return row ? this.toScheduleSeries(row) : undefined;
  }

  public tryClaimScheduledReminderDelivery(input: ScheduledReminderClaimInput): boolean {
    assertValidDate(input.now, "now");
    assertValidDate(input.leaseExpiresAt, "leaseExpiresAt");
    assertValidDate(input.scheduledFor, "scheduledFor");
    const run = this.store.connection.transaction((): boolean => {
      const scheduledFor = input.scheduledFor.toISOString();
      this.store.connection.prepare(
        `DELETE FROM scheduled_item_reminder_claims WHERE item_id = ? AND scheduled_for = ? AND lease_expires_at <= ?`,
      ).run(input.itemId, scheduledFor, input.now.toISOString());
      const active = this.store.connection.prepare(
        `SELECT 1 AS present FROM scheduled_items WHERE id = ? AND owner_id = ? AND kind = 'reminder' AND status = 'active'`,
      ).get(input.itemId, input.ownerId) as { present: number } | undefined;
      if (!active) {
        return false;
      }
      const delivered = this.store.connection.prepare(
        `SELECT 1 AS present FROM scheduled_item_reminder_deliveries WHERE item_id = ? AND scheduled_for = ?`,
      ).get(input.itemId, scheduledFor) as { present: number } | undefined;
      if (delivered) {
        return false;
      }
      return this.store.connection.prepare(
        `INSERT OR IGNORE INTO scheduled_item_reminder_claims
         (item_id, scheduled_for, claim_token, claimed_at, lease_expires_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(input.itemId, scheduledFor, input.claimToken, input.now.toISOString(), input.leaseExpiresAt.toISOString()).changes === 1;
    });
    return run();
  }

  public completeScheduledReminderDelivery(input: {
    claimToken: string;
    itemId: string;
    scheduledFor: Date;
    sentAt: Date;
  }): boolean {
    const complete = this.store.connection.transaction((): boolean => {
      const scheduledFor = input.scheduledFor.toISOString();
      const claim = this.store.connection.prepare(
        `SELECT 1 AS present FROM scheduled_item_reminder_claims WHERE item_id = ? AND scheduled_for = ? AND claim_token = ?`,
      ).get(input.itemId, scheduledFor, input.claimToken) as { present: number } | undefined;
      if (!claim) {
        return false;
      }
      const recorded = this.store.connection.prepare(
        `INSERT OR IGNORE INTO scheduled_item_reminder_deliveries (item_id, scheduled_for, sent_at) VALUES (?, ?, ?)`,
      ).run(input.itemId, scheduledFor, input.sentAt.toISOString());
      this.store.connection.prepare(
        `DELETE FROM scheduled_item_reminder_claims WHERE item_id = ? AND scheduled_for = ? AND claim_token = ?`,
      ).run(input.itemId, scheduledFor, input.claimToken);
      return recorded.changes === 1;
    });
    return complete();
  }

  public releaseScheduledReminderClaim(input: { claimToken: string; itemId: string; scheduledFor: Date }): void {
    this.store.connection.prepare(
      `DELETE FROM scheduled_item_reminder_claims WHERE item_id = ? AND scheduled_for = ? AND claim_token = ?`,
    ).run(input.itemId, input.scheduledFor.toISOString(), input.claimToken);
  }

  public tryClaimDailyAgenda(input: {
    claimToken: string;
    leaseExpiresAt: Date;
    localDate: string;
    now: Date;
    ownerId: string;
  }): boolean {
    const claim = this.store.connection.transaction((): boolean => {
      this.store.connection.prepare(
        `DELETE FROM daily_agenda_deliveries WHERE owner_id = ? AND local_date = ? AND sent_at IS NULL AND lease_expires_at <= ?`,
      ).run(input.ownerId, input.localDate, input.now.toISOString());
      const sent = this.store.connection.prepare(
        `SELECT sent_at FROM daily_agenda_deliveries WHERE owner_id = ? AND local_date = ?`,
      ).get(input.ownerId, input.localDate) as { sent_at: string | null } | undefined;
      if (sent) {
        return false;
      }
      return this.store.connection.prepare(
        `INSERT OR IGNORE INTO daily_agenda_deliveries
         (owner_id, local_date, claim_token, claimed_at, lease_expires_at, sent_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(input.ownerId, input.localDate, input.claimToken, input.now.toISOString(), input.leaseExpiresAt.toISOString()).changes === 1;
    });
    return claim();
  }

  public completeDailyAgenda(input: { claimToken: string; localDate: string; ownerId: string; sentAt: Date }): boolean {
    return this.store.connection.prepare(
      `UPDATE daily_agenda_deliveries SET sent_at = ? WHERE owner_id = ? AND local_date = ? AND claim_token = ? AND sent_at IS NULL`,
    ).run(input.sentAt.toISOString(), input.ownerId, input.localDate, input.claimToken).changes === 1;
  }

  public releaseDailyAgendaClaim(input: { claimToken: string; localDate: string; ownerId: string }): void {
    this.store.connection.prepare(
      `DELETE FROM daily_agenda_deliveries WHERE owner_id = ? AND local_date = ? AND claim_token = ? AND sent_at IS NULL`,
    ).run(input.ownerId, input.localDate, input.claimToken);
  }

  /** Stores one encrypted, owner-bound correction context across process restarts. */
  public putPendingManualCorrection(input: { expiresAt: Date; input: string; now: Date; ownerId: string }): void {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.input, "input");
    assertValidDate(input.expiresAt, "expiresAt");
    assertValidDate(input.now, "now");
    if (input.expiresAt <= input.now) {
      throw new Error("expiresAt must be after now");
    }
    this.store.connection.prepare(
      `INSERT INTO pending_schedule_corrections (owner_id, encrypted_input, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET encrypted_input = excluded.encrypted_input,
         expires_at = excluded.expires_at, created_at = excluded.created_at`,
    ).run(
      input.ownerId,
      this.secretBox.encrypt(input.input),
      input.expiresAt.toISOString(),
      input.now.toISOString(),
    );
  }

  /** Consumes the current owner's correction context only after a valid manual write succeeds. */
  public consumePendingManualCorrection(input: { now: Date; ownerId: string }): string | undefined {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.now, "now");
    const consume = this.store.connection.transaction((): string | undefined => {
      const row = this.store.connection.prepare(
        `SELECT encrypted_input, expires_at FROM pending_schedule_corrections WHERE owner_id = ?`,
      ).get(input.ownerId) as { encrypted_input: string; expires_at: string } | undefined;
      if (!row) {
        return undefined;
      }
      this.store.connection.prepare(
        `DELETE FROM pending_schedule_corrections WHERE owner_id = ?`,
      ).run(input.ownerId);
      if (Date.parse(row.expires_at) <= input.now.valueOf()) {
        return undefined;
      }
      try {
        return this.secretBox.decrypt(row.encrypted_input);
      } catch {
        return undefined;
      }
    });
    return consume();
  }

  public putInterpretation(input: ScheduleInterpretationCacheInput): void {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.input, "input");
    assertValidDate(input.now, "now");
    assertValidDate(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.now) {
      throw new Error("expiresAt must be after now");
    }
    this.store.connection.prepare(
      `INSERT INTO interpretation_cache
       (owner_id, input_hash, encrypted_payload, source, expires_at, created_at, last_used_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(owner_id, input_hash) DO UPDATE SET encrypted_payload = excluded.encrypted_payload,
          source = excluded.source, expires_at = excluded.expires_at, last_used_at = excluded.last_used_at, use_count = 0`,
    ).run(
      input.ownerId,
      inputHash(input.input),
      this.secretBox.encrypt(JSON.stringify(input.command)),
      input.source,
      input.expiresAt.toISOString(),
      input.now.toISOString(),
      input.now.toISOString(),
    );
  }

  public getInterpretation(input: { input: string; now: Date; ownerId: string }): ScheduleInterpretationCacheEntry | undefined {
    const hash = inputHash(input.input);
    const row = this.store.connection.prepare(
      `SELECT encrypted_payload, expires_at, source FROM interpretation_cache WHERE owner_id = ? AND input_hash = ?`,
    ).get(input.ownerId, hash) as { encrypted_payload: string; expires_at: string; source: unknown } | undefined;
    if (!row) {
      return undefined;
    }
    if (new Date(row.expires_at) <= input.now) {
      this.store.connection.prepare(
        `DELETE FROM interpretation_cache WHERE owner_id = ? AND input_hash = ?`,
      ).run(input.ownerId, hash);
      return undefined;
    }
    if (row.source !== "gemini" && row.source !== "manual") {
      this.store.connection.prepare(
        `DELETE FROM interpretation_cache WHERE owner_id = ? AND input_hash = ?`,
      ).run(input.ownerId, hash);
      return undefined;
    }
    try {
      const command: unknown = JSON.parse(this.secretBox.decrypt(row.encrypted_payload));
      this.store.connection.prepare(
        `UPDATE interpretation_cache SET last_used_at = ?, use_count = use_count + 1 WHERE owner_id = ? AND input_hash = ?`,
      ).run(input.now.toISOString(), input.ownerId, hash);
      return { command, source: row.source };
    } catch {
      this.store.connection.prepare(
        `DELETE FROM interpretation_cache WHERE owner_id = ? AND input_hash = ?`,
      ).run(input.ownerId, hash);
      return undefined;
    }
  }

  public forgetInterpretation(input: { input: string; ownerId: string }): void {
    this.store.connection.prepare(
      `DELETE FROM interpretation_cache WHERE owner_id = ? AND input_hash = ?`,
    ).run(input.ownerId, inputHash(input.input));
  }

  private materializeSeries(seriesId: string, throughDate: string, now: Date): void {
    const row = this.store.connection.prepare(
      `SELECT id, owner_id, kind, encrypted_title, start_date, start_time, time_zone,
              recurrence_json, status, created_at, updated_at, cancelled_at
       FROM schedule_series WHERE id = ? AND status = 'active'`,
    ).get(seriesId) as ScheduleSeriesRow | undefined;
    if (!row) {
      return;
    }
    const series = this.toScheduleSeries(row);
    const dates = expandScheduleDates({
      endDate: throughDate,
      recurrence: series.recurrence,
      startDate: series.startDate,
      timeZone: series.timeZone,
    });
    const title = series.title;
    const insert = this.store.connection.prepare(
      `INSERT OR IGNORE INTO scheduled_items (
         id, owner_id, series_id, occurrence_key, kind, encrypted_title,
         scheduled_date, due_at, time_zone, status, created_at, updated_at,
         completed_at, cancelled_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1)`,
    );
    for (const date of dates) {
      const dueAt = series.kind === "reminder" && series.startTime
        ? this.dueAt(date, series.startTime, series.timeZone)
        : undefined;
      if (series.kind === "reminder" && !dueAt) {
        continue;
      }
      insert.run(
        randomUUID(),
        series.ownerId,
        series.id,
        date,
        series.kind,
        this.secretBox.encrypt(title),
        date,
        dueAt?.toISOString() ?? null,
        series.timeZone,
        now.toISOString(),
        now.toISOString(),
      );
    }
  }

  private dueAt(date: string, time: string, timeZone: string): Date | undefined {
    const validated = validateLocalTaskDateTime(date, time, timeZone);
    return validated.kind === "valid" ? validated.value.toUTC().toJSDate() : undefined;
  }

  private transitionScheduledItem(
    input: ScheduledItemTransitionInput,
    status: "cancelled" | "completed",
  ): ScheduledItem | undefined {
    assertValidDate(input.now, "now");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("expectedRevision must be a positive integer");
    }
    const timestamp = input.now.toISOString();
    const updated = this.store.connection.prepare(
      `UPDATE scheduled_items
       SET status = ?, updated_at = ?,
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
           cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
           revision = revision + 1
       WHERE id = ? AND owner_id = ? AND status = 'active' AND revision = ?`,
    ).run(status, timestamp, status, timestamp, status, timestamp, input.id, input.ownerId, input.expectedRevision);
    return updated.changes === 1 ? this.getScheduledItem({ id: input.id, ownerId: input.ownerId }) : undefined;
  }

  private toScheduledItem(row: ScheduledItemRow): ScheduledItem {
    const dueAt = dateFromStored(row.due_at, "scheduled item due_at");
    const createdAt = dateFromStored(row.created_at, "scheduled item created_at");
    const updatedAt = dateFromStored(row.updated_at, "scheduled item updated_at");
    if (!createdAt || !updatedAt) {
      throw new Error("Stored scheduled item is invalid");
    }
    const title = normalizeTitle(this.secretBox.decrypt(row.encrypted_title));
    const completedAt = dateFromStored(row.completed_at, "scheduled item completed_at");
    const cancelledAt = dateFromStored(row.cancelled_at, "scheduled item cancelled_at");
    return {
      ...(cancelledAt ? { cancelledAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      createdAt,
      ...(dueAt ? { dueAt } : {}),
      id: row.id,
      kind: row.kind,
      ...(row.occurrence_key ? { occurrenceKey: row.occurrence_key } : {}),
      ownerId: row.owner_id,
      revision: row.revision,
      scheduledDate: row.scheduled_date,
      ...(row.series_id ? { seriesId: row.series_id } : {}),
      status: row.status,
      timeZone: row.time_zone,
      title,
      updatedAt,
    };
  }

  private toScheduleSeries(row: ScheduleSeriesRow): ScheduleSeries {
    let recurrence: unknown;
    try {
      recurrence = JSON.parse(row.recurrence_json);
    } catch {
      throw new Error("Stored schedule recurrence is invalid");
    }
    if (!validRecurrence(recurrence)) {
      throw new Error("Stored schedule recurrence is invalid");
    }
    const createdAt = dateFromStored(row.created_at, "schedule series created_at");
    const updatedAt = dateFromStored(row.updated_at, "schedule series updated_at");
    if (!createdAt || !updatedAt) {
      throw new Error("Stored schedule series is invalid");
    }
    const cancelledAt = dateFromStored(row.cancelled_at, "schedule series cancelled_at");
    return {
      ...(cancelledAt ? { cancelledAt } : {}),
      createdAt,
      id: row.id,
      kind: row.kind,
      ownerId: row.owner_id,
      recurrence,
      startDate: row.start_date,
      ...(row.start_time ? { startTime: row.start_time } : {}),
      status: row.status,
      timeZone: row.time_zone,
      title: normalizeTitle(this.secretBox.decrypt(row.encrypted_title)),
      updatedAt,
    };
  }
}
