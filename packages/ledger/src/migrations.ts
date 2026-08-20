/**
 * Versioned schema migrations for the ledger database.
 *
 * ## Why this exists
 *
 * The store used to apply `CREATE TABLE IF NOT EXISTS` on every open plus
 * a hand-maintained list of additive `ALTER TABLE` statements guarded by
 * `PRAGMA table_info`. That is idempotent, which is the easy half of the
 * problem, but it carries no notion of *which version a file is at*. Two
 * consequences followed, and both are the kind of thing that only shows
 * up in production:
 *
 * 1. A ledger written by a **newer** build opened silently against an
 *    older one. SQLite is happy to hand back a table with extra columns,
 *    so the old binary read a partial view of rows it did not understand
 *    and kept appending to them. There was no point at which anything
 *    said "this file is from the future".
 * 2. There was no record of what had been applied, so a migration that
 *    half-succeeded (process killed between two `ALTER`s) left the file
 *    in a state nothing could describe.
 *
 * This module fixes both by making the schema an ordered list of
 * numbered migrations, stamping `PRAGMA user_version` after each run,
 * recording every applied migration in `schema_migrations`, and
 * **refusing to open** a file whose version is ahead of the code.
 *
 * ## The contract
 *
 * - Migrations are append-only. A published version number is never
 *   edited, renumbered, or removed; a mistake is corrected by a new
 *   migration on top.
 * - Every migration is idempotent on its own, so a legacy file created
 *   before versioning existed (`user_version = 0`, tables already
 *   present) can be brought up to date by replaying the whole list.
 *   That replay is what upgrades existing `.data/ledger.sqlite` files
 *   in place with no export/import step.
 * - Migrations are additive: create tables, create indexes, add columns.
 *   No drops, no renames, no type changes. A destructive change needs a
 *   new table plus a copy, written as its own migration, so a failed
 *   run never leaves data unreachable.
 * - The whole run is one transaction. Either the file lands on the new
 *   version with every statement applied, or it stays exactly where it
 *   was.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * A column added to a table that may predate it.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so these are applied only
 * when `PRAGMA table_info` says the column is missing. Expressed as data
 * rather than raw SQL so the runner can do that check itself.
 */
export type ColumnAddition = {
  table: string;
  column: string;
  ddl: string;
};

/** One numbered, append-only step in the schema's history. */
export type Migration = {
  /** Monotonic, starts at 1, never reused. */
  version: number;
  /** Human label. Shows up in `schema_migrations` and in the ops report. */
  name: string;
  /** Statements safe to re-run — `CREATE ... IF NOT EXISTS` and friends. */
  statements?: string[];
  /** Columns applied only when absent. */
  columns?: ColumnAddition[];
};

/**
 * The schema's history, oldest first.
 *
 * Version 1 is the baseline: everything the schema contained when
 * versioning was introduced, expressed exactly as it already existed on
 * disk so replaying it against a legacy file is a no-op.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "baseline",
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event TEXT NOT NULL,
        stream_id TEXT,
        session_public_key TEXT,
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        token_decimals INTEGER NOT NULL,
        amount TEXT,
        nonce TEXT,
        transaction_hash TEXT,
        classification TEXT,
        corrects_entry_id TEXT,
        detail TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS ledger_entries_seq_idx ON ledger_entries(seq)`,
      `CREATE INDEX IF NOT EXISTS ledger_entries_nonce_idx ON ledger_entries(nonce)
         WHERE nonce IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ledger_entries_stream_idx ON ledger_entries(stream_id)
         WHERE stream_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ledger_entries_session_idx ON ledger_entries(session_public_key)
         WHERE session_public_key IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS delivery_records (
        nonce TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        seconds_delivered INTEGER NOT NULL,
        units_delivered INTEGER NOT NULL,
        accrued_unpaid TEXT NOT NULL,
        total_accrued TEXT NOT NULL,
        stream_ended INTEGER NOT NULL,
        end_reason TEXT,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settlement_intents (
        nonce TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        session_public_key TEXT,
        chain_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        token_decimals INTEGER NOT NULL,
        amount TEXT NOT NULL,
        payer TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        deadline INTEGER,
        signature TEXT,
        spender TEXT,
        witness_to TEXT,
        witness_valid_after TEXT,
        status TEXT NOT NULL,
        transaction_hash TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS settlement_intents_status_idx
         ON settlement_intents(status)`,
    ],
  },
  {
    version: 2,
    name: "settlement-authorization-columns",
    // A ledger created before the buyer's real signed data was threaded
    // into settlement has a `settlement_intents` table without these
    // four columns, and `CREATE TABLE IF NOT EXISTS` leaves it alone.
    // Version 1's DDL already declares them for a fresh file; this step
    // is what upgrades an old one.
    columns: [
      {
        table: "settlement_intents",
        column: "signature",
        ddl: "ALTER TABLE settlement_intents ADD COLUMN signature TEXT",
      },
      {
        table: "settlement_intents",
        column: "spender",
        ddl: "ALTER TABLE settlement_intents ADD COLUMN spender TEXT",
      },
      {
        table: "settlement_intents",
        column: "witness_to",
        ddl: "ALTER TABLE settlement_intents ADD COLUMN witness_to TEXT",
      },
      {
        table: "settlement_intents",
        column: "witness_valid_after",
        ddl: "ALTER TABLE settlement_intents ADD COLUMN witness_valid_after TEXT",
      },
    ],
  },
  {
    version: 3,
    name: "audit-events",
    // Administrative actions live in their own table rather than in
    // `ledger_entries`. A ledger entry is a *payment* fact and every row
    // carries a chain, a token, and decimals; "an operator changed the
    // price sheet" has none of those, and forcing it into that shape
    // would mean inventing values that later readers would aggregate.
    statements: [
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        subject TEXT,
        outcome TEXT NOT NULL,
        request_id TEXT,
        detail TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS audit_events_seq_idx ON audit_events(seq)`,
      `CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events(action)`,
    ],
  },
];

/** The version a file is brought to when this build opens it. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

/** One applied step, as reported back to the caller of `migrate`. */
export type AppliedMigration = {
  version: number;
  name: string;
};

export type MigrationReport = {
  /** The file's version before this run. 0 for a fresh or pre-versioning file. */
  from: number;
  /** The file's version after this run. Always `LATEST_SCHEMA_VERSION`. */
  to: number;
  /** Steps applied, in order. Empty when the file was already current. */
  applied: AppliedMigration[];
};

/**
 * Thrown when the file on disk was written by a build newer than this one.
 *
 * Opening it read-write would mean appending rows shaped by an older
 * understanding of the schema into a table a newer process is also
 * writing. There is no safe automatic recovery — the operator either
 * runs the newer build or restores an older backup — so this is fatal
 * rather than a warning.
 */
export class LedgerSchemaVersionError extends Error {
  constructor(
    readonly fileVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `ledger schema version ${fileVersion} is newer than this build supports ` +
        `(${supportedVersion}). The database was written by a later version of ` +
        `neuro-pay; run that version, or restore a backup taken at or below ` +
        `version ${supportedVersion}.`,
    );
    this.name = "LedgerSchemaVersionError";
  }
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/**
 * Bring `db` up to `LATEST_SCHEMA_VERSION`.
 *
 * Safe to call on every open: a current file does no writes and returns
 * an empty `applied` list.
 */
export function migrate(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): MigrationReport {
  db.exec(MIGRATIONS_TABLE);

  const from = readUserVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new LedgerSchemaVersionError(from, LATEST_SCHEMA_VERSION);
  }

  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) {
    return { from, to: from, applied: [] };
  }

  const applied: AppliedMigration[] = [];
  // One transaction for the whole run. A migration list that fails
  // halfway leaves the file at its previous version rather than in a
  // state no version number describes.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      for (const statement of migration.statements ?? []) {
        db.exec(statement);
      }
      for (const column of migration.columns ?? []) {
        applyColumnAddition(db, column);
      }
      db.prepare(
        `INSERT OR REPLACE INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
      ).run(migration.version, migration.name, now());
      applied.push({ version: migration.version, name: migration.name });
    }
    // `user_version` takes a literal only — no bind parameters — so the
    // value is interpolated. It comes from our own migration list, never
    // from input.
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failing statement may already have aborted the transaction;
      // the throw below is what the caller acts on either way.
    }
    throw err;
  }

  return { from, to: LATEST_SCHEMA_VERSION, applied };
}

/** Current `user_version` of the file. 0 before versioning was introduced. */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

/** Every migration recorded as applied, oldest first. */
export function readAppliedMigrations(db: DatabaseSync): {
  version: number;
  name: string;
  appliedAt: string;
}[] {
  const rows = db
    .prepare(
      `SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`,
    )
    .all() as { version: number; name: string; applied_at: string }[];
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

/**
 * Add a column only when the table exists and lacks it.
 *
 * A missing table is not an error: version 1 creates every table this
 * build knows about, so a table absent here means the migration is
 * running against a file whose baseline never had it, and the later
 * `CREATE TABLE` already declares the column.
 */
function applyColumnAddition(db: DatabaseSync, addition: ColumnAddition): void {
  const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as {
    name: string;
  }[];
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === addition.column)) return;
  db.exec(addition.ddl);
}
