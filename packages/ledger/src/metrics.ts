/**
 * Operational metrics derived from the ledger.
 *
 * ## Derived, not counted
 *
 * Nothing here is a counter the process increments. Every number is
 * recomputed from the append-only trail, which is what makes the numbers
 * survive a restart, agree across two processes reading the same file,
 * and stay correct when a crash loses whatever was in memory. A metric
 * you can only get by having been running the whole time is a metric
 * that lies after the first deploy.
 *
 * The cost is a full scan per collection. That is the right trade at
 * this volume — the ledger writes one row per payment event, never per
 * call — and the shape of this module (one pass, one pure function over
 * the entries) is what would let a scrape-time cache or an incremental
 * fold slot in later without changing a call site.
 *
 * ## Two settlement event families
 *
 * The trail carries both `settlement.*` (written by the outbox queue as
 * an intent moves through its states) and `payment.settlement.*`
 * (written by the chain settler around the actual transaction). They
 * describe the same settlement from two altitudes, so every metric here
 * folds them together and de-duplicates by nonce. Counting them
 * separately would double every settlement that took the normal path.
 */

import type { LedgerEntry, LedgerEventType } from "@neuro-pay/types";

import type { LedgerStore } from "./store.js";

/** Quantile summary of a latency sample, in milliseconds. */
export type LatencySummary = {
  count: number;
  /** Null when no sample has been observed yet — never 0, which is a real latency. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type VerificationMetrics = {
  demanded: number;
  verified: number;
  rejected: number;
  refused: number;
  /**
   * Rejection and refusal counts by `PaymentFailureClassification`.
   * Sparse: a classification that has never occurred is absent rather
   * than zero, so a new classification does not need a schema change
   * here to show up.
   */
  byClassification: Record<string, number>;
};

export type SettlementMetrics = {
  submitted: number;
  confirmed: number;
  failed: number;
  lost: number;
  /** Submitted with neither a confirmation nor a failure yet. */
  inFlight: number;
  /**
   * Failed or lost settlements with no later confirmation and no
   * recovery event. This is the seller's unrecovered exposure in count
   * form, and the number an operator alert fires on.
   */
  failedUnrecovered: number;
  retried: number;
  recovered: number;
  /** Submitted → confirmed wall time, per nonce. */
  latency: LatencySummary;
};

export type LedgerMetrics = {
  entries: number;
  verification: VerificationMetrics;
  settlement: SettlementMetrics;
  delivery: { segments: number };
  streams: { opened: number; ended: number; abandoned: number };
  session: { granted: number; revoked: number };
};

/** The shape a ledger with no entries produces. Useful as a test baseline. */
export const EMPTY_LEDGER_METRICS: LedgerMetrics = {
  entries: 0,
  verification: {
    demanded: 0,
    verified: 0,
    rejected: 0,
    refused: 0,
    byClassification: {},
  },
  settlement: {
    submitted: 0,
    confirmed: 0,
    failed: 0,
    lost: 0,
    inFlight: 0,
    failedUnrecovered: 0,
    retried: 0,
    recovered: 0,
    latency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
  },
  delivery: { segments: 0 },
  streams: { opened: 0, ended: 0, abandoned: 0 },
  session: { granted: 0, revoked: 0 },
};

const SUBMITTED_EVENTS = new Set<LedgerEventType>([
  "settlement.submitted",
  "payment.settlement.submitted",
]);
const CONFIRMED_EVENTS = new Set<LedgerEventType>([
  "settlement.confirmed",
  "payment.settlement.confirmed",
]);
const FAILED_EVENTS = new Set<LedgerEventType>([
  "settlement.failed",
  "payment.settlement.failed",
]);
const LOST_EVENTS = new Set<LedgerEventType>(["payment.settlement.lost"]);

/** Per-nonce settlement state, folded from both event families. */
type NonceState = {
  submittedAtMs: number | null;
  confirmedAtMs: number | null;
  failed: boolean;
  lost: boolean;
  recovered: boolean;
};

export async function computeLedgerMetrics(
  store: LedgerStore,
): Promise<LedgerMetrics> {
  return foldLedgerMetrics(await store.entries());
}

/**
 * The pure fold. Exported shape is the same as `computeLedgerMetrics`;
 * kept separate so tests can build an entry array without a store and so
 * a caller that already holds the entries does not read them twice.
 */
export function foldLedgerMetrics(entries: LedgerEntry[]): LedgerMetrics {
  const metrics: LedgerMetrics = structuredClone(EMPTY_LEDGER_METRICS);
  metrics.entries = entries.length;

  const byNonce = new Map<string, NonceState>();
  const stateFor = (nonce: string): NonceState => {
    let state = byNonce.get(nonce);
    if (!state) {
      state = {
        submittedAtMs: null,
        confirmedAtMs: null,
        failed: false,
        lost: false,
        recovered: false,
      };
      byNonce.set(nonce, state);
    }
    return state;
  };

  for (const entry of entries) {
    switch (entry.event) {
      case "payment.demanded":
        metrics.verification.demanded += 1;
        break;
      case "payment.verified":
        metrics.verification.verified += 1;
        break;
      case "payment.rejected":
        metrics.verification.rejected += 1;
        countClassification(metrics.verification, entry);
        break;
      case "payment.refused":
        metrics.verification.refused += 1;
        countClassification(metrics.verification, entry);
        break;
      case "segment.delivered":
        metrics.delivery.segments += 1;
        break;
      case "stream.opened":
        metrics.streams.opened += 1;
        break;
      case "stream.ended":
        metrics.streams.ended += 1;
        break;
      case "stream.abandoned":
        metrics.streams.abandoned += 1;
        break;
      case "session.granted":
        metrics.session.granted += 1;
        break;
      case "session.revoked":
        metrics.session.revoked += 1;
        break;
      case "settlement.retry":
        metrics.settlement.retried += 1;
        break;
      case "settlement.recovered":
        metrics.settlement.recovered += 1;
        if (entry.nonce !== null) stateFor(entry.nonce).recovered = true;
        break;
      default:
        break;
    }

    if (entry.nonce === null) continue;

    if (SUBMITTED_EVENTS.has(entry.event)) {
      const state = stateFor(entry.nonce);
      const at = Date.parse(entry.timestamp);
      // First submission wins. A resubmit after a transient RPC error is
      // the same settlement, and measuring from the retry would report a
      // latency shorter than the buyer actually waited.
      if (state.submittedAtMs === null && Number.isFinite(at)) {
        state.submittedAtMs = at;
      }
    } else if (CONFIRMED_EVENTS.has(entry.event)) {
      const state = stateFor(entry.nonce);
      const at = Date.parse(entry.timestamp);
      if (state.confirmedAtMs === null && Number.isFinite(at)) {
        state.confirmedAtMs = at;
      }
      // A confirmation supersedes an earlier failure: the settlement did
      // land, whatever happened on the way.
      state.failed = false;
      state.lost = false;
    } else if (FAILED_EVENTS.has(entry.event)) {
      stateFor(entry.nonce).failed = true;
    } else if (LOST_EVENTS.has(entry.event)) {
      stateFor(entry.nonce).lost = true;
    }
  }

  const latencies: number[] = [];
  for (const state of byNonce.values()) {
    if (state.submittedAtMs !== null) metrics.settlement.submitted += 1;
    if (state.confirmedAtMs !== null) metrics.settlement.confirmed += 1;
    if (state.failed) metrics.settlement.failed += 1;
    if (state.lost) metrics.settlement.lost += 1;

    if (
      state.submittedAtMs !== null &&
      state.confirmedAtMs === null &&
      !state.failed &&
      !state.lost
    ) {
      metrics.settlement.inFlight += 1;
    }
    if ((state.failed || state.lost) && !state.recovered) {
      metrics.settlement.failedUnrecovered += 1;
    }
    if (state.submittedAtMs !== null && state.confirmedAtMs !== null) {
      latencies.push(Math.max(0, state.confirmedAtMs - state.submittedAtMs));
    }
  }

  metrics.settlement.latency = summarize(latencies);
  return metrics;
}

function countClassification(
  verification: VerificationMetrics,
  entry: LedgerEntry,
): void {
  const key = entry.classification ?? "unclassified";
  verification.byClassification[key] =
    (verification.byClassification[key] ?? 0) + 1;
}

/**
 * Nearest-rank quantiles over the whole sample.
 *
 * No reservoir, no decay: the sample is every settlement the ledger has
 * ever recorded. That makes the numbers lifetime-to-date rather than
 * recent, which is the honest reading of a metric derived from a
 * permanent trail — a windowed version would need a window the ledger
 * does not define.
 */
function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

function quantile(sorted: number[], q: number): number {
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}
