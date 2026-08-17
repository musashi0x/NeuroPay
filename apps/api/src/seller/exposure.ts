/**
 * Credit exposure accounting (5.9).
 *
 * The seller stops delivering when unsettled exposure — i.e. delivered
 * segments whose `settlement.confirmed` has not yet landed — exceeds
 * `settlementThreshold × maxInFlightSettlements`. This bounds the
 * seller's unrecoverable delivery to the threshold no matter how slow
 * settlement becomes.
 *
 * The accounting is purely in-memory: the ledger is the durable record
 * (see `packages/ledger/src/exposure.ts`), but the gate uses an in-flight
 * counter so a segment request can be refused before any ledger read.
 * The composed path calls `tryAcquire` synchronously and decrements on
 * the matching `release`.
 *
 * In a happy settle-and-confirm, the flow is:
 *  - segment request → tryAcquire → cap passed → deliver → submitSettle
 *  - submitSettle returns pending → exposure count rises by 1
 *  - confirmation lands → release → exposure count falls by 1
 *  - in-flight counter keeps the ledger-recorded amount (already in
 *    `segments.delivered`, never double-counted).
 *
 * A "drained settler" — one that cannot even submit because of missing
 * gas — is reported distinctly from a settlement revert by the
 * classification carried into the ledger. This module only deals with
 * the count; the settle module decides the classification.
 */

import type { SmallestUnits } from "@neuro-pay/types";

/**
 * The exposure configuration.
 *
 * `maxInFlight` is the configured `maxInFlightSettlements`. The exposure
 * ceiling is implicit — it's `settlementThreshold × maxInFlight` — so we
 * only need to track the in-flight settlement *count* and let the route
 * reason about amount ceilings if it wants a more granular gate.
 */
export type ExposureConfig = {
  maxInFlight: number;
  settlementThreshold: SmallestUnits;
};

/**
 * The in-memory in-flight counter.
 *
 * Counts settlements from "submitted to chain" to "confirmed" — those are
 * the moments where the seller has delivered value without it being on
 * chain yet. Rejected verification does NOT count: the seller never
 * delivers when verification fails.
 */
export type ExposureCounter = {
  /** Number of submitted, not-yet-confirmed settlements. */
  inFlightCount(): number;
  /**
   * Try to acquire one more slot. Returns true if the request fits under
   * `maxInFlight`; false if the seller should stop delivering.
   */
  tryAcquire(): boolean;
  /** Release one slot, e.g. on confirm. Idempotent; doesn't go below zero. */
  release(): void;
  /**
   * Read the total in-flight amount. Computed against the ledger of
   * confirmed/unc confirmed deliveries; the call site passes
   * `pendingAmounts` as the list of submitted-but-not-confirmed amounts.
   */
  totalUnsettledAmount(pendingAmounts: SmallestUnits[]): SmallestUnits;
  /**
   * Refuse a request because the limit is met. Pure (reads only).
   */
  isAtLimit(): boolean;
  /** Reset to zero. Tests only. */
  reset(): void;
};

export function createExposureCounter(config: ExposureConfig): ExposureCounter {
  let inFlight = 0;
  return {
    inFlightCount() {
      return inFlight;
    },
    isAtLimit() {
      return inFlight >= config.maxInFlight;
    },
    tryAcquire() {
      if (inFlight >= config.maxInFlight) return false;
      inFlight += 1;
      return true;
    },
    release() {
      if (inFlight > 0) inFlight -= 1;
    },
    totalUnsettledAmount(pendingAmounts) {
      let total = 0n;
      for (const amount of pendingAmounts) {
        total += amount;
      }
      return total;
    },
    reset() {
      inFlight = 0;
    },
  };
}

/** The maximum unrecoverable delivery allowed by the limit. */
export function exposureCeiling(config: ExposureConfig): SmallestUnits {
  return config.settlementThreshold * BigInt(config.maxInFlight);
}

/**
 * The reason a segment request was refused by the exposure gate.
 *
 * A single classification keeps the operator alarm clean: "credit
 * exposure limit reached" — which is an alarm about settlement latency
 * or a stalled settler, and not about demand-side overspend.
 */
export type ExposureRefusal = {
  kind: "refusal";
  reason: "exposure-limit-reached";
  detail: string;
  inFlight: number;
  ceiling: number;
  exposureCeiling: SmallestUnits;
};

export function buildExposureRefusal(
  counter: ExposureCounter,
  config: ExposureConfig,
): ExposureRefusal {
  return {
    kind: "refusal",
    reason: "exposure-limit-reached",
    detail: `${counter.inFlightCount()} of ${config.maxInFlight} in-flight settlements already submitted`,
    inFlight: counter.inFlightCount(),
    ceiling: config.maxInFlight,
    exposureCeiling: exposureCeiling(config),
  };
}
