/**
 * Lookup by authorization nonce.
 *
 * A nonce is the idempotency key for one payment: the seller's `402` is
 * emitted with a nonce, the buyer signs against that nonce, the seller
 * verifies, the settler submits on-chain, and confirmation lands later.
 * The same nonce is expected to appear in *every* step of that chain, and
 * the lookup function is what stitches the chain back together for the
 * console.
 *
 * Duplicates are detected by counting entries that share a nonce: a nonce
 * with two `payment.verified` entries is replayed, not a second attempt.
 */

import type { LedgerEntry } from "@neuro-pay/types";

import type { LedgerStore } from "./store.js";

/**
 * The verified/delivered/settled triumvirate for one nonce.
 *
 * `payment.demanded` and `payment.signed` are not part of this view —
 * demanded signals *intent* on the seller side and signed signals *intent*
 * on the buyer side, but the lifecycle that matters to reconciliation
 * starts at `payment.verified` and ends at `settlement.confirmed` or
 * `settlement.failed`. Each list is sorted by append order, oldest first;
 * the caller can pick the latest confirmation or fail out of them.
 */
export type LifecycleByNonce = {
  nonce: string;
  verification: LedgerEntry[];
  delivery: LedgerEntry[];
  settlementSubmitted: LedgerEntry[];
  settlementConfirmed: LedgerEntry[];
  settlementFailed: LedgerEntry[];
  /** Refusals and rejections that targeted this nonce; usually empty. */
  failures: LedgerEntry[];
  /** Every entry on the ledger that carries this nonce, in append order. */
  all: LedgerEntry[];
};

/**
 * Look up every entry carrying `nonce`, grouped by lifecycle stage.
 *
 * The shape is built from a single pass over the ledger. A nonce that
 * appears in zero entries yields `null`, not an empty lifecycle —
 * "not found" is a different signal from "found but unverified".
 */
export async function lookupByNonce(
  store: LedgerStore,
  nonce: string,
): Promise<LifecycleByNonce | null> {
  if (!nonce) {
    throw new TypeError("nonce must be a non-empty string");
  }

  const all = (await store.entries()).filter((entry) => entry.nonce === nonce);
  if (all.length === 0) return null;

  const result: LifecycleByNonce = {
    nonce,
    verification: [],
    delivery: [],
    settlementSubmitted: [],
    settlementConfirmed: [],
    settlementFailed: [],
    failures: [],
    all,
  };

  for (const entry of all) {
    switch (entry.event) {
      case "payment.verified":
        result.verification.push(entry);
        break;
      case "payment.rejected":
        result.failures.push(entry);
        break;
      case "segment.delivered":
        result.delivery.push(entry);
        break;
      case "settlement.submitted":
        result.settlementSubmitted.push(entry);
        break;
      case "settlement.confirmed":
        result.settlementConfirmed.push(entry);
        break;
      case "settlement.failed":
        result.settlementFailed.push(entry);
        break;
      default:
        // Other nonce-carrying events (signed, demanded) are intentionally
        // not surfaced in the lifecycle view; they are intermediate steps
        // that the verified/rejected/delivered chain already implies.
        break;
    }
  }

  return result;
}

/**
 * Detect duplicate nonces on the lifecycle phases that should be unique:
 * a single `payment.verified` per nonce, and at most one in-flight
 * settlement submission per nonce.
 *
 * "Duplicate" here means *duplicate verification* — a second
 * `payment.verified` entry on an already-recorded nonce is the b402
 * merchant's signature of replays. A second `settlement.submitted` is
 * equally bad: either the settler was kicked twice or the first
 * submission failed silently and a retry ran, both of which deserve to
 * be visible.
 *
 * Returns one record per offending nonce, so a system that reconciles
 * many in parallel can iterate the result without re-scanning.
 */
export async function detectDuplicateNonces(
  store: LedgerStore,
): Promise<
  { nonce: string; verificationCount: number; submissionCount: number }[]
> {
  const entries = await store.entries();
  const buckets = new Map<
    string,
    { verificationCount: number; submissionCount: number }
  >();

  for (const entry of entries) {
    if (entry.nonce === null) continue;
    const bucket = buckets.get(entry.nonce) ?? {
      verificationCount: 0,
      submissionCount: 0,
    };
    if (entry.event === "payment.verified") bucket.verificationCount += 1;
    if (entry.event === "settlement.submitted") bucket.submissionCount += 1;
    buckets.set(entry.nonce, bucket);
  }

  const dupes: {
    nonce: string;
    verificationCount: number;
    submissionCount: number;
  }[] = [];
  for (const [nonce, counts] of buckets) {
    if (counts.verificationCount > 1 || counts.submissionCount > 1) {
      dupes.push({ nonce, ...counts });
    }
  }
  return dupes;
}

/**
 * Convenience: true if `nonce` has already been recorded against a
 * `payment.verified` entry.
 *
 * Used as the idempotency guard in the seller — the same envelope
 * presented twice should be served the same segment, never a second one.
 */
export async function isNonceAlreadyVerified(
  store: LedgerStore,
  nonce: string,
): Promise<boolean> {
  const entries = await store.entries();
  return entries.some(
    (entry) => entry.nonce === nonce && entry.event === "payment.verified",
  );
}
