# `@neuro-pay/ledger`

Append-only payment ledger for the x402 metered-payment loop.

The ledger records every payment-relevant event in append order and
serves three reads:

- **lookup-by-nonce** — reconcile one payment's verification, delivery,
  and settlement lifecycle into a single view;
- **window-spend** — derive the rolling per-session, per-token spend so a
  buyer can refuse to sign before either the local budget or the
  on-chain `spend.limit` is breached;
- **unsettled-exposure** — sum delivered-but-unsettled work so the seller
  can cap it against `maxInFlightSettlements × settlementThreshold`.

Entries are never updated or deleted. A correction is a new entry
referencing the original; aggregations overlay the corrections before
summing, so a wrong amount or a wrong classification is fixed without
losing the original.

This package never carries private key material. The write helpers run
a shape-based secret guard on every string field — a 64-hex-digit run, a
BIP-39-shaped mnemonic, or a labelled secret — and refuse to append the
entry with `KeyMaterialRejectedError`.

## Persistence: `node:sqlite`

Choice order from the spec, in priority: `better-sqlite3`, `node:sqlite`,
file-backed JSONL. We picked **`node:sqlite`**.

Rationale:

- **No native build.** `better-sqlite3` ships a prebuilt binary per
  Node minor and a fallback `node-gyp` build that has failed CI in
  every project I have owned that depended on it. `node:sqlite` is a
  Node 22+ built-in and the CI already pins Node 22.
- **Synchronous, in-process, single-writer.** The agent process is one
  writer. The console (Group 7) reads from a separate request and
  benefits from WAL's concurrent-read semantics, but the _write_ path
  is single-threaded and the synchronous API matches that.
- **SQL persistence means durability is free.** Group 9 runs the loop
  against chain 97, restarts the API between runs, and expects to find
  the trail on disk. SQLite WAL is the smallest dependency that gives
  us atomic commits.
- **JSONL was the fallback for a reason.** It gives correct ordering
  on append but no transactionality, no `ORDER BY seq` query plan, and
  no in-place schema migration. We are keeping it as the
  "degraded mode" if a Node 22 host ever falls back to a Node 18 image
  — drop in `./store.ts` later, the surface is unchanged.

The schema is in `src/store.ts` (`SCHEMA_STATEMENTS`). `seq` is a
separate column from `id`, so replays are independent of UUID ordering.
`amount` is stored as a decimal TEXT — base 10 is exact regardless of
precision, so `50n * 10n ** 18n` and `2n ** 64n` round-trip without
loss.

The same database also holds `delivery_records`: immutable segment
payloads keyed by authorization nonce (`putDelivery` / `getDelivery`).
First write wins. Accrued amounts travel as decimal TEXT like ledger
`amount`.

`settlement_intents` is the operational outbox (pending / submitted /
confirmed / failed). Status is updated in place; the append-only event
log remains the audit trail.

Stream close and settlement recovery also write `stream.ended`,
`stream.abandoned`, `settlement.retry`, and `settlement.recovered`.

## API surface

```ts
// Open.
import { openLedgerStore } from "@neuro-pay/ledger";
const store = await openLedgerStore({
  storagePath: "/var/lib/neuro-pay/payments.ledger.db",
});

// Write.
import {
  recordPaymentDemanded,
  recordSettlementConfirmed,
} from "@neuro-pay/ledger";
await recordPaymentDemanded({ store, ctx, amount: 1000n, nonce: "0x01" });
await recordSettlementConfirmed({
  store,
  ctx,
  amount: 1000n,
  nonce: "0x01",
  transactionHash: "0x…",
});

// Read.
import {
  lookupByNonce,
  computeWindowSpend,
  computeUnsettledExposure,
} from "@neuro-pay/ledger";
const life = await lookupByNonce(store, "0x01");
const spend = await computeWindowSpend(store, {
  sessionPublicKey,
  token,
  onChainCap: 10n ** 24n,
  budgetMarginFraction: 8n * 10n ** 17n,
  nowMs: Date.now(),
  periodMs: 86_400_000,
});
const exposure = await computeUnsettledExposure(store);
```

## Constraints enforced by the write helpers

- `token`, `chainId`, `tokenDecimals`, and `sessionPublicKey` are
  required on every stream-scoped event; missing or malformed values
  throw before the entry reaches the store.
- `transactionHash` must be either `0x` (a placeholder for an unsettled
  state) or `0x` + 64 hex (a 32-byte hash); other shapes are rejected.
- `amount` is `bigint` or `null`; a float that lost precision becomes a
  type error rather than a silently-corrupted value on disk.
- `streamId`, `nonce`, `transactionHash`, `detail` are scanned by
  `detectKeyMaterial` before insertion; a write that matches a 64-hex
  shape, a BIP-39 mnemonic, or a labelled secret is refused with
  `KeyMaterialRejectedError`.

## Corrections

A correction appends a new entry whose `correctsEntryId` is the `id` of
the original. The aggregations (`computeWindowSpend`,
`computeUnsettledExposure`) resolve every family of entries that share a
logical id (the corrected entry's `correctsEntryId ?? id`) to the
highest-sequence member, so a correction shadows the original without
overwriting it. `lookupByNonce` returns the _raw_ entries, so an auditor
sees both the original and the correction side by side.

## Schema versioning and migrations

The schema is an ordered, append-only list of numbered migrations in
`src/migrations.ts`. Opening a store runs every pending one inside a
single transaction, stamps `PRAGMA user_version`, and records what was
applied in `schema_migrations`.

Three properties are worth knowing:

- **A file from a newer build is refused.** Opening a ledger whose
  `user_version` is ahead of the code throws `LedgerSchemaVersionError`
  rather than proceeding. An older binary appending rows shaped by an
  older understanding of the schema, into a file a newer one is also
  writing, is a corruption path with no automatic recovery — so it is
  fatal at open, where the operator can still choose.
- **A legacy file upgrades in place.** Every migration is idempotent, so
  a ledger written before versioning existed (`user_version = 0`, tables
  already present) is brought current by replaying the whole list. There
  is no export/import step.
- **The run is atomic.** A migration list that fails halfway rolls back
  entirely; the file stays at the version it was, rather than in a state
  no version number describes.

Migrations are additive by rule: create tables, create indexes, add
columns. A published version number is never edited or renumbered — a
mistake is corrected by a new migration on top. Destructive changes need
a new table plus a copy, written as their own migration.

`store.schemaInfo()` reports the file's version, the version this build
supports, and every recorded migration. The API's readiness probe reads
it, so a version mismatch shows up in `/v1/health` rather than as a
confusing insert failure.

## The audit trail

`audit_events` is a second append-only table in the same file, holding
administrative actions: who invoked the kill switch, when a price sheet
changed, what configuration the process booted with. It is separate from
`ledger_entries` because every ledger row carries a chain, a token, and
decimals — every row is a fact about money — and "an operator revoked the
session at 14:02" has none of those. Forcing it into that shape would
mean inventing values that later aggregations would sum over.

It keeps the same three guarantees: append-only, independently ordered by
`seq`, and guarded by `assertNoKeyMaterial` on the write path. A record
with no actor is refused — a trail you cannot attribute is not an audit
trail.

## Backup, restore, and recovery

The ledger is the durable record of every payment-relevant event. It is
also a single SQLite file, which makes all of this simpler than it
sounds — and makes the one wrong way to do it worth naming.

### Taking a backup

Use SQLite's own backup, not `cp`. WAL mode means the `.db` file alone is
an incomplete picture: copying it while the process is running captures a
torn state that may be missing the most recent commits, and `cp`-ing the
three files (`.db`, `-wal`, `-shm`) separately captures them at three
different instants.

```bash
sqlite3 .data/ledger.sqlite ".backup '/backups/ledger-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
```

`.backup` takes a consistent snapshot of a live database without stopping
the writer. Verify every backup you take — an unverified backup is a
belief, not a backup:

```bash
sqlite3 /backups/ledger-20260820T120000Z.sqlite "PRAGMA integrity_check; PRAGMA user_version;"
```

`integrity_check` must print `ok`, and `user_version` tells you which
build can open it. Record that number: restoring a version-3 file onto a
build that only knows version 2 is exactly the case the schema guard
refuses.

Back up at least as often as you would be willing to re-derive from
chain: the settlement transactions themselves are on chain and
recoverable, but delivery records, refusal classifications, and the audit
trail exist nowhere else.

### Restoring

1. Stop the API process. SQLite is single-writer and restoring underneath
   a live one produces a file neither process agrees about.
2. Move the current files aside rather than deleting them — including
   `-wal` and `-shm`. A ledger that looks corrupt is often recoverable,
   and it is the only copy of the events since the last backup.
   ```bash
   mkdir -p .data/quarantine
   mv .data/ledger.sqlite* .data/quarantine/
   ```
3. Copy the backup into place as `LEDGER_PATH`.
4. Start the process. Migrations run automatically; the boot log reports
   any that were applied.
5. Reconcile. A restored ledger is behind the chain: settlements
   submitted after the backup exist on chain and not in the file. See
   `docs/runbooks/settlement-reconciliation.md` — startup reconciliation
   runs on its own, and the report names deliveries with no intent.

### Suspected corruption

```bash
sqlite3 .data/ledger.sqlite "PRAGMA integrity_check;"
```

If it prints anything but `ok`, do not keep writing to the file. Stop the
process first, then try to salvage the readable rows into a fresh
database before falling back to a backup:

```bash
sqlite3 .data/ledger.sqlite ".recover" | sqlite3 .data/ledger-recovered.sqlite
sqlite3 .data/ledger-recovered.sqlite "PRAGMA integrity_check;"
```

`.recover` reads what it can from the raw pages and is usually a better
outcome than a backup, because it loses nothing that is still readable.
Compare `SELECT MAX(seq) FROM ledger_entries` between the recovered file
and your most recent backup to see which is further ahead, then treat the
winner as the new ledger and follow the restore steps from step 3.

The append-only design is what makes this tractable: no row is ever
rewritten, so a partially-recovered ledger is a _prefix_ of the truth
rather than a mixture of old and new states.

### Retention

Keep everything. The ledger grows by one row per payment event — not per
call — so a busy stream produces a few rows a minute, and the file stays
small enough that pruning costs more than it saves. Every derived number
the system reports (window spend, unsettled exposure, settlement latency,
failure counts) is recomputed from the full trail on read, so deleting
old rows silently changes those answers rather than merely freeing space.

If a retention policy is imposed from outside, export before pruning and
keep the export for as long as the payments it describes could be
disputed. Prune by copying the rows you keep into a fresh database rather
than issuing `DELETE` against the live one — the schema has no delete
path, and adding one would weaken the guarantee that makes the trail
worth trusting.
