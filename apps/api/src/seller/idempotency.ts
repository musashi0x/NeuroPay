/**
 * Nonce-keyed idempotency (5.7).
 *
 * Every accepted envelope is recorded under its authorization nonce
 * before delivery; a re-presentation of the same nonce returns the same
 * segment without accruing additional cost. This is critical because the
 * buyer may legitimately retry a timed-out request — the signature is
 * already given and a second delivery would double-charge (or, worse,
 * deliver twice for the price of one).
 *
 * We delegate the lookup to `@neuro-pay/ledger.isNonceAlreadyVerified`
 * so the contract is in one place. The `IdempotencyRecord` we hand back
 * the caller carries enough context to return the same shape on replay
 * without re-reading the meter.
 */

import {
  isNonceAlreadyVerified,
  type DeliveryRecord,
  type LedgerStore,
  type SegmentDeliveredInput,
  type PaymentVerifiedInput,
} from "@neuro-pay/ledger";
import type {
  IsoTimestamp,
  LedgerEntry,
  SegmentResponse,
  SmallestUnits,
  StreamEndReason,
} from "@neuro-pay/types";

/**
 * The stored segment that a replay must echo back. We deliberately
 * persist only what is needed to reconstruct the segment response — no
 * bigint arithmetic is re-run, so the segment response is byte-equal to
 * the original.
 */
export type IdempotencyRecord = {
  nonce: string;
  streamId: string;
  sequence: number;
  data: string;
  secondsDelivered: number;
  unitsDelivered: number;
  accruedUnpaid: SmallestUnits;
  totalAccrued: SmallestUnits;
  streamEnded: boolean;
  endReason: StreamEndReason | null;
  /** Carried separately so the read path doesn't need a clock dependency. */
  ledgerEntryId: string;
  ledgerTimestamp: IsoTimestamp;
};

/**
 * The idempotency index the seller maintains in front of the ledger.
 * Splitting this from the ledger makes the replay path cheap (a single
 * `Map.get`) while the ledger remains the durable system of record.
 */
export type IdempotencyIndex = {
  /** Read the stored record for `nonce`, if any. */
  get(nonce: string): IdempotencyRecord | null;
  /** Store a record. Idempotent: storing twice is a no-op for the same nonce. */
  put(record: IdempotencyRecord): void;
  /** Forget every nonce (for tests and stream-end-on-expiry). */
  clear(): void;
  /** Read every nonce currently tracked. */
  list(): IdempotencyRecord[];
};

export function createIdempotencyIndex(): IdempotencyIndex {
  const map = new Map<string, IdempotencyRecord>();
  return {
    get(nonce) {
      return map.get(nonce) ?? null;
    },
    put(record) {
      // `put` overwrites the existing record: the verify-and-deliver flow
      // writes the verification row first (with placeholder segment data)
      // then writes the actual segment-delivered shape. The caller controls
      // the lifecycle, so the index just mirrors the latest write.
      map.set(record.nonce, record);
    },
    clear() {
      map.clear();
    },
    list() {
      return Array.from(map.values());
    },
  };
}

/**
 * Inputs to recording a verified envelope. The seller calls this on the
 * first accept and never on a replay — replay reads the existing record.
 */
export type RecordVerificationInput = {
  store: LedgerStore;
  index: IdempotencyIndex;
  nonce: string;
  streamId: string;
  sessionPublicKey: import("@neuro-pay/types").Hex | null;
  chainId: number;
  token: import("@neuro-pay/types").Address;
  tokenDecimals: number;
  /**
   * The amount the buyer authorized — distinct from the demanded amount,
   * which is what the verifier enforced as a minimum.
   */
  authorizedAmount: SmallestUnits;
};

export type RecordVerificationResult =
  | { kind: "recorded"; record: IdempotencyRecord; entry: LedgerEntry }
  | { kind: "duplicate"; record: IdempotencyRecord };

/**
 * Record a verification, returning the idempotency record.
 *
 * Steps:
 *  1. Check the ledger for prior verification under this nonce. If found,
 *     return `{ kind: "duplicate" }` with the existing record so the
 *     route serves the stored segment and skips new accrual.
 *  2. Otherwise, record a `payment.verified` event under the nonce and
 *     place an empty `IdempotencyRecord` in the in-memory index.
 *
 * `segment` is optional: a verify-and-deliver flow fills it in; a
 * verify-only or pre-pay flow leaves `sequence = 0`.
 */
export async function recordVerification(
  input: RecordVerificationInput,
  segment?: {
    sequence: number;
    data: string;
    secondsDelivered: number;
    unitsDelivered: number;
  },
): Promise<RecordVerificationResult> {
  // We split the work into a verification write first, so the
  // ledger is the durable source of truth; the in-memory index is a
  // fast read path that can be rebuilt from the ledger at any time.
  const existing = await isNonceAlreadyVerified(input.store, input.nonce);
  if (existing) {
    const prior = await loadIdempotencyRecord(
      input.store,
      input.index,
      input.nonce,
    );
    if (prior) return { kind: "duplicate", record: prior };
    return {
      kind: "duplicate",
      record: emptyRecord(input.nonce, input.streamId),
    };
  }

  const verificationInput: PaymentVerifiedInput = {
    store: input.store,
    ctx: {
      streamId: input.streamId,
      sessionPublicKey: input.sessionPublicKey,
      chainId: input.chainId,
      token: input.token,
      tokenDecimals: input.tokenDecimals,
    },
    amount: input.authorizedAmount,
    nonce: input.nonce,
  };

  const event = await import("@neuro-pay/ledger").then((m) =>
    m.recordPaymentVerified(verificationInput),
  );

  const record: IdempotencyRecord = {
    nonce: input.nonce,
    streamId: input.streamId,
    sequence: segment?.sequence ?? 0,
    data: segment?.data ?? "",
    secondsDelivered: segment?.secondsDelivered ?? 0,
    unitsDelivered: segment?.unitsDelivered ?? 0,
    accruedUnpaid: 0n,
    totalAccrued: 0n,
    streamEnded: false,
    endReason: null,
    ledgerEntryId: event.id,
    ledgerTimestamp: event.timestamp,
  };
  input.index.put(record);
  void segment; // segment is mutable; the record above captures a snapshot.

  return { kind: "recorded", record, entry: event };
}

/**
 * After delivery, attach the `segment.delivered` entry to the existing
 * verification record. The ledger row records actual delivered figures
 * so an auditor can reconcile against the price sheet.
 */
export async function recordSegmentDelivery(input: {
  store: LedgerStore;
  index: IdempotencyIndex;
  nonce: string;
  segment: SegmentResponse;
  sessionPublicKey: import("@neuro-pay/types").Hex | null;
  chainId: number;
  token: import("@neuro-pay/types").Address;
  tokenDecimals: number;
  authorizedAmount: SmallestUnits;
}): Promise<LedgerEntry> {
  const args: SegmentDeliveredInput = {
    store: input.store,
    ctx: {
      streamId: input.segment.streamId,
      sessionPublicKey: input.sessionPublicKey,
      chainId: input.chainId,
      token: input.token,
      tokenDecimals: input.tokenDecimals,
    },
    amount: input.authorizedAmount,
    nonce: input.nonce,
    secondsDelivered: input.segment.secondsDelivered,
    unitsDelivered: input.segment.unitsDelivered,
  };
  const entry = await import("@neuro-pay/ledger").then((m) =>
    m.recordSegmentDelivered(args),
  );

  const record: IdempotencyRecord = {
    nonce: input.nonce,
    streamId: input.segment.streamId,
    sequence: input.segment.sequence,
    data: input.segment.data,
    secondsDelivered: input.segment.secondsDelivered,
    unitsDelivered: input.segment.unitsDelivered,
    accruedUnpaid: input.segment.accruedUnpaid,
    totalAccrued: input.segment.totalAccrued,
    streamEnded: input.segment.streamEnded,
    endReason: input.segment.endReason,
    ledgerEntryId: entry.id,
    ledgerTimestamp: entry.timestamp,
  };
  input.index.put(record);
  await input.store.putDelivery({
    nonce: input.nonce,
    payload: input.segment,
    recordedAt: entry.timestamp,
  });
  return entry;
}

/**
 * Build the segment response for a replay from the stored record.
 *
 * The amounts and totals come from the ledger's authoritative entries;
 * the route layer doesn't need to ask the meter module on a replay.
 */
export function buildReplayResponse(
  nonce: string,
  record: IdempotencyRecord,
): SegmentResponse {
  void nonce;
  return {
    streamId: record.streamId,
    sequence: record.sequence,
    data: record.data,
    secondsDelivered: record.secondsDelivered,
    unitsDelivered: record.unitsDelivered,
    accruedUnpaid: record.accruedUnpaid,
    totalAccrued: record.totalAccrued,
    streamEnded: record.streamEnded,
    endReason: record.endReason,
  };
}

export async function loadIdempotencyRecord(
  store: LedgerStore,
  index: IdempotencyIndex,
  nonce: string,
): Promise<IdempotencyRecord | null> {
  const stored = await store.getDelivery(nonce);
  if (stored !== null) {
    const record = recordFromDelivery(stored);
    index.put(record);
    return record;
  }
  return index.get(nonce);
}

function recordFromDelivery(stored: DeliveryRecord): IdempotencyRecord {
  return {
    nonce: stored.nonce,
    streamId: stored.payload.streamId,
    sequence: stored.payload.sequence,
    data: stored.payload.data,
    secondsDelivered: stored.payload.secondsDelivered,
    unitsDelivered: stored.payload.unitsDelivered,
    accruedUnpaid: stored.payload.accruedUnpaid,
    totalAccrued: stored.payload.totalAccrued,
    streamEnded: stored.payload.streamEnded,
    endReason: stored.payload.endReason,
    ledgerEntryId: stored.nonce,
    ledgerTimestamp: stored.recordedAt,
  };
}

function emptyRecord(nonce: string, streamId: string): IdempotencyRecord {
  return {
    nonce,
    streamId,
    sequence: 0,
    data: "",
    secondsDelivered: 0,
    unitsDelivered: 0,
    accruedUnpaid: 0n,
    totalAccrued: 0n,
    streamEnded: false,
    endReason: null,
    ledgerEntryId: "",
    ledgerTimestamp: new Date(0).toISOString(),
  };
}
