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
