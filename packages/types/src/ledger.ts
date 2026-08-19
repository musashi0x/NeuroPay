import type {
  Address,
  Hex,
  IsoTimestamp,
  SmallestUnits,
} from "./primitives.js";

/** Every event the append-only payment ledger records. */
export type LedgerEventType =
  | "stream.opened"
  | "stream.ended"
  | "stream.abandoned"
  | "settlement.retry"
  | "settlement.recovered"
  | "accrual.recorded"
  | "payment.demanded"
  | "payment.refused"
  | "payment.signed"
  | "payment.verified"
  | "payment.rejected"
  | "segment.delivered"
  | "settlement.submitted"
  | "settlement.confirmed"
  | "settlement.failed"
  | "payment.settlement.submitted"
  | "payment.settlement.confirmed"
  | "payment.settlement.failed"
  | "payment.settlement.lost"
  | "session.granted"
  | "session.revoked";

/**
 * Why a payment did not complete.
 *
 * `eoa-only-facilitator` is deliberately distinct: a merchant verifying with
 * `ecrecover` rejects a valid 98-byte ERC-1271 session-key envelope, and that
 * must never be reported as a bug in our signing.
 */
export type PaymentFailureClassification =
  | "no-payable-option"
  | "wrong-chain-only"
  | "unpermitted-token"
  | "budget-exhausted"
  | "overcharge-beyond-tolerance"
  | "session-expired"
  | "session-revoked"
  | "session-unprovisioned"
  | "stream-would-outlive-session"
  | "eoa-only-facilitator"
  | "verification-failed"
  | "amount-underpaid"
  | "recipient-mismatch"
  | "duplicate-nonce"
  | "settlement-reverted"
  | "settler-out-of-gas"
  | "exposure-limit-reached";

/**
 * One append-only ledger record.
 *
 * Entries are never updated in place; a correction is a later entry. Ordering
 * is carried by `sequence`, which is dense and monotonic per ledger, because
 * `timestamp` alone cannot order two events in the same millisecond.
 *
 * No field of this type ever carries private key material. `sessionPublicKey`
 * attributes an entry to a session; the key that signed it stays server-side.
 */
export type LedgerEntry = {
  id: string;
  /** Dense, monotonic write order. Authoritative for replay. */
  sequence: number;
  timestamp: IsoTimestamp;
  event: LedgerEventType;
  /** Null for events not scoped to a stream. */
  streamId: string | null;
  /** Public key of the session the entry is attributed to; never a private key. */
  sessionPublicKey: Hex | null;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /** Exact amount in smallest units, or null for events that carry no amount. */
  amount: SmallestUnits | null;
  /** Permit2 authorization nonce; the idempotency key a payment's lifecycle is looked up by. */
  nonce: string | null;
  /** Settlement transaction hash, once submitted. */
  transactionHash: Hex | null;
  /** Set on `payment.refused`, `payment.rejected`, and `settlement.failed`. */
  classification: PaymentFailureClassification | null;
  /**
   * The earlier entry this one corrects, or null for an original observation.
   *
   * Entries are never rewritten, so a wrong amount or a misclassified outcome
   * is fixed by appending a replacement that names the entry it supersedes.
   * Readers that derive state resolve corrections before aggregating.
   */
  correctsEntryId: string | null;
  /** Free-form operator detail. Never key material. */
  detail: string | null;
};
