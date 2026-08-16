import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_REMINDER_MINUTES } from "../reminders/reminder-limits.js";
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

export interface AuditRecordInput {
  readonly actionType: string;
  readonly actorId: string;
  readonly details?: Record<string, unknown>;
  readonly status: "failed" | "succeeded";
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

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.valueOf())) {
    throw new Error(`${name} must be a valid Date`);
  }
}

function occurrenceStartValue(key: ReminderOverrideKey): string {
  return key.occurrenceStart ?? "";
}

function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("base64url");
}

/**
 * Small, single-user persistence layer. Calendar event contents are intentionally
 * not mirrored locally; only encrypted credentials and delivery/safety metadata are kept.
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
}
