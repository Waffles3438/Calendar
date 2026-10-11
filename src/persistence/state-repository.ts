import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_CHARACTERS, MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_MESSAGES, type NaturalLanguageConversationContext } from "../nlp/natural-language-action.js";
import { isNaturalLanguageClarificationReason } from "../nlp/natural-language-types.js";
import { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";
import {
  MAX_BULK_LOCAL_TASK_CANCELLATIONS,
  type CreateLocalTaskInput,
  type LocalTask,
  type LocalTaskBulkCancellationInput,
  type LocalTaskTransitionInput,
} from "../tasks/task-domain.js";
import { isValidTaskTimeZone } from "../tasks/task-time.js";
import { SqliteStore } from "./database.js";
import { SecretBox } from "./secret-box.js";

export { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";

const googleOAuthSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
  refreshToken: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

export type GoogleOAuthCredentials = z.output<typeof googleOAuthSchema>;

export interface AppStateRepositoryOptions {
  readonly databasePath: string;
  readonly encryptionSecret: string;
}

export interface CreatePendingActionInput {
  readonly expiresAt: Date;
  readonly id: string;
  readonly ownerId: string;
  readonly payload: unknown;
}

export interface ConsumePendingActionInput {
  readonly id: string;
  readonly now: Date;
  readonly ownerId: string;
}

export interface PendingAction {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly id: string;
  readonly ownerId: string;
  readonly payload: unknown;
}

export interface CreateGoogleOAuthStateInput {
  readonly expiresAt: Date;
  readonly ownerId: string;
  readonly state: string;
}

export interface ConsumeGoogleOAuthStateInput {
  readonly now: Date;
  readonly state: string;
}

export interface GoogleOAuthState {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ownerId: string;
}

export interface ReminderOverrideKey {
  readonly calendarId: string;
  readonly eventId: string;
  readonly occurrenceStart?: string;
}

export interface SetReminderOverrideInput extends ReminderOverrideKey {
  readonly minutesBefore: number;
}

export interface RecordReminderDeliveryInput {
  readonly deliveryKey: string;
  readonly eventId: string;
  readonly scheduledFor: string;
}

export interface LocalTaskQuery {
  readonly limit?: number;
  readonly ownerId: string;
}

export interface DueLocalTaskQuery {
  readonly dueAtEarliest: Date;
  readonly dueAtLatest: Date;
  readonly ownerId: string;
}

export interface GetLocalTaskInput {
  readonly id: string;
  readonly ownerId: string;
}

export interface LocalTaskReminderDeliveryInput {
  readonly scheduledFor: Date;
  readonly taskId: string;
}

export interface LocalTaskReminderClaimInput {
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
  readonly ownerId: string;
  readonly scheduledFor: Date;
  readonly taskId: string;
}

export interface CompleteLocalTaskReminderDeliveryInput {
  readonly claimToken: string;
  readonly scheduledFor: Date;
  readonly sentAt: Date;
  readonly taskId: string;
}

export interface ReleaseLocalTaskReminderClaimInput {
  readonly claimToken: string;
  readonly scheduledFor: Date;
  readonly taskId: string;
}

export interface AuditRecordInput {
  readonly actionType: string;
  readonly actorId: string;
  readonly details?: Record<string, unknown>;
  readonly status: "failed" | "succeeded";
}

export type CalendarMigrationJobStatus = "cancelled" | "completed" | "failed" | "pending" | "running";
export type CalendarMigrationEventStatus = "failed" | "moved" | "pending" | "unsupported";

export interface CalendarMigrationJob {
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly destinationCalendarId: string;
  readonly destinationCalendarName: string;
  readonly failureReason?: string;
  readonly id: string;
  readonly ownerId: string;
  readonly sourceCalendarId: string;
  readonly sourceCalendarName: string;
  readonly status: CalendarMigrationJobStatus;
  readonly updatedAt: Date;
}

export interface CalendarMigrationEventRecord {
  readonly destinationEventId?: string;
  readonly failureReason?: string;
  readonly jobId: string;
  readonly sourceEventId: string;
  readonly status: CalendarMigrationEventStatus;
  readonly updatedAt: Date;
}

export interface WebSession {
  readonly createdAt: Date;
  readonly csrfTokenHash: string;
  readonly expiresAt: Date;
  readonly ownerId: string;
}

export interface SaveNaturalLanguageContextInput extends NaturalLanguageConversationContext {
  readonly expiresAt: Date;
  readonly now: Date;
  readonly ownerId: string;
}

export interface NaturalLanguageContextRecord extends NaturalLanguageConversationContext {
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

interface PendingActionRow {
  readonly created_at: string;
  readonly encrypted_payload: string;
  readonly expires_at: string;
  readonly id: string;
  readonly owner_id: string;
}

interface OAuthStateRow {
  readonly created_at: string;
  readonly expires_at: string;
  readonly owner_id: string;
}

interface LocalTaskRow {
  readonly cancelled_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly due_at: string;
  readonly encrypted_title: string;
  readonly id: string;
  readonly owner_id: string;
  readonly revision: number;
  readonly status: "active" | "cancelled" | "completed";
  readonly time_zone: string;
  readonly updated_at: string;
}

class LocalTaskBulkCancellationConflict extends Error { }

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.valueOf())) {
    throw new Error(`${name} must be a valid Date`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

const naturalLanguageContextSchema = z.object({
  clarificationQuestion: z.string().trim().min(1).max(800),
  originalRequest: z.string().trim().min(1).max(1_200),
  reason: z.string().refine(isNaturalLanguageClarificationReason, "invalid clarification reason"),
  recentMessages: z.array(z.string().trim().min(1).max(1_200)).max(MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_MESSAGES),
}).strict();

function normalizedNaturalLanguageContext(input: SaveNaturalLanguageContextInput): NaturalLanguageConversationContext {
  assertNonEmpty(input.ownerId, "ownerId");
  assertNonEmpty(input.originalRequest, "originalRequest");
  assertNonEmpty(input.clarificationQuestion, "clarificationQuestion");
  if (!Number.isInteger(input.recentMessages.length) || input.recentMessages.length > MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_MESSAGES) {
    throw new Error("recentMessages exceeds the natural-language context limit");
  }
  const parsed = naturalLanguageContextSchema.parse({
    clarificationQuestion: input.clarificationQuestion,
    originalRequest: input.originalRequest,
    reason: input.reason,
    recentMessages: input.recentMessages,
  });
  const serialized = JSON.stringify(parsed);
  if (serialized.length > MAX_NATURAL_LANGUAGE_ACTION_CONTEXT_CHARACTERS) {
    throw new Error("natural-language context exceeds the storage limit");
  }
  if (!isNaturalLanguageClarificationReason(parsed.reason)) {
    throw new Error("reason must be a valid clarification reason");
  }
  return {
    ...parsed,
    reason: parsed.reason,
  };
}

function occurrenceStartValue(key: ReminderOverrideKey): string {
  return key.occurrenceStart ?? "";
}

function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("base64url");
}

function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function localTaskDate(value: string | null, name: string): Date | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Stored local task ${name} is invalid`);
  }
  return parsed;
}

/**
 * Small, single-owner persistence layer. Calendar event contents are intentionally
 * not mirrored locally; local task titles are encrypted because they are stored here.
 */
export class AppStateRepository {
  private readonly secretBox: SecretBox;
  private readonly store: SqliteStore;

  public constructor(options: AppStateRepositoryOptions) {
    this.secretBox = new SecretBox(options.encryptionSecret);
    this.store = new SqliteStore(options.databasePath);
  }

  public close(): void {
    this.store.close();
  }

  public saveGoogleOAuth(credentials: GoogleOAuthCredentials): void {
    const normalized = googleOAuthSchema.parse(credentials);
    const encryptedPayload = this.secretBox.encrypt(JSON.stringify(normalized));

    this.store.connection
      .prepare(
        `
          INSERT INTO oauth_credentials (provider, encrypted_payload, updated_at)
          VALUES ('google', ?, ?)
          ON CONFLICT(provider) DO UPDATE SET
            encrypted_payload = excluded.encrypted_payload,
            updated_at = excluded.updated_at
        `,
      )
      .run(encryptedPayload, new Date().toISOString());
  }

  public getGoogleOAuth(): GoogleOAuthCredentials | undefined {
    const row = this.store.connection
      .prepare("SELECT encrypted_payload FROM oauth_credentials WHERE provider = 'google'")
      .get() as { encrypted_payload: string } | undefined;

    if (!row) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.secretBox.decrypt(row.encrypted_payload));
    } catch {
      throw new Error("Stored Google OAuth credentials are invalid");
    }

    return googleOAuthSchema.parse(parsed);
  }

  public clearGoogleOAuth(): void {
    this.store.connection.prepare("DELETE FROM oauth_credentials WHERE provider = 'google'").run();
  }

  public createGoogleOAuthState(input: CreateGoogleOAuthStateInput): void {
    assertValidDate(input.expiresAt, "expiresAt");
    this.store.connection
      .prepare(
        `
          INSERT INTO oauth_authorization_states (state_hash, owner_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        hashOAuthState(input.state),
        input.ownerId,
        input.expiresAt.toISOString(),
        new Date().toISOString(),
      );
  }

  public consumeGoogleOAuthState(input: ConsumeGoogleOAuthStateInput): GoogleOAuthState | undefined {
    assertValidDate(input.now, "now");
    const stateHash = hashOAuthState(input.state);

    const consume = this.store.connection.transaction((): GoogleOAuthState | undefined => {
      const row = this.store.connection
        .prepare(
          `
            SELECT owner_id, expires_at, created_at
            FROM oauth_authorization_states
            WHERE state_hash = ?
          `,
        )
        .get(stateHash) as OAuthStateRow | undefined;

      if (!row) {
        return undefined;
      }

      this.store.connection
        .prepare("DELETE FROM oauth_authorization_states WHERE state_hash = ?")
        .run(stateHash);

      if (Date.parse(row.expires_at) <= input.now.valueOf()) {
        return undefined;
      }

      return {
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        ownerId: row.owner_id,
      };
    });

    return consume();
  }

  public createPendingAction(input: CreatePendingActionInput): void {
    assertValidDate(input.expiresAt, "expiresAt");
    const payloadJson = JSON.stringify(input.payload);
    if (!payloadJson) {
      throw new Error("Pending action payload must be JSON serializable");
    }

    this.store.connection
      .prepare(
        `
          INSERT INTO pending_actions (id, owner_id, encrypted_payload, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.ownerId,
        this.secretBox.encrypt(payloadJson),
        input.expiresAt.toISOString(),
        new Date().toISOString(),
      );
  }

  /** Reads an owner-bound pending action without consuming it, for selection validation. */
  public getPendingAction(input: ConsumePendingActionInput): PendingAction | undefined {
    assertValidDate(input.now, "now");
    const row = this.store.connection
      .prepare(
        `
          SELECT id, owner_id, encrypted_payload, expires_at, created_at
          FROM pending_actions
          WHERE id = ?
        `,
      )
      .get(input.id) as PendingActionRow | undefined;

    if (!row || row.owner_id !== input.ownerId) {
      return undefined;
    }
    if (Date.parse(row.expires_at) <= input.now.valueOf()) {
      this.store.connection.prepare("DELETE FROM pending_actions WHERE id = ?").run(input.id);
      return undefined;
    }

    try {
      return {
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        id: row.id,
        ownerId: row.owner_id,
        payload: JSON.parse(this.secretBox.decrypt(row.encrypted_payload)),
      } satisfies PendingAction;
    } catch {
      this.store.connection.prepare("DELETE FROM pending_actions WHERE id = ?").run(input.id);
      throw new Error("Pending action payload could not be read safely");
    }
  }

  public consumePendingAction(input: ConsumePendingActionInput): PendingAction | undefined {
    assertValidDate(input.now, "now");

    const consume = this.store.connection.transaction(() => {
      const row = this.store.connection
        .prepare(
          `
            SELECT id, owner_id, encrypted_payload, expires_at, created_at
            FROM pending_actions
            WHERE id = ?
          `,
        )
        .get(input.id) as PendingActionRow | undefined;

      if (!row || row.owner_id !== input.ownerId) {
        return undefined;
      }

      if (Date.parse(row.expires_at) <= input.now.valueOf()) {
        this.store.connection.prepare("DELETE FROM pending_actions WHERE id = ?").run(input.id);
        return undefined;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(this.secretBox.decrypt(row.encrypted_payload));
      } catch {
        this.store.connection.prepare("DELETE FROM pending_actions WHERE id = ?").run(input.id);
        throw new Error("Pending action payload could not be read safely");
      }

      this.store.connection.prepare("DELETE FROM pending_actions WHERE id = ?").run(input.id);
      return {
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        id: row.id,
        ownerId: row.owner_id,
        payload,
      } satisfies PendingAction;
    });

    return consume();
  }

  /** Stores the minimum owner-bound context needed to resolve a clarification follow-up. */
  public saveNaturalLanguageContext(input: SaveNaturalLanguageContextInput): void {
    assertValidDate(input.now, "now");
    assertValidDate(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.now) {
      throw new Error("expiresAt must be after now");
    }
    const context = normalizedNaturalLanguageContext(input);
    this.store.connection.prepare(
      `INSERT INTO natural_language_context (owner_id, encrypted_payload, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload,
         expires_at = excluded.expires_at, created_at = excluded.created_at`,
    ).run(
      input.ownerId,
      this.secretBox.encrypt(JSON.stringify(context)),
      input.expiresAt.toISOString(),
      input.now.toISOString(),
    );
  }

  /** Reads unexpired clarification context and removes expired or corrupt records. */
  public getNaturalLanguageContext(input: { now: Date; ownerId: string }): NaturalLanguageContextRecord | undefined {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.now, "now");
    const row = this.store.connection.prepare(
      `SELECT encrypted_payload, expires_at, created_at
       FROM natural_language_context WHERE owner_id = ?`,
    ).get(input.ownerId) as { encrypted_payload: string; expires_at: string; created_at: string } | undefined;
    if (!row) {
      return undefined;
    }
    const expiresAt = new Date(row.expires_at);
    const createdAt = new Date(row.created_at);
    if (Number.isNaN(expiresAt.valueOf()) || Number.isNaN(createdAt.valueOf()) || expiresAt <= input.now) {
      this.clearNaturalLanguageContext({ ownerId: input.ownerId });
      return undefined;
    }
    try {
      const parsed = naturalLanguageContextSchema.safeParse(JSON.parse(this.secretBox.decrypt(row.encrypted_payload)));
      if (!parsed.success || !isNaturalLanguageClarificationReason(parsed.data.reason)) {
        this.clearNaturalLanguageContext({ ownerId: input.ownerId });
        return undefined;
      }
      return {
        ...parsed.data,
        createdAt,
        expiresAt,
        reason: parsed.data.reason,
      };
    } catch {
      this.clearNaturalLanguageContext({ ownerId: input.ownerId });
      return undefined;
    }
  }

  public clearNaturalLanguageContext(input: { ownerId: string }): void {
    assertNonEmpty(input.ownerId, "ownerId");
    this.store.connection.prepare("DELETE FROM natural_language_context WHERE owner_id = ?").run(input.ownerId);
  }

  public createLocalTask(input: CreateLocalTaskInput): LocalTask {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.ownerId, "ownerId");
    const title = input.title.replace(/\s+/gu, " ").trim();
    assertNonEmpty(title, "title");
    assertValidDate(input.dueAt, "dueAt");
    assertValidDate(input.now, "now");
    if (!isValidTaskTimeZone(input.timeZone)) {
      throw new Error("timeZone must be a valid IANA time zone");
    }

    const timestamp = input.now.toISOString();
    this.store.connection
      .prepare(
        `
          INSERT INTO local_tasks (
            id, owner_id, encrypted_title, due_at, time_zone, status,
            created_at, updated_at, completed_at, cancelled_at, revision
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1)
        `,
      )
      .run(
        input.id,
        input.ownerId,
        this.secretBox.encrypt(title),
        input.dueAt.toISOString(),
        input.timeZone,
        timestamp,
        timestamp,
      );

    const created = this.getLocalTask({ id: input.id, ownerId: input.ownerId });
    if (!created) {
      throw new Error("Created local task could not be read");
    }
    return created;
  }

  public getLocalTask(input: GetLocalTaskInput): LocalTask | undefined {
    const row = this.store.connection
      .prepare(
        `
          SELECT id, owner_id, encrypted_title, due_at, time_zone, status,
                 created_at, updated_at, completed_at, cancelled_at, revision
          FROM local_tasks
          WHERE id = ? AND owner_id = ?
        `,
      )
      .get(input.id, input.ownerId) as LocalTaskRow | undefined;

    return row ? this.toLocalTask(row) : undefined;
  }

  public listActiveLocalTasks(input: LocalTaskQuery): readonly LocalTask[] {
    assertNonEmpty(input.ownerId, "ownerId");
    const limit = input.limit ?? 10_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("limit must be an integer between 1 and 10000");
    }

    const rows = this.store.connection
      .prepare(
        `
          SELECT id, owner_id, encrypted_title, due_at, time_zone, status,
                 created_at, updated_at, completed_at, cancelled_at, revision
          FROM local_tasks
          WHERE owner_id = ? AND status = 'active'
          ORDER BY due_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(input.ownerId, limit) as LocalTaskRow[];

    return rows.map((row) => this.toLocalTask(row));
  }

  public listActiveLocalTasksInRange(input: {
    dueAtEarliest: Date;
    dueAtLatest: Date;
    limit: number;
    ownerId: string;
  }): readonly LocalTask[] {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.dueAtEarliest, "dueAtEarliest");
    assertValidDate(input.dueAtLatest, "dueAtLatest");
    if (input.dueAtEarliest > input.dueAtLatest) {
      throw new Error("dueAtEarliest must be before dueAtLatest");
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new Error("limit must be an integer between 1 and 10000");
    }

    const rows = this.store.connection
      .prepare(
        `
          SELECT id, owner_id, encrypted_title, due_at, time_zone, status,
                 created_at, updated_at, completed_at, cancelled_at, revision
          FROM local_tasks
          WHERE owner_id = ? AND status = 'active' AND due_at >= ? AND due_at <= ?
          ORDER BY due_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(
        input.ownerId,
        input.dueAtEarliest.toISOString(),
        input.dueAtLatest.toISOString(),
        input.limit,
      ) as LocalTaskRow[];

    return rows.map((row) => this.toLocalTask(row));
  }

  public listDueLocalTasks(input: DueLocalTaskQuery): readonly LocalTask[] {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.dueAtEarliest, "dueAtEarliest");
    assertValidDate(input.dueAtLatest, "dueAtLatest");
    if (input.dueAtEarliest > input.dueAtLatest) {
      throw new Error("dueAtEarliest must be before dueAtLatest");
    }

    const rows = this.store.connection
      .prepare(
        `
          SELECT id, owner_id, encrypted_title, due_at, time_zone, status,
                 created_at, updated_at, completed_at, cancelled_at, revision
          FROM local_tasks
          WHERE owner_id = ? AND status = 'active' AND due_at >= ? AND due_at <= ?
          ORDER BY due_at ASC, id ASC
        `,
      )
      .all(input.ownerId, input.dueAtEarliest.toISOString(), input.dueAtLatest.toISOString()) as LocalTaskRow[];

    return rows.map((row) => this.toLocalTask(row));
  }

  public completeLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined {
    return this.transitionLocalTask(input, "completed");
  }

  public cancelLocalTask(input: LocalTaskTransitionInput): LocalTask | undefined {
    return this.transitionLocalTask(input, "cancelled");
  }

  /** Cancels an exact revision-checked task snapshot in one transaction. */
  public cancelLocalTasks(input: LocalTaskBulkCancellationInput): readonly LocalTask[] | undefined {
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.now, "now");
    if (input.tasks.length === 0 || input.tasks.length > MAX_BULK_LOCAL_TASK_CANCELLATIONS) {
      throw new Error(`tasks must contain between 1 and ${MAX_BULK_LOCAL_TASK_CANCELLATIONS} entries`);
    }

    const taskIds = new Set<string>();
    for (const task of input.tasks) {
      assertNonEmpty(task.id, "task id");
      if (!Number.isInteger(task.expectedRevision) || task.expectedRevision < 1) {
        throw new Error("task expectedRevision must be a positive integer");
      }
      if (taskIds.has(task.id)) {
        throw new Error("tasks must not contain duplicate ids");
      }
      taskIds.add(task.id);
    }

    const timestamp = input.now.toISOString();
    const cancel = this.store.connection.transaction((): readonly LocalTask[] => {
      const update = this.store.connection.prepare(
        `
          UPDATE local_tasks
          SET status = 'cancelled',
              updated_at = ?,
              cancelled_at = ?,
              revision = revision + 1
          WHERE id = ? AND owner_id = ? AND status = 'active' AND revision = ?
        `,
      );
      const cancelled: LocalTask[] = [];
      for (const task of input.tasks) {
        const result = update.run(timestamp, timestamp, task.id, input.ownerId, task.expectedRevision);
        if (result.changes !== 1) {
          throw new LocalTaskBulkCancellationConflict();
        }

        const cancelledTask = this.getLocalTask({ id: task.id, ownerId: input.ownerId });
        if (!cancelledTask) {
          throw new LocalTaskBulkCancellationConflict();
        }
        cancelled.push(cancelledTask);
      }
      return cancelled;
    });

    try {
      return cancel();
    } catch (error) {
      if (error instanceof LocalTaskBulkCancellationConflict) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Acquires a short-lived, owner-bound claim before a Discord send. This is
   * deliberately separate from delivery recording so failed sends are retryable.
   */
  public tryClaimLocalTaskReminderDelivery(input: LocalTaskReminderClaimInput): boolean {
    assertNonEmpty(input.taskId, "taskId");
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.claimToken, "claimToken");
    assertValidDate(input.scheduledFor, "scheduledFor");
    assertValidDate(input.now, "now");
    assertValidDate(input.leaseExpiresAt, "leaseExpiresAt");
    if (input.leaseExpiresAt <= input.now) {
      throw new Error("leaseExpiresAt must be after now");
    }

    const claim = this.store.connection.transaction((): boolean => {
      const scheduledFor = input.scheduledFor.toISOString();
      this.store.connection
        .prepare(
          `
            DELETE FROM local_task_reminder_claims
            WHERE task_id = ? AND scheduled_for = ? AND lease_expires_at <= ?
          `,
        )
        .run(input.taskId, scheduledFor, input.now.toISOString());

      const activeTask = this.store.connection
        .prepare(
          `
            SELECT 1 AS present FROM local_tasks
            WHERE id = ? AND owner_id = ? AND status = 'active'
          `,
        )
        .get(input.taskId, input.ownerId) as { present: number } | undefined;
      if (!activeTask) {
        return false;
      }

      const delivery = this.store.connection
        .prepare(
          `
            SELECT 1 AS present FROM local_task_reminder_deliveries
            WHERE task_id = ? AND scheduled_for = ?
          `,
        )
        .get(input.taskId, scheduledFor) as { present: number } | undefined;
      if (delivery) {
        return false;
      }

      const result = this.store.connection
        .prepare(
          `
            INSERT OR IGNORE INTO local_task_reminder_claims (
              task_id, scheduled_for, claim_token, claimed_at, lease_expires_at
            ) VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.taskId,
          scheduledFor,
          input.claimToken,
          input.now.toISOString(),
          input.leaseExpiresAt.toISOString(),
        );
      return result.changes === 1;
    });

    return claim();
  }

  /** Records a successful send and releases only the caller's durable claim. */
  public completeLocalTaskReminderDelivery(input: CompleteLocalTaskReminderDeliveryInput): boolean {
    assertNonEmpty(input.taskId, "taskId");
    assertNonEmpty(input.claimToken, "claimToken");
    assertValidDate(input.scheduledFor, "scheduledFor");
    assertValidDate(input.sentAt, "sentAt");

    const complete = this.store.connection.transaction((): boolean => {
      const scheduledFor = input.scheduledFor.toISOString();
      const claim = this.store.connection
        .prepare(
          `
            SELECT 1 AS present FROM local_task_reminder_claims
            WHERE task_id = ? AND scheduled_for = ? AND claim_token = ?
          `,
        )
        .get(input.taskId, scheduledFor, input.claimToken) as { present: number } | undefined;
      if (!claim) {
        return false;
      }

      const recorded = this.store.connection
        .prepare(
          `
            INSERT OR IGNORE INTO local_task_reminder_deliveries (task_id, scheduled_for, sent_at)
            VALUES (?, ?, ?)
          `,
        )
        .run(input.taskId, scheduledFor, input.sentAt.toISOString());
      this.store.connection
        .prepare(
          `
            DELETE FROM local_task_reminder_claims
            WHERE task_id = ? AND scheduled_for = ? AND claim_token = ?
          `,
        )
        .run(input.taskId, scheduledFor, input.claimToken);
      return recorded.changes === 1;
    });

    return complete();
  }

  /** Releases a failed-send claim so the next scheduler run can retry it. */
  public releaseLocalTaskReminderClaim(input: ReleaseLocalTaskReminderClaimInput): void {
    assertNonEmpty(input.taskId, "taskId");
    assertNonEmpty(input.claimToken, "claimToken");
    assertValidDate(input.scheduledFor, "scheduledFor");
    this.store.connection
      .prepare(
        `
          DELETE FROM local_task_reminder_claims
          WHERE task_id = ? AND scheduled_for = ? AND claim_token = ?
        `,
      )
      .run(input.taskId, input.scheduledFor.toISOString(), input.claimToken);
  }

  /** Legacy read helper retained for callers outside the task scheduler. */
  public hasLocalTaskReminderDelivery(input: { scheduledFor: Date; taskId: string }): boolean {
    assertValidDate(input.scheduledFor, "scheduledFor");
    const row = this.store.connection
      .prepare(
        `
          SELECT 1 AS present
          FROM local_task_reminder_deliveries
          WHERE task_id = ? AND scheduled_for = ?
        `,
      )
      .get(input.taskId, input.scheduledFor.toISOString()) as { present: number } | undefined;
    return Boolean(row);
  }

  /** Legacy direct recorder retained for one-off maintenance use. */
  public recordLocalTaskReminderDelivery(input: LocalTaskReminderDeliveryInput): boolean {
    assertValidDate(input.scheduledFor, "scheduledFor");
    const result = this.store.connection
      .prepare(
        `
          INSERT OR IGNORE INTO local_task_reminder_deliveries (task_id, scheduled_for, sent_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(input.taskId, input.scheduledFor.toISOString(), new Date().toISOString());
    return result.changes === 1;
  }

  public setReminderOverride(input: SetReminderOverrideInput): void {
    if (!Number.isInteger(input.minutesBefore) || input.minutesBefore < 0 || input.minutesBefore > MAX_REMINDER_MINUTES) {
      throw new Error(`minutesBefore must be an integer between 0 and ${MAX_REMINDER_MINUTES}`);
    }

    this.store.connection
      .prepare(
        `
          INSERT INTO reminder_overrides (
            calendar_id, event_id, occurrence_start, minutes_before, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(calendar_id, event_id, occurrence_start) DO UPDATE SET
            minutes_before = excluded.minutes_before,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.calendarId,
        input.eventId,
        occurrenceStartValue(input),
        input.minutesBefore,
        new Date().toISOString(),
      );
  }

  public getReminderOverride(key: ReminderOverrideKey): number | undefined {
    const row = this.store.connection
      .prepare(
        `
          SELECT minutes_before FROM reminder_overrides
          WHERE calendar_id = ? AND event_id = ? AND occurrence_start = ?
        `,
      )
      .get(key.calendarId, key.eventId, occurrenceStartValue(key)) as
      | { minutes_before: number }
      | undefined;

    return row?.minutes_before;
  }

  public clearReminderOverride(key: ReminderOverrideKey): void {
    this.store.connection
      .prepare(
        `
          DELETE FROM reminder_overrides
          WHERE calendar_id = ? AND event_id = ? AND occurrence_start = ?
        `,
      )
      .run(key.calendarId, key.eventId, occurrenceStartValue(key));
  }

  public hasReminderDelivery(deliveryKey: string): boolean {
    const row = this.store.connection
      .prepare("SELECT 1 AS present FROM reminder_deliveries WHERE delivery_key = ?")
      .get(deliveryKey) as { present: number } | undefined;

    return Boolean(row);
  }

  public recordReminderDelivery(input: RecordReminderDeliveryInput): boolean {
    const result = this.store.connection
      .prepare(
        `
          INSERT OR IGNORE INTO reminder_deliveries (delivery_key, event_id, scheduled_for, sent_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(input.deliveryKey, input.eventId, input.scheduledFor, new Date().toISOString());

    return result.changes === 1;
  }

  public recordAudit(input: AuditRecordInput): void {
    this.store.connection
      .prepare(
        `
          INSERT INTO audit_log (actor_id, action_type, status, details_json, occurred_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.actorId,
        input.actionType,
        input.status,
        JSON.stringify(input.details ?? {}),
        new Date().toISOString(),
      );
  }

  public createCalendarMigrationJob(input: {
    destinationCalendarId: string;
    destinationCalendarName: string;
    id: string;
    now: Date;
    ownerId: string;
    sourceCalendarId: string;
    sourceCalendarName: string;
  }): void {
    assertNonEmpty(input.id, "migration job id");
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.sourceCalendarId, "sourceCalendarId");
    assertNonEmpty(input.destinationCalendarId, "destinationCalendarId");
    assertValidDate(input.now, "now");
    const timestamp = input.now.toISOString();
    this.store.connection.prepare(
      `INSERT INTO calendar_migration_jobs (
        id, owner_id, source_calendar_id, destination_calendar_id,
        source_calendar_name, destination_calendar_name, status,
        failure_reason, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
    ).run(
      input.id,
      input.ownerId,
      input.sourceCalendarId,
      input.destinationCalendarId,
      input.sourceCalendarName,
      input.destinationCalendarName,
      timestamp,
      timestamp,
    );
  }

  public getCalendarMigrationJob(input: { id: string; ownerId: string }): CalendarMigrationJob | undefined {
    const row = this.store.connection.prepare(
      `SELECT id, owner_id, source_calendar_id, destination_calendar_id,
              source_calendar_name, destination_calendar_name, status,
              failure_reason, created_at, updated_at, completed_at
       FROM calendar_migration_jobs WHERE id = ? AND owner_id = ?`,
    ).get(input.id, input.ownerId) as {
      completed_at: string | null;
      created_at: string;
      destination_calendar_id: string;
      destination_calendar_name: string;
      failure_reason: string | null;
      id: string;
      owner_id: string;
      source_calendar_id: string;
      source_calendar_name: string;
      status: CalendarMigrationJobStatus;
      updated_at: string;
    } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {}),
      createdAt: new Date(row.created_at),
      destinationCalendarId: row.destination_calendar_id,
      destinationCalendarName: row.destination_calendar_name,
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
      id: row.id,
      ownerId: row.owner_id,
      sourceCalendarId: row.source_calendar_id,
      sourceCalendarName: row.source_calendar_name,
      status: row.status,
      updatedAt: new Date(row.updated_at),
    };
  }

  public updateCalendarMigrationJob(input: {
    completedAt?: Date;
    failureReason?: string;
    id: string;
    now: Date;
    ownerId: string;
    status: CalendarMigrationJobStatus;
  }): void {
    assertValidDate(input.now, "now");
    if (input.completedAt) {
      assertValidDate(input.completedAt, "completedAt");
    }
    this.store.connection.prepare(
      `UPDATE calendar_migration_jobs
       SET status = ?, failure_reason = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(
      input.status,
      input.failureReason ?? null,
      input.now.toISOString(),
      input.completedAt?.toISOString() ?? null,
      input.id,
      input.ownerId,
    );
  }

  public upsertCalendarMigrationEvent(input: {
    destinationEventId?: string;
    failureReason?: string;
    jobId: string;
    now: Date;
    sourceEventId: string;
    status: CalendarMigrationEventStatus;
  }): void {
    assertNonEmpty(input.jobId, "jobId");
    assertNonEmpty(input.sourceEventId, "sourceEventId");
    assertValidDate(input.now, "now");
    this.store.connection.prepare(
      `INSERT INTO calendar_migration_events (
        job_id, source_event_id, destination_event_id, status, failure_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, source_event_id) DO UPDATE SET
        destination_event_id = excluded.destination_event_id,
        status = excluded.status,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at`,
    ).run(
      input.jobId,
      input.sourceEventId,
      input.destinationEventId ?? null,
      input.status,
      input.failureReason ?? null,
      input.now.toISOString(),
    );
  }

  public listCalendarMigrationEvents(input: { jobId: string }): readonly CalendarMigrationEventRecord[] {
    const rows = this.store.connection.prepare(
      `SELECT job_id, source_event_id, destination_event_id, status, failure_reason, updated_at
       FROM calendar_migration_events WHERE job_id = ? ORDER BY source_event_id ASC`,
    ).all(input.jobId) as readonly {
      destination_event_id: string | null;
      failure_reason: string | null;
      job_id: string;
      source_event_id: string;
      status: CalendarMigrationEventStatus;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      ...(row.destination_event_id ? { destinationEventId: row.destination_event_id } : {}),
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
      jobId: row.job_id,
      sourceEventId: row.source_event_id,
      status: row.status,
      updatedAt: new Date(row.updated_at),
    }));
  }

  public remapReminderReferences(input: {
    destinationCalendarId: string;
    destinationEventId: string;
    sourceCalendarId: string;
    sourceEventId: string;
  }): void {
    assertNonEmpty(input.sourceCalendarId, "sourceCalendarId");
    assertNonEmpty(input.sourceEventId, "sourceEventId");
    assertNonEmpty(input.destinationCalendarId, "destinationCalendarId");
    assertNonEmpty(input.destinationEventId, "destinationEventId");
    this.store.connection.transaction(() => {
      const overrides = this.store.connection.prepare(
        `SELECT occurrence_start, minutes_before FROM reminder_overrides
         WHERE calendar_id = ? AND event_id = ?`,
      ).all(input.sourceCalendarId, input.sourceEventId) as readonly {
        minutes_before: number;
        occurrence_start: string;
      }[];
      for (const override of overrides) {
        this.store.connection.prepare(
          `INSERT INTO reminder_overrides (
            calendar_id, event_id, occurrence_start, minutes_before, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(calendar_id, event_id, occurrence_start) DO UPDATE SET
            minutes_before = excluded.minutes_before, updated_at = excluded.updated_at`,
        ).run(
          input.destinationCalendarId,
          input.destinationEventId,
          override.occurrence_start,
          override.minutes_before,
          new Date().toISOString(),
        );
      }
      this.store.connection.prepare(
        `DELETE FROM reminder_overrides WHERE calendar_id = ? AND event_id = ?`,
      ).run(input.sourceCalendarId, input.sourceEventId);

      const oldPrefix = `${input.sourceCalendarId}:${input.sourceEventId}:`;
      const deliveries = this.store.connection.prepare(
        `SELECT delivery_key, event_id, scheduled_for, sent_at FROM reminder_deliveries
         WHERE event_id = ?`,
      ).all(input.sourceEventId) as readonly {
        delivery_key: string;
        event_id: string;
        scheduled_for: string;
        sent_at: string;
      }[];
      for (const delivery of deliveries) {
        if (!delivery.delivery_key.startsWith(oldPrefix)) {
          continue;
        }
        const suffix = delivery.delivery_key.slice(oldPrefix.length);
        this.store.connection.prepare(
          `INSERT OR IGNORE INTO reminder_deliveries (delivery_key, event_id, scheduled_for, sent_at)
           VALUES (?, ?, ?, ?)`,
        ).run(
          `${input.destinationCalendarId}:${input.destinationEventId}:${suffix}`,
          input.destinationEventId,
          delivery.scheduled_for,
          delivery.sent_at,
        );
        this.store.connection.prepare("DELETE FROM reminder_deliveries WHERE delivery_key = ?")
          .run(delivery.delivery_key);
      }
    })();
  }

  public createWebSession(input: {
    createdAt: Date;
    csrfToken: string;
    expiresAt: Date;
    ownerId: string;
    token: string;
  }): void {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.token, "token");
    assertNonEmpty(input.csrfToken, "csrfToken");
    assertValidDate(input.createdAt, "createdAt");
    assertValidDate(input.expiresAt, "expiresAt");
    this.store.connection.prepare(
      `INSERT INTO web_sessions (token_hash, owner_id, csrf_token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      hashOpaqueValue(input.token),
      input.ownerId,
      hashOpaqueValue(input.csrfToken),
      input.expiresAt.toISOString(),
      input.createdAt.toISOString(),
    );
  }

  public getWebSession(input: { now: Date; token: string }): WebSession | undefined {
    assertValidDate(input.now, "now");
    const tokenHash = hashOpaqueValue(input.token);
    const row = this.store.connection.prepare(
      `SELECT owner_id, csrf_token_hash, expires_at, created_at
       FROM web_sessions WHERE token_hash = ?`,
    ).get(tokenHash) as {
      created_at: string;
      csrf_token_hash: string;
      expires_at: string;
      owner_id: string;
    } | undefined;
    if (!row) {
      return undefined;
    }
    const expiresAt = new Date(row.expires_at);
    if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= input.now) {
      this.deleteWebSession(input.token);
      return undefined;
    }
    return {
      createdAt: new Date(row.created_at),
      csrfTokenHash: row.csrf_token_hash,
      expiresAt,
      ownerId: row.owner_id,
    };
  }

  public deleteWebSession(token: string): void {
    this.store.connection.prepare("DELETE FROM web_sessions WHERE token_hash = ?")
      .run(hashOpaqueValue(token));
  }

  public clearExpiredWebSessions(now: Date): void {
    assertValidDate(now, "now");
    this.store.connection.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now.toISOString());
  }

  private transitionLocalTask(
    input: LocalTaskTransitionInput,
    status: "cancelled" | "completed",
  ): LocalTask | undefined {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.ownerId, "ownerId");
    assertValidDate(input.now, "now");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("expectedRevision must be a positive integer");
    }

    const timestamp = input.now.toISOString();
    const result = this.store.connection
      .prepare(
        `
          UPDATE local_tasks
          SET status = ?,
              updated_at = ?,
              completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
              cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
              revision = revision + 1
          WHERE id = ? AND owner_id = ? AND status = 'active' AND revision = ?
        `,
      )
      .run(status, timestamp, status, timestamp, status, timestamp, input.id, input.ownerId, input.expectedRevision);

    return result.changes === 1 ? this.getLocalTask({ id: input.id, ownerId: input.ownerId }) : undefined;
  }

  private toLocalTask(row: LocalTaskRow): LocalTask {
    const dueAt = localTaskDate(row.due_at, "due_at");
    const createdAt = localTaskDate(row.created_at, "created_at");
    const updatedAt = localTaskDate(row.updated_at, "updated_at");
    if (!dueAt || !createdAt || !updatedAt || !isValidTaskTimeZone(row.time_zone)) {
      throw new Error("Stored local task is invalid");
    }

    let title: string;
    try {
      title = this.secretBox.decrypt(row.encrypted_title).replace(/\s+/gu, " ").trim();
    } catch {
      throw new Error("Stored local task title could not be read safely");
    }
    if (!title) {
      throw new Error("Stored local task title is invalid");
    }

    const completedAt = localTaskDate(row.completed_at, "completed_at");
    const cancelledAt = localTaskDate(row.cancelled_at, "cancelled_at");
    return {
      ...(cancelledAt ? { cancelledAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      createdAt,
      dueAt,
      id: row.id,
      ownerId: row.owner_id,
      revision: row.revision,
      status: row.status,
      timeZone: row.time_zone,
      title,
      updatedAt,
    };
  }
}
