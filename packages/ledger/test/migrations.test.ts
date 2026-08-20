/**
 * Coverage for schema versioning.
 *
 * The three claims that matter, and why each is here rather than left
 * to review:
 *
 * 1. **A legacy file upgrades in place.** Every existing
 *    `.data/ledger.sqlite` was written before `user_version` was
 *    stamped. If replaying the migration list against one of those is
 *    not a no-op plus the new tables, the first deploy of this change
 *    corrupts real data.
 * 2. **A pre-authorization-columns file gains its columns.** This is the
 *    regression the old ad-hoc `ALTER` list existed to prevent, so the
 *    replacement has to keep preventing it.
 * 3. **A future file is refused.** This is the property the old code did
 *    not have at all: an older binary silently appended to a file a
 *    newer one had reshaped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  LedgerSchemaVersionError,
  MIGRATIONS,
  migrate,
  readAppliedMigrations,
  readUserVersion,
} from "../src/migrations.js";
import { openLedgerStore } from "../src/store.js";
import {
  SAMPLE_CHAIN_ID,
  SAMPLE_TOKEN,
  SAMPLE_TOKEN_DECIMALS,
} from "./_fixtures.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "neuro-pay-migrations-"));
  dbPath = join(dir, "test.ledger.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Column names of `table`, as SQLite reports them. */
function columnsOf(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

describe("migration list", () => {
  it("has strictly increasing, gapless versions starting at 1", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(
      Array.from({ length: versions.length }, (_, i) => i + 1),
    );
    expect(LATEST_SCHEMA_VERSION).toBe(versions.length);
  });
});

describe("migrate", () => {
  it("brings a fresh file to the latest version and records every step", () => {
    const db = new DatabaseSync(dbPath);
    const report = migrate(db);

    expect(report.from).toBe(0);
    expect(report.to).toBe(LATEST_SCHEMA_VERSION);
    expect(report.applied.map((a) => a.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    expect(readUserVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(readAppliedMigrations(db)).toHaveLength(MIGRATIONS.length);
    db.close();
  });

  it("is a no-op on a file already at the latest version", () => {
    const db = new DatabaseSync(dbPath);
    migrate(db);
    const second = migrate(db);

    expect(second.from).toBe(LATEST_SCHEMA_VERSION);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it("upgrades a pre-versioning file without touching its rows", () => {
    // Stand up exactly what a legacy install has: the version-1 tables,
    // no `user_version`, no `schema_migrations`, and a row already in
    // the ledger.
    const legacy = new DatabaseSync(dbPath);
    for (const statement of MIGRATIONS[0]?.statements ?? []) {
      legacy.exec(statement);
    }
    legacy
      .prepare(
        `INSERT INTO ledger_entries (
          id, seq, timestamp, event, stream_id, session_public_key,
          chain_id, token, token_decimals, amount, nonce, transaction_hash,
          classification, corrects_entry_id, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        1,
        "2026-01-01T00:00:00.000Z",
        "stream.opened",
        "stream-legacy",
        null,
        SAMPLE_CHAIN_ID,
        SAMPLE_TOKEN,
        SAMPLE_TOKEN_DECIMALS,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    expect(readUserVersion(legacy)).toBe(0);
    legacy.close();

    const store = openLedgerStore({ storagePath: dbPath });
    expect(store.schemaInfo().version).toBe(LATEST_SCHEMA_VERSION);
    // The pre-existing row is still readable and still first.
    return store.entries().then((entries) => {
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe("legacy-1");
      expect(entries[0]?.streamId).toBe("stream-legacy");
      store.close();
    });
  });

  it("adds the settlement authorization columns to a table that predates them", () => {
    const legacy = new DatabaseSync(dbPath);
    // The version-1 `settlement_intents` as it existed before the
    // buyer's signed data was threaded through settlement.
    legacy.exec(`CREATE TABLE settlement_intents (
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
      status TEXT NOT NULL,
      transaction_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    expect(columnsOf(legacy, "settlement_intents")).not.toContain("signature");
    legacy.close();

    const db = new DatabaseSync(dbPath);
    migrate(db);
    const columns = columnsOf(db, "settlement_intents");
    expect(columns).toEqual(
      expect.arrayContaining([
        "signature",
        "spender",
        "witness_to",
        "witness_valid_after",
      ]),
    );
    db.close();
  });

  it("refuses a file written by a newer build", () => {
    const future = new DatabaseSync(dbPath);
    migrate(future);
    future.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 7}`);
    future.close();

    expect(() => openLedgerStore({ storagePath: dbPath })).toThrow(
      LedgerSchemaVersionError,
    );
  });

  it("leaves the version untouched when a step throws", () => {
    const db = new DatabaseSync(dbPath);
    migrate(db);
    // Rewind to 1 so migrations 2 and 3 are pending, then reshape the
    // bookkeeping table so recording an applied step violates a NOT
    // NULL constraint. Every DDL statement in the list is
    // `IF NOT EXISTS`, so the bookkeeping insert is the realistic place
    // for a partial run to die.
    db.exec("PRAGMA user_version = 1");
    db.exec("DROP TABLE schema_migrations");
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      required_extra TEXT NOT NULL
    )`);
    db.exec("DROP TABLE IF EXISTS audit_events");

    expect(() => migrate(db)).toThrow();
    expect(readUserVersion(db)).toBe(1);
    // The table migration 3 creates was rolled back with the rest of
    // the run, so the file is at version 1 in fact and not just in the
    // pragma.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("audit_events");
    db.close();
  });
});

describe("store schemaInfo", () => {
  it("reports the file version alongside what this build supports", () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    const info = store.schemaInfo();
    expect(info.version).toBe(LATEST_SCHEMA_VERSION);
    expect(info.latest).toBe(LATEST_SCHEMA_VERSION);
    expect(info.applied.map((a) => a.name)).toContain("baseline");
    store.close();
  });

  it("hands the migration report to `onMigrate`", () => {
    const reports: number[] = [];
    const store = openLedgerStore({
      storagePath: dbPath,
      onMigrate: (report) => reports.push(report.applied.length),
    });
    store.close();
    const reopened = openLedgerStore({
      storagePath: dbPath,
      onMigrate: (report) => reports.push(report.applied.length),
    });
    reopened.close();

    expect(reports).toEqual([LATEST_SCHEMA_VERSION, 0]);
  });
});
