import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

type SqliteConnection = Database.Database;

interface Migration {
  readonly sql: string;
  readonly version: number;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_credentials (
        provider TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_actions_expiry_index ON pending_actions(expires_at);

      CREATE TABLE IF NOT EXISTS reminder_overrides (
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        occurrence_start TEXT NOT NULL,
        minutes_before INTEGER NOT NULL CHECK(minutes_before >= 0 AND minutes_before <= 40320),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(calendar_id, event_id, occurrence_start)
      );

      CREATE TABLE IF NOT EXISTS reminder_deliveries (
        delivery_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        actor_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_authorization_states (
        state_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_authorization_states_expiry_index
        ON oauth_authorization_states(expires_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS local_tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        encrypted_title TEXT NOT NULL,
        due_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      );
      CREATE INDEX IF NOT EXISTS local_tasks_active_due_index
        ON local_tasks(owner_id, due_at)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS local_task_reminder_deliveries (
        task_id TEXT NOT NULL REFERENCES local_tasks(id),
        scheduled_for TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY(task_id, scheduled_for)
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS local_task_reminder_claims (
        task_id TEXT NOT NULL REFERENCES local_tasks(id),
        scheduled_for TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        PRIMARY KEY(task_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS local_task_reminder_claims_expiry_index
        ON local_task_reminder_claims(lease_expires_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS schedule_series (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('task', 'reminder')),
        encrypted_title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_time TEXT,
        time_zone TEXT NOT NULL,
        recurrence_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cancelled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_series_active_index
        ON schedule_series(owner_id, status, start_date);

      CREATE TABLE IF NOT EXISTS scheduled_items (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        series_id TEXT REFERENCES schedule_series(id),
        occurrence_key TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('task', 'reminder')),
        encrypted_title TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        due_at TEXT,
        time_zone TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        UNIQUE(series_id, occurrence_key)
      );
      CREATE INDEX IF NOT EXISTS scheduled_items_active_date_index
        ON scheduled_items(owner_id, scheduled_date, kind)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS scheduled_items_due_index
        ON scheduled_items(owner_id, due_at)
        WHERE status = 'active' AND due_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS scheduled_item_reminder_deliveries (
        item_id TEXT NOT NULL REFERENCES scheduled_items(id),
        scheduled_for TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY(item_id, scheduled_for)
      );
      CREATE TABLE IF NOT EXISTS scheduled_item_reminder_claims (
        item_id TEXT NOT NULL REFERENCES scheduled_items(id),
        scheduled_for TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        PRIMARY KEY(item_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS scheduled_item_reminder_claims_expiry_index
        ON scheduled_item_reminder_claims(lease_expires_at);

      CREATE TABLE IF NOT EXISTS daily_agenda_deliveries (
        owner_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY(owner_id, local_date)
      );
      CREATE INDEX IF NOT EXISTS daily_agenda_delivery_claim_expiry_index
        ON daily_agenda_deliveries(lease_expires_at);

      CREATE TABLE IF NOT EXISTS interpretation_cache (
        owner_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('gemini', 'manual')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner_id, input_hash)
      );
      CREATE INDEX IF NOT EXISTS interpretation_cache_expiry_index
        ON interpretation_cache(expires_at);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS pending_schedule_corrections (
        owner_id TEXT PRIMARY KEY,
        encrypted_input TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_schedule_corrections_expiry_index
        ON pending_schedule_corrections(expires_at);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS natural_language_context (
        owner_id TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS natural_language_context_expiry_index
        ON natural_language_context(expires_at);
    `,
  },
];

export class SqliteStore {
  public readonly connection: SqliteConnection;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }

    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.connection.pragma("journal_mode = WAL");
    this.applyMigrations();
  }

  public close(): void {
    this.connection.close();
  }

  private applyMigrations(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedVersions = new Set(
      this.connection
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      const applyMigration = this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
      applyMigration();
    }
  }
}
