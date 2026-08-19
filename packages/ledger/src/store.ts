/**
 * Append-only persistence for the payment ledger.
 *
 * The store is the only place a write ever happens. Everything above it
 * (event helpers, lookup, window, exposure) goes through `append`, and the
 * schema and `append` together enforce the contract: rows are never updated
 * or deleted in place, ordering is preserved, bigint amounts survive a
 * round trip exactly, and writes carrying key material are refused before
 * they hit the table.
 *
 * Persistence is `node:sqlite` — a Node 22+ built-in. The deliberate
 * trade-offs, documented in `packages/ledger/README.md`, are:
 *
 * - no native build step (no node-gyp, no prebuilt-binary pinning per
 *   Node minor), so CI is fast and deterministic;
 * - the connection is synchronous and in-process, which matches the
 *   append-only, single-writer nature of this ledger (the agent process is
 *   one writer; tests are also one writer each);
 * - the database lives in a file under `storagePath` and is opened with
 *   `create: true` only on the first call, so an empty directory yields a
 *   working ledger and a populated directory yields back exactly what was
 *   written.
 */

import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { DatabaseSync } from "node:sqlite";

import type {
  LedgerEntry,
  LedgerEventType,
  PaymentFailureClassification,
} from "@neuro-pay/types";
import type {
  Address,
  Hex,
  IsoTimestamp,
  SmallestUnits,
} from "@neuro-pay/types";

import { assertNoKeyMaterial, KeyMaterialRejectedError } from "./secrets.js";
import {
  decodeDeliveryRow,
  encodeDeliveryRecord,
  type DeliveryRecord,
  type DeliveryRow,
} from "./delivery.js";
import {
  decodeSettlementIntentRow,
  encodeSettlementIntent,
  type SettlementIntent,
  type SettlementIntentPatch,
  type SettlementIntentRow,
  type SettlementIntentStatus,
} from "./outbox.js";

/**
 * Wire columns of a ledger row on disk. Kept in one place so every SQL
 * statement agrees on the shape, and so adding a column is one edit
 * instead of a sweep.
 */
type LedgerRow = {
  id: string;
  /**
   * Wire column for the append sequence. Matches the SQL column name so
   * rows read back from `node:sqlite` can be decoded without translation.
   * The in-memory `LedgerEntry` exposes this as `sequence`.
   */
  seq: number;
  timestamp: string;
  event: string;
  stream_id: string | null;
  session_public_key: string | null;
  chain_id: number;
  token: string;
  token_decimals: number;
  amount: string | null;
  nonce: string | null;
  transaction_hash: string | null;
  classification: string | null;
  corrects_entry_id: string | null;
  detail: string | null;
};

/**
 * Inputs for `append` that have not been sequenced or stamped yet.
 *
 * The caller does not provide `sequence`, `timestamp`, or `id`; those come
 * from the store itself, which is what guarantees the append-only contract.
 */
export type AppendInput = Omit<LedgerEntry, "id" | "sequence" | "timestamp"> & {
  /**
   * Override for the timestamp. Defaults to the wall clock at append time;
   * tests inject a fixed instant to produce a deterministic ledger.
   */
  timestamp?: IsoTimestamp;
};

export type LedgerStoreOptions = {
  /**
   * Filesystem location of the SQLite database. The parent directory is
   * created if missing; `:memory:` is also accepted for tests.
   */
  storagePath: string | ":memory:";
  /**
   * Injected clock. Returns an ISO-8601 UTC string with millisecond
   * precision, matching the `IsoTimestamp` wire type. Defaults to the
   * real wall clock.
   */
  clock?: () => IsoTimestamp;
  /**
   * Random source for entry ids. Defaults to `randomUUID`; tests inject a
   * deterministic generator to make snapshots reproducible.
   */
  randomId?: () => string;
};

/**
 * Schema applied when the store is opened. Idempotent: every statement is
 * `IF NOT EXISTS`, so a populated database opens without rewriting history.
 *
 * `seq` is a separate column from `id` so `ORDER BY seq` is the canonical
 * replay order independent of insertion timing — `id` is a UUID and UUIDs
 * do not sort by creation time.
 */
const SCHEMA_STATEMENTS = [
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
    status TEXT NOT NULL,
    transaction_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS settlement_intents_status_idx
     ON settlement_intents(status)`,
];

/**
 * Backwards scan that finds the highest stored `seq` for a mem-style
 * database. `node:sqlite` has no `MAX` primitive that returns the right
 * type across all builds, so we read a single scalar.
 */
const SELECT_MAX_SEQ = `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ledger_entries`;

/**
 * Insertion statement. Bigint `amount` travels as TEXT (decimal); see
 * `decodeRow` for the reverse trip.
 */
const INSERT_STATEMENT = `INSERT INTO ledger_entries (
  id, seq, timestamp, event, stream_id, session_public_key,
  chain_id, token, token_decimals,
  amount, nonce, transaction_hash,
  classification, corrects_entry_id, detail
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?
)`;

/**
 * Why the lookup method exists: `node:sqlite` does not support BigInt and
 * does not have a `prepared-all` parameter binding helper, so the
 * consumer-facing reads either inline a `prepare()` and walk rows, or
 * pull everything and filter in TypeScript. The store does the latter
 * for simplicity — the ledger is single-writer and low-volume (one entry
 * per payment event, never per call).
 */
const SELECT_ALL_ORDERED = `SELECT * FROM ledger_entries ORDER BY seq ASC`;

const INSERT_DELIVERY = `INSERT OR IGNORE INTO delivery_records (
  nonce, stream_id, sequence, data,
  seconds_delivered, units_delivered,
  accrued_unpaid, total_accrued,
  stream_ended, end_reason, recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_DELIVERY = `SELECT * FROM delivery_records WHERE nonce = ?`;

const SELECT_DELIVERY_NONCES = `SELECT nonce FROM delivery_records`;

const INSERT_INTENT = `INSERT OR IGNORE INTO settlement_intents (
  nonce, stream_id, session_public_key, chain_id, token, token_decimals,
  amount, payer, pay_to, deadline, status, transaction_hash, attempts,
  last_error, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_INTENT = `SELECT * FROM settlement_intents WHERE nonce = ?`;

const SELECT_INTENTS = `SELECT * FROM settlement_intents ORDER BY created_at ASC`;

const SELECT_INTENTS_BY_STATUS = `SELECT * FROM settlement_intents
  WHERE status = ? ORDER BY created_at ASC`;

const UPDATE_INTENT = `UPDATE settlement_intents
  SET status = ?, transaction_hash = ?, attempts = ?, last_error = ?, updated_at = ?
  WHERE nonce = ?`;

/**
 * Create a ledger store and run the schema.
 *
 * The schema statement set is idempotent; calling `open` against a
 * populated file does not touch existing rows.
 */
export function openLedgerStore(options: LedgerStoreOptions): LedgerStore {
  const storagePath = options.storagePath;
  if (storagePath !== ":memory:") {
    mkdirSync(dirname(resolve(storagePath)), { recursive: true });
  }

  const db = new DatabaseSync(
    storagePath === ":memory:" ? ":memory:" : storagePath,
    { enableForeignKeyConstraints: false },
  );

  // WAL mode trades a tiny amount of durability on crash for much better
  // concurrent read behaviour. The ledger is single-writer, but the
  // console (Group 7) reads it from a separate request, and Group 7
  // should not have to wait for a writer's commit to land.
  if (storagePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  return new LedgerStoreImpl(
    db,
    storagePath,
    options.clock ?? defaultClock,
    options.randomId ?? randomUUID,
  );
}

/**
 * Wall-clock default for `clock`. ISO-8601 UTC with milliseconds, which
 * is the shape every wire consumer reads `timestamp` as.
 */
function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

/**
 * The append-only ledger store contract.
 *
 * Methods return `Promise`s only where the schema would force it; the
 * actual implementation is synchronous and `Promise.resolve`-shortened
 * for callers that prefer to await. The shape is async so the boundary
 * this package presents to `apps/api` does not change when storage is
 * swapped (file-backed JSONL, remote) without a redesign.
 */
export interface LedgerStore {
  /** Append an entry. Returns the persisted row, including assigned `sequence` and `id`. */
  append(input: AppendInput): Promise<LedgerEntry>;

  /**
   * Return every entry in append order. Reads a snapshot at call time;
   * mutating the snapshot does not mutate the store.
   */
  entries(): Promise<LedgerEntry[]>;

  /** Number of stored entries. */
  size(): Promise<number>;

  /** Close the underlying connection. Idempotent. */
  close(): void;

  /**
   * Persist the exact segment payload for `nonce`. First write wins;
   * a later call with the same nonce is a no-op so the record stays
   * immutable.
   */
  putDelivery(record: DeliveryRecord): Promise<boolean>;

  /** Read the delivery record for `nonce`, or `null` if none exists. */
  getDelivery(nonce: string): Promise<DeliveryRecord | null>;

  /** Every nonce that has a persisted delivery payload. */
  listDeliveryNonces(): Promise<string[]>;

  /**
   * Insert a settlement intent. First write wins (later inserts are
   * ignored) so a crash retry cannot clobber an in-flight row.
   */
  putIntent(intent: SettlementIntent): Promise<boolean>;

  getIntent(nonce: string): Promise<SettlementIntent | null>;

  listIntents(status?: SettlementIntentStatus): Promise<SettlementIntent[]>;

  /** Patch status / tx hash / attempts. No-op when the nonce is unknown. */
  updateIntent(
    nonce: string,
    patch: SettlementIntentPatch,
  ): Promise<SettlementIntent | null>;
}

class LedgerStoreImpl implements LedgerStore {
  private maxCachedSeq: number | null = null;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly storagePath: string,
    private readonly clock: () => IsoTimestamp,
    private readonly randomId: () => string,
  ) {}

  async append(input: AppendInput): Promise<LedgerEntry> {
    if (this.closed) {
      throw new Error("ledger store is closed");
    }

    validateAppendInput(input);
    assertNoKeyMaterial(input as unknown as Record<string, unknown>);

    const sequence = this.nextSequence();
    const id = this.randomId();
    const timestamp = input.timestamp ?? this.clock();

    const row: LedgerRow = {
      id,
      seq: sequence,
      timestamp,
      event: input.event,
      stream_id: input.streamId,
      session_public_key: input.sessionPublicKey,
      chain_id: input.chainId,
      token: input.token,
      token_decimals: input.tokenDecimals,
      // bigint → decimal string; the smallest-unit shape is exact in
      // base 10 regardless of precision, so 2^53+ survives a round trip
      // without loss.
      amount:
        input.amount === null || input.amount === undefined
          ? null
          : input.amount.toString(10),
      nonce: input.nonce,
      transaction_hash: input.transactionHash,
      classification: input.classification,
      corrects_entry_id: input.correctsEntryId,
      detail: input.detail,
    };

    const stmt = this.db.prepare(INSERT_STATEMENT);
    stmt.run(
      row.id,
      row.seq,
      row.timestamp,
      row.event,
      row.stream_id,
      row.session_public_key,
      row.chain_id,
      row.token,
      row.token_decimals,
      row.amount,
      row.nonce,
      row.transaction_hash,
      row.classification,
      row.corrects_entry_id,
      row.detail,
    );

    return decodeRow(row);
  }

  async entries(): Promise<LedgerEntry[]> {
    this.assertOpen();
    const stmt = this.db.prepare(SELECT_ALL_ORDERED);
    const rows = stmt.all() as unknown as LedgerRow[];
    return rows.map(decodeRow);
  }

  async size(): Promise<number> {
    this.assertOpen();
    const stmt = this.db.prepare(SELECT_ALL_ORDERED);
    const rows = stmt.all() as unknown as LedgerRow[];
    return rows.length;
  }

  async putDelivery(record: DeliveryRecord): Promise<boolean> {
    this.assertOpen();
    if (!record.nonce) {
      throw new TypeError("delivery nonce must be a non-empty string");
    }
    assertNoKeyMaterial({
      nonce: record.nonce,
      streamId: record.payload.streamId,
      endReason: record.payload.endReason,
    });
    const existing = this.db.prepare(SELECT_DELIVERY).get(record.nonce);
    if (existing !== undefined) return false;
    const row = encodeDeliveryRecord({
      ...record,
      recordedAt: record.recordedAt || this.clock(),
    });
    this.db
      .prepare(INSERT_DELIVERY)
      .run(
        row.nonce,
        row.stream_id,
        row.sequence,
        row.data,
        row.seconds_delivered,
        row.units_delivered,
        row.accrued_unpaid,
        row.total_accrued,
        row.stream_ended,
        row.end_reason,
        row.recorded_at,
      );
    return true;
  }

  async getDelivery(nonce: string): Promise<DeliveryRecord | null> {
    this.assertOpen();
    if (!nonce) {
      throw new TypeError("delivery nonce must be a non-empty string");
    }
    const stmt = this.db.prepare(SELECT_DELIVERY);
    const row = stmt.get(nonce) as DeliveryRow | undefined;
    return row === undefined ? null : decodeDeliveryRow(row);
  }

  async listDeliveryNonces(): Promise<string[]> {
    this.assertOpen();
    const rows = this.db.prepare(SELECT_DELIVERY_NONCES).all() as {
      nonce: string;
    }[];
    return rows.map((row) => row.nonce);
  }

  async putIntent(intent: SettlementIntent): Promise<boolean> {
    this.assertOpen();
    if (!intent.nonce) {
      throw new TypeError("intent nonce must be a non-empty string");
    }
    assertNoKeyMaterial({
      nonce: intent.nonce,
      streamId: intent.streamId,
      payer: intent.payer,
      payTo: intent.payTo,
    });
    const existing = this.db.prepare(SELECT_INTENT).get(intent.nonce);
    if (existing !== undefined) return false;
    const now = this.clock();
    const row = encodeSettlementIntent({
      ...intent,
      createdAt: intent.createdAt || now,
      updatedAt: intent.updatedAt || now,
    });
    this.db
      .prepare(INSERT_INTENT)
      .run(
        row.nonce,
        row.stream_id,
        row.session_public_key,
        row.chain_id,
        row.token,
        row.token_decimals,
        row.amount,
        row.payer,
        row.pay_to,
        row.deadline,
        row.status,
        row.transaction_hash,
        row.attempts,
        row.last_error,
        row.created_at,
        row.updated_at,
      );
    return true;
  }

  async getIntent(nonce: string): Promise<SettlementIntent | null> {
    this.assertOpen();
    if (!nonce) {
      throw new TypeError("intent nonce must be a non-empty string");
    }
    const row = this.db.prepare(SELECT_INTENT).get(nonce) as
      SettlementIntentRow | undefined;
    return row === undefined ? null : decodeSettlementIntentRow(row);
  }

  async listIntents(
    status?: SettlementIntentStatus,
  ): Promise<SettlementIntent[]> {
    this.assertOpen();
    const rows = (
      status === undefined
        ? this.db.prepare(SELECT_INTENTS).all()
        : this.db.prepare(SELECT_INTENTS_BY_STATUS).all(status)
    ) as SettlementIntentRow[];
    return rows.map(decodeSettlementIntentRow);
  }

  async updateIntent(
    nonce: string,
    patch: SettlementIntentPatch,
  ): Promise<SettlementIntent | null> {
    this.assertOpen();
    const current = await this.getIntent(nonce);
    if (current === null) return null;
    const next: SettlementIntent = {
      ...current,
      status: patch.status ?? current.status,
      transactionHash:
        patch.transactionHash === undefined
          ? current.transactionHash
          : patch.transactionHash,
      attempts: patch.attempts ?? current.attempts,
      lastError:
        patch.lastError === undefined ? current.lastError : patch.lastError,
      updatedAt: this.clock(),
    };
    const row = encodeSettlementIntent(next);
    this.db
      .prepare(UPDATE_INTENT)
      .run(
        row.status,
        row.transaction_hash,
        row.attempts,
        row.last_error,
        row.updated_at,
        row.nonce,
      );
    return next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // already closed; nothing meaningful to do.
    }
  }

  /**
   * Compute the next `seq` value. Cached after the first read so a long
   * append session does not keep hitting the index.
   */
  private nextSequence(): number {
    if (this.maxCachedSeq === null) {
      const stmt = this.db.prepare(SELECT_MAX_SEQ);
      const row = stmt.get() as { max_seq: number } | undefined;
      this.maxCachedSeq = row?.max_seq ?? 0;
    }
    this.maxCachedSeq += 1;
    return this.maxCachedSeq;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("ledger store is closed");
    }
  }
}

/**
 * Decode a persisted row into the wire shape.
 *
 * The `amount` column is a decimal string; this function parses it back
 * into `bigint`. `BigInt(row.amount)` accepts any precision in `string`
 * form, so a `50n * 10n ** 18n` round-trip is exact.
 */
function decodeRow(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    sequence: row.seq,
    timestamp: row.timestamp,
    event: row.event as LedgerEventType,
    streamId: row.stream_id,
    sessionPublicKey: row.session_public_key as Hex | null,
    chainId: row.chain_id,
    token: row.token as Address,
    tokenDecimals: row.token_decimals,
    amount:
      row.amount === null || row.amount === undefined
        ? null
        : (BigInt(row.amount) as SmallestUnits),
    nonce: row.nonce,
    transactionHash: row.transaction_hash as Hex | null,
    classification: row.classification as PaymentFailureClassification | null,
    correctsEntryId: row.corrects_entry_id,
    detail: row.detail,
  };
}

/**
 * Reject inputs that would corrupt the wire shape *before* they reach
 * SQLite — checks that are easy to write in TypeScript and impossible to
 * express in SQL, like "an address must start with `0x`".
 *
 * `assertNoKeyMaterial` (the bigger guard) runs separately and throws a
 * different error so callers can tell policy violations from shape bugs.
 */
function validateAppendInput(input: AppendInput): void {
  if (input.streamId !== null && typeof input.streamId !== "string") {
    throw new TypeError("streamId must be a string or null");
  }
  if (input.sessionPublicKey !== null && !isHex(input.sessionPublicKey)) {
    throw new TypeError(
      "sessionPublicKey must be a 0x-prefixed hex string or null",
    );
  }
  if (!isHex(input.token)) {
    throw new TypeError("token must be a 0x-prefixed hex address");
  }
  if (!Number.isInteger(input.tokenDecimals) || input.tokenDecimals < 0) {
    throw new TypeError("tokenDecimals must be a non-negative integer");
  }
  if (!Number.isInteger(input.chainId)) {
    throw new TypeError("chainId must be an integer");
  }
  if (input.amount !== null && typeof input.amount !== "bigint") {
    throw new TypeError("amount must be a bigint or null");
  }
  if (input.transactionHash !== null && input.transactionHash !== undefined) {
    if (!isHex(input.transactionHash)) {
      throw new TypeError(
        "transactionHash must be a 0x-prefixed hex string or null",
      );
    }
    // The hash is exactly 32 bytes when a settlement has been submitted;
    // an early-stage entry may carry a zero-length `0x` placeholder or
    // be null. We accept anything that is `0x`-prefixed so partial
    // events do not require a second event type to clear this check.
    if (
      input.transactionHash.length !== 2 &&
      input.transactionHash.length !== 66
    ) {
      throw new TypeError(
        "transactionHash must be either `0x` (unspecified) or `0x` + 64 hex (32-byte hash)",
      );
    }
  }
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Remove every ledger artifact under `storagePath`. Intended for tests and
 * operator scripts; never call from request handlers.
 *
 * SQLite opens three files when WAL is on (`<path>`, `<path>-wal`,
 * `<path>-shm`); unlinking just the main file leaves the others behind.
 * Tolerate missing files — the contract is "the path looks like a fresh
 * ledger", not "the path existed".
 */
export function resetLedgerStorage(storagePath: string): void {
  if (storagePath === ":memory:") return;
  const resolved = resolve(storagePath);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const filePath = `${resolved}${suffix}`;
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // a held file handle on Windows can race with the unlink; the
        // next store open will reuse the file intact.
      }
    }
  }
}

/**
 * Recursively list `.ledger.db*` files under a directory. Used by the
 * test cleanup helpers — production code never walks a directory tree.
 */
export function findLedgerFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(`${current}/${entry}`);
      }
    } else if (/\.ledger\.db(-wal|-shm|-journal)?$/.test(current)) {
      out.push(current);
    }
  }
  return out;
}

/**
 * Convenience for tests: re-export the guard error so callers do not
 * have to dig into `./secrets.js` to do error-equality.
 */
export { KeyMaterialRejectedError };
