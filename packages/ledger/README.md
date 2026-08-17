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
