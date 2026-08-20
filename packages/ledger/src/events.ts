/**
 * Typed write helpers for every event the ledger knows about.
 *
 * These are the *only* way to persist an entry: they enforce the field
 * set for an event type (e.g. a settlement carries a nonce, a refusal
 * carries a classification, an accrual carries an amount) and they run
 * the secret-key guard from `./secrets.js` on every call so a caller
 * cannot accidentally persist a session signer.
 *
 * The shape returned by every helper is the `LedgerEntry` wire type,
 * which means the helpers are also a convenient way to *build* test
 * fixtures without duplicating field defaults.
 */

import type {
  Address,
  Hex,
  LedgerEntry,
  LedgerEventType,
  PaymentFailureClassification,
  SmallestUnits,
} from "@neuro-pay/types";

import type { AppendInput, LedgerStore } from "./store.js";

/**
 * Inputs that are constant across every event in a stream: chain, token,
 * decimals, and the session that owns the stream.
 *
 * Bundled so each helper takes the per-event fields only and never lets
 * a stream-scoped entry forget its token or chain.
 */
export type EventContext = {
  streamId: string;
  sessionPublicKey: Hex | null;
  chainId: number;
  token: Address;
  tokenDecimals: number;
};

/**
 * Common shape returned by every helper. Just a `LedgerEntry`; aliased
 * so consumers can write `EventResult` instead of `LedgerEntry` when
 * they only ever hold *freshly written* entries.
 */
export type EventResult = LedgerEntry;

/**
 * Inputs shared by every helper: the store to write through and the
 * contextual fields that bind an entry to its stream and token.
 */
type WriteInput = {
  store: LedgerStore;
  ctx: EventContext;
  /**
   * Override for the ledger timestamp. Defaults to whatever clock the
   * store was constructed with.
   */
  timestamp?: string;
  /**
   * Free-form operator detail, persisted for the console. Never carries
   * key material — the secret guard rejects strings that look like
   * private keys or mnemonics.
   */
  detail?: string | null;
};

/** A payment session is created and its on-chain tx is recorded. */
export type SessionGrantedInput = {
  store: LedgerStore;
  sessionPublicKey: Hex;
  transactionHash: Hex;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  detail?: string | null;
  timestamp?: string;
};

/** A payment session is revoked locally and/or on-chain. */
export type SessionRevokedInput = {
  store: LedgerStore;
  sessionPublicKey: Hex;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /** Two-stage outcome: `local`, `on-chain`, or both. */
  stage: "local" | "on-chain" | "both";
  transactionHash?: Hex | null;
  detail?: string | null;
  timestamp?: string;
};

/** A stream was opened against a pinned price sheet. */
export type StreamOpenedInput = WriteInput & {
  /** Initial spent/in-flight amount, if the policy charges an opening fee. */
  amount?: SmallestUnits | null;
};

/** A stream ended; records the reason so reconciliation can audit it. */
export type StreamEndedInput = WriteInput & {
  reason: string;
  /** Total amount that delivered into this stream, for a one-shot rollup. */
  amount?: SmallestUnits | null;
};

/**
 * Accrual recorded. Fired regularly (every tick or every delivered unit)
 * to keep the running total queryable from the ledger.
 *
 * The aggregate "spent this stream" is the sum of `accrual.recorded`
 * minus the sum of *corrections*; an entry that records the wrong amount
 * is fixed by a later entry that names the wrong one. The raw stream
 * preserves the original so audits can compare.
 */
export type AccrualRecordedInput = WriteInput & {
  amount: SmallestUnits;
};

/**
 * A `402` was emitted asking the buyer to pay an amount. The amount is
 * in smallest units of the configured token; the nonce is the *next*
 * nonce the buyer's envelope will carry.
 */
export type PaymentDemandedInput = WriteInput & {
  amount: SmallestUnits;
  /** The nonce the seller expects the next envelope to use. */
  nonce: string;
};

/**
 * The buyer signed an envelope. Persisted before settlement so a
 * settlement-submitted entry later has somewhere to point.
 */
export type PaymentSignedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
};

/**
 * The buyer refused to sign. Always carries the classification the
 * payment client assigned.
 */
export type PaymentRefusedInput = WriteInput & {
  amount: SmallestUnits;
  classification: PaymentFailureClassification;
  detail?: string | null;
  timestamp?: string;
};

/**
 * The seller's verifier accepted the envelope. Persisted before
 * delivery so the lookup-by-nonce function knows verification happened.
 */
export type PaymentVerifiedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
};

/**
 * The seller's verifier rejected the envelope. Carries the
 * classification the verifier assigned.
 */
export type PaymentRejectedInput = WriteInput & {
  amount: SmallestUnits | null;
  /**
   * The authorization nonce, when there is one.
   *
   * `null` is a real case, not a shortcut: an envelope rejected for a
   * malformed header or a revoked session is refused *before* a nonce
   * can be parsed out of it. Writing a placeholder would put a nonce
   * into `lookupByNonce`'s index that no buyer ever sent, so the absence
   * is recorded honestly instead.
   */
  nonce: string | null;
  classification: PaymentFailureClassification;
  detail?: string | null;
  timestamp?: string;
};

/**
 * A bounded chunk of work was delivered against a paid nonce. Carries
 * the actual seconds and units delivered so the auditor can reconcile
 * against the price sheet.
 */
export type SegmentDeliveredInput = WriteInput & {
  amount: SmallestUnits;
  /**
   * The authorization nonce, when the segment was paid for.
   *
   * `null` is the threshold-or-tick model working as designed: the
   * seller delivers on credit until `accruedUnpaid` reaches the
   * settlement threshold, and those deliveries carry no payment and so
   * no nonce. Recording them is what makes the accrual auditable — the
   * demand that eventually fires has to be reconcilable against the
   * segments that produced it.
   */
  nonce: string | null;
  secondsDelivered: number;
  unitsDelivered: number;
};

/**
 * A settlement transaction was submitted to chain. Records the tx hash
 * and the nonce it was submitted under.
 */
export type SettlementSubmittedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  transactionHash: Hex;
};

/** A settlement transaction confirmed on chain. */
export type SettlementConfirmedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  transactionHash: Hex;
};

/** A settlement transaction reverted or otherwise failed. */
export type SettlementFailedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  classification: PaymentFailureClassification;
  transactionHash?: Hex | null;
  detail?: string | null;
  timestamp?: string;
};

/**
 * Build the common `AppendInput` for a stream/event pair. Kept as one
 * private helper so every event goes through the same field-construction
 * path, which makes it impossible to ship an event with a stale
 * stream/session attribution.
 */
function baseInput(
  event: LedgerEventType,
  input: WriteInput,
  overrides: Partial<AppendInput> = {},
): AppendInput {
  const result: AppendInput = {
    event,
    streamId: input.ctx.streamId,
    sessionPublicKey: input.ctx.sessionPublicKey,
    chainId: input.ctx.chainId,
    token: input.ctx.token,
    tokenDecimals: input.ctx.tokenDecimals,
    amount: null,
    nonce: null,
    transactionHash: null,
    classification: null,
    correctsEntryId: null,
    detail: input.detail ?? null,
    ...overrides,
  };
  // `AppendInput` marks `timestamp` as optional under
  // `exactOptionalPropertyTypes`, which forbids assigning `undefined`.
  // Spread `timestamp` only when the caller actually supplied one.
  if (input.timestamp !== undefined) {
    result.timestamp = input.timestamp;
  }
  return result;
}

/** Record a `session.granted` event. */
export async function recordSessionGranted(
  input: SessionGrantedInput,
): Promise<EventResult> {
  const base: AppendInput = {
    event: "session.granted",
    streamId: null,
    sessionPublicKey: input.sessionPublicKey,
    chainId: input.chainId,
    token: input.token,
    tokenDecimals: input.tokenDecimals,
    amount: null,
    nonce: null,
    transactionHash: input.transactionHash,
    classification: null,
    correctsEntryId: null,
    detail: input.detail ?? null,
  };
  return input.store.append(
    input.timestamp === undefined
      ? base
      : { ...base, timestamp: input.timestamp },
  );
}

/** Record a `session.revoked` event. The `stage` is encoded in the detail. */
export async function recordSessionRevoked(
  input: SessionRevokedInput,
): Promise<EventResult> {
  const detail =
    input.detail ?? `session revocation stage=${input.stage}`.trim();
  const base: AppendInput = {
    event: "session.revoked",
    streamId: null,
    sessionPublicKey: input.sessionPublicKey,
    chainId: input.chainId,
    token: input.token,
    tokenDecimals: input.tokenDecimals,
    amount: null,
    nonce: null,
    transactionHash: input.transactionHash ?? null,
    classification: null,
    correctsEntryId: null,
    detail,
  };
  return input.store.append(
    input.timestamp === undefined
      ? base
      : { ...base, timestamp: input.timestamp },
  );
}

/** Record that a stream was opened. */
export async function recordStreamOpened(
  input: StreamOpenedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("stream.opened", input, {
      amount: input.amount ?? null,
    }),
  );
}

/** Record that a stream ended, with a stable reason code. */
export async function recordStreamEnded(
  input: StreamEndedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("stream.ended", input, {
      detail: input.detail ?? `stream ended (${input.reason})`,
      amount: input.amount ?? null,
    }),
  );
}

/** Record that a stream was abandoned (idle or past its TTL). */
export async function recordStreamAbandoned(
  input: StreamEndedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("stream.abandoned", input, {
      detail: input.detail ?? `stream abandoned (${input.reason})`,
      amount: input.amount ?? null,
    }),
  );
}

export type SettlementRetryInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  detail?: string | null;
};

export type SettlementRecoveredInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  transactionHash?: Hex | null;
  detail?: string | null;
};

/** Record an operator or startup retry of a settlement intent. */
export async function recordSettlementRetry(
  input: SettlementRetryInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("settlement.retry", input, {
      amount: input.amount,
      nonce: input.nonce,
      detail: input.detail ?? "settlement retry",
    }),
  );
}

/** Record that a retried or reconciled settlement confirmed. */
export async function recordSettlementRecovered(
  input: SettlementRecoveredInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("settlement.recovered", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash ?? null,
      detail: input.detail ?? "settlement recovered",
    }),
  );
}

/** Record an accrual tick. */
export async function recordAccrual(
  input: AccrualRecordedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("accrual.recorded", input, {
      amount: input.amount,
    }),
  );
}

/** Record a `402` demand for a nonce. */
export async function recordPaymentDemanded(
  input: PaymentDemandedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.demanded", input, {
      amount: input.amount,
      nonce: input.nonce,
    }),
  );
}

/** Record a signed envelope. */
export async function recordPaymentSigned(
  input: PaymentSignedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.signed", input, {
      amount: input.amount,
      nonce: input.nonce,
    }),
  );
}

/** Record a refusal to sign. */
export async function recordPaymentRefused(
  input: PaymentRefusedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.refused", input, {
      amount: input.amount,
      classification: input.classification,
    }),
  );
}

/** Record a successful verification. */
export async function recordPaymentVerified(
  input: PaymentVerifiedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.verified", input, {
      amount: input.amount,
      nonce: input.nonce,
    }),
  );
}

/** Record a verifier rejection. */
export async function recordPaymentRejected(
  input: PaymentRejectedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.rejected", input, {
      amount: input.amount,
      nonce: input.nonce,
      classification: input.classification,
    }),
  );
}

/** Record a delivered segment. */
export async function recordSegmentDelivered(
  input: SegmentDeliveredInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("segment.delivered", input, {
      amount: input.amount,
      nonce: input.nonce,
      detail:
        input.detail ??
        `segment delivered: ${input.secondsDelivered}s, ${input.unitsDelivered}u`,
    }),
  );
}

/** Record a submitted settlement, with the transaction hash. */
export async function recordSettlementSubmitted(
  input: SettlementSubmittedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("settlement.submitted", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash,
    }),
  );
}

/** Record a confirmed settlement. */
export async function recordSettlementConfirmed(
  input: SettlementConfirmedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("settlement.confirmed", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash,
    }),
  );
}

/** Record a failed settlement. */
export async function recordSettlementFailed(
  input: SettlementFailedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("settlement.failed", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash ?? null,
      classification: input.classification,
    }),
  );
}

/**
 * Build a **correction** entry: a new entry that names the entry it
 * supersedes. Used by agents that discover a wrong amount, a wrong
 * classification, or a wrong outcome after the original was recorded.
 *
 * Corrections never overwrite; the original is preserved untouched so an
 * auditor can compare the two.
 *
 * `overrides` may carry any of the fields the original supports, but
 * `correctionOf` *must* resolve to an existing entry — the store
 * validates this at write time.
 */
export async function recordCorrection(
  store: LedgerStore,
  correctionOf: LedgerEntry,
  overrides: {
    amount?: SmallestUnits | null;
    classification?: PaymentFailureClassification | null;
    transactionHash?: Hex | null;
    detail?: string | null;
    timestamp?: string;
  },
): Promise<EventResult> {
  const base: AppendInput = {
    event: correctionOf.event,
    streamId: correctionOf.streamId,
    sessionPublicKey: correctionOf.sessionPublicKey,
    chainId: correctionOf.chainId,
    token: correctionOf.token,
    tokenDecimals: correctionOf.tokenDecimals,
    amount:
      overrides.amount === undefined ? correctionOf.amount : overrides.amount,
    nonce: correctionOf.nonce,
    transactionHash:
      overrides.transactionHash === undefined
        ? correctionOf.transactionHash
        : overrides.transactionHash,
    classification:
      overrides.classification === undefined
        ? correctionOf.classification
        : overrides.classification,
    correctsEntryId: correctionOf.id,
    detail: overrides.detail ?? correctionOf.detail,
  };
  return store.append(
    overrides.timestamp === undefined
      ? base
      : { ...base, timestamp: overrides.timestamp },
  );
}

/**
 * P0 payment.settlement.* lifecycle.
 *
 * Distinct from the existing `settlement.*` events (which the in-memory
 * settler has always used) so an operator that wants a single
 * "the chain path wrote this" tag can grep just the `payment.settlement.*`
 * namespace. Both are written by the real chain-backed settler so the
 * exposure module (which reads `settlement.*`) keeps working unchanged
 * while the P0 audit path can read `payment.settlement.*` directly.
 *
 * `payment.settlement.lost` is the timeout path: the chain never
 * confirmed and the operator's reconciliation window has elapsed, so
 * the in-memory slot must be released and a queryable marker left on
 * the ledger so an out-of-band recovery can find the nonce.
 */
export type PaymentSettlementSubmittedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  transactionHash: Hex;
};

export type PaymentSettlementConfirmedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  transactionHash: Hex;
};

export type PaymentSettlementFailedInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  classification: PaymentFailureClassification;
  transactionHash?: Hex | null;
  detail?: string | null;
  timestamp?: string;
};

export type PaymentSettlementLostInput = WriteInput & {
  amount: SmallestUnits;
  nonce: string;
  /** The tx hash that never confirmed; null if no tx was ever submitted. */
  transactionHash?: Hex | null;
  detail?: string | null;
  timestamp?: string;
};

/** Record `payment.settlement.submitted`. */
export async function recordPaymentSettlementSubmitted(
  input: PaymentSettlementSubmittedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.settlement.submitted", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash,
    }),
  );
}

/** Record `payment.settlement.confirmed`. */
export async function recordPaymentSettlementConfirmed(
  input: PaymentSettlementConfirmedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.settlement.confirmed", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash,
    }),
  );
}

/** Record `payment.settlement.failed`. */
export async function recordPaymentSettlementFailed(
  input: PaymentSettlementFailedInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.settlement.failed", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash ?? null,
      classification: input.classification,
    }),
  );
}

/** Record `payment.settlement.lost` — the chain never confirmed before the timeout. */
export async function recordPaymentSettlementLost(
  input: PaymentSettlementLostInput,
): Promise<EventResult> {
  return input.store.append(
    baseInput("payment.settlement.lost", input, {
      amount: input.amount,
      nonce: input.nonce,
      transactionHash: input.transactionHash ?? null,
      detail: input.detail ?? "settlement lost (timeout)",
    }),
  );
}
