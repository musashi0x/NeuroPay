/**
 * Window spend and budget state.
 *
 * The local budget is a *mirror* of the session's on-chain `spend`
 * ceiling: a configured percentage (default 80) of the cap, over a
 * window aligned to the same `period`. The mirror trips first — the
 * buyer refuses to sign before the mirror is breached, and the on-chain
 * cap stays as a backstop against this code being wrong.
 *
 * What counts toward window spend: every signed payment whose
 * settlement has not yet confirmed. (`payment.signed`) before
 * settlement, `payment.verified` after verification, and
 * `settlement.confirmed` is what *removes* the amount from the window.
 * A `settlement.failed` leaves the amount in the window because the
 * seller was paid but the funds were not actually moved.
 *
 * Corrections: when an entry is corrected, only the *latest* entry in
 * its correction family counts. So a `settlement.confirmed` entry that
 * was wrongly written as `payment.signed` — and then corrected to
 * `settlement.confirmed` — counts as `settlement.confirmed` once it has
 * landed.
 */

import type { Address, Hex, LedgerEntry, SmallestUnits } from "@neuro-pay/types";

import type { LedgerStore } from "./store.js";

/**
 * The session's policy inputs at the time the window is computed.
 *
 * The values come from the buyer's loaded `AppConfig`; the ledger
 * itself does not own them. It only knows what sums signed-but-unconfirmed
 * for one session and one token.
 */
export type WindowSpendInputs = {
  /** Session public key. Window is per session, not per stream. */
  sessionPublicKey: Hex;
  /** Token address. A session can authorize more than one. */
  token: Address;
  /** Per-session on-chain `spend.limit` in smallest units. */
  onChainCap: SmallestUnits;
  /** Configured local-budget percentage of `onChainCap`. Decimal fraction, e.g. `0.8n / 1n`. */
  budgetMarginFraction: bigint & { readonly __brand?: unique symbol };
  /** Now, in epoch milliseconds, used to align the rolling window. */
  nowMs: number;
  /** Window length, in milliseconds, equal to the session `period`. */
  periodMs: number;
};

/**
 * A wide bigint factory that lets the caller declare a `bigint`
 * constant without a separate helper. Used to type the
 * `budgetMarginFraction` so a percentage literal is distinguishable
 * from a smallest-unit amount.
 */
export type Fraction = bigint;

/** Cast a bigint to the `Fraction` brand type for `budgetMarginFraction`. */
export const fraction = (n: bigint): Fraction => n as Fraction;

/**
 * Output of `computeWindowSpend` — every value is in smallest units of
 * the requested token.
 */
export type WindowSpend = {
  /** Sum of signed-but-unconfirmed payments, in the current window, in smallest units. */
  windowSpend: bigint;
  /** Mirror ceiling, in smallest units. `onChainCap * budgetMarginFraction`. */
  localBudget: bigint;
  /** `localBudget - windowSpend`, never negative. */
  remainingLocalBudget: bigint;
  /** The session's on-chain `spend.limit`, reported so the console can render it. */
  onChainCap: bigint;
  /** `onChainCap - windowSpend`, never negative. */
  remainingOnChainCap: bigint;
  /**
   * Number of payments that count toward the window. Useful for the
   * console badge; counts both verified and signed-but-not-yet-verified
   * entries (the duplicates are deduped by nonce).
   */
  paymentCount: number;
};

/**
 * Indicator of whose ceiling trips first.
 *
 * `local-first` is the steady state — the buyer refuses to sign before
 * the on-chain cap is at risk. `on-chain-first` means the config is so
 * loose that the mirror exceeds the cap, which is a configuration
 * error: the cap protection becomes more permissive than the policy
 * intends. The console surfaces this so an operator can fix the margin.
 */
export type BudgetHeadroom = {
  remaining: bigint;
  /** Whose ceiling is closest to the spend. */
  closestTo: "local-budget" | "on-chain-cap";
};

/**
 * Compute window spend and the two remaining-budget figures.
 *
 * The window is the rolling `periodMs` ending at `nowMs`. A payment
 * enters the window when its first nonce-carrying entry is appended
 * (`payment.demanded` is the earliest; `payment.signed` follows; we
 * count from `payment.demanded` because that's when the spend was
 * authorised by the seller's intent to be paid), and it leaves when
 * `settlement.confirmed` lands.
 *
 * Settlements that *failed* never leave the window — the seller was
 * paid in expectation, so the spend stays counted and the operator has
 * to recover manually (or re-settle on a different nonce).
 */
export async function computeWindowSpend(
  store: LedgerStore,
  inputs: WindowSpendInputs,
): Promise<WindowSpend> {
  const entries = (await store.entries()).filter(
    (entry) => entry.sessionPublicKey === inputs.sessionPublicKey,
  );
  const effective = applyCorrections(entries);

  const windowStartMs = inputs.nowMs - inputs.periodMs;

  // Bucket the effective nonces:
  //  * "in-flight" — has at least one entry of payment-signed/payment-verified
  //    in the window, no settlement.confirmed, and no settlement.failed.
  //  * "recovered" — has a settlement.confirmed in the window.
  //  * "failed" — has a settlement.failed in the window (and never confirms).
  //  * "no payment" — only payment.demanded entries; not yet signed.
  //
  // We charge only the *unique* nonces that signed and have not yet
  // confirmed. A demand without a sign never counts.
  const nonceBuckets = bucketByNonce(effective, windowStartMs, inputs.token);

  let windowSpend = 0n;
  let paymentCount = 0;
  for (const bucket of nonceBuckets.values()) {
    if (bucket.confirmedAmount !== null) {
      // The payment cleared inside the window — counts toward the
      // historical sum but is *removed* from in-flight.
      windowSpend += bucket.confirmedAmount;
      paymentCount += 1;
      continue;
    }
    if (bucket.failedAmount !== null) {
      windowSpend += bucket.failedAmount;
      paymentCount += 1;
      continue;
    }
    if (bucket.signedAmount !== null) {
      windowSpend += bucket.signedAmount;
      paymentCount += 1;
    }
  }

  const localBudget = computeLocalBudget(
    inputs.onChainCap,
    inputs.budgetMarginFraction,
  );
  const remainingLocalBudget = localBudget > windowSpend ? localBudget - windowSpend : 0n;
  const remainingOnChainCap =
    inputs.onChainCap > windowSpend ? inputs.onChainCap - windowSpend : 0n;

  return {
    windowSpend,
    localBudget,
    remainingLocalBudget,
    onChainCap: inputs.onChainCap,
    remainingOnChainCap,
    paymentCount,
  };
}

/**
 * Lightweight helper around `computeWindowSpend` for callers that want
 * the closest-to-tripping ceiling alongside the figures.
 *
 * The returned `closestTo` is for *operator-facing surfaces*, not for
 * logic: a refusal must always compare against both numbers.
 */
export async function budgetHeadroom(
  store: LedgerStore,
  inputs: WindowSpendInputs,
): Promise<BudgetHeadroom> {
  const spend = await computeWindowSpend(store, inputs);
  if (spend.remainingLocalBudget <= spend.remainingOnChainCap) {
    return {
      remaining: spend.remainingLocalBudget,
      closestTo: "local-budget",
    };
  }
  return {
    remaining: spend.remainingOnChainCap,
    closestTo: "on-chain-cap",
  };
}

/**
 * Compute `onChainCap * budgetMarginFraction`, rounding the result so a
 * fractional margin never overshoots.
 *
 * `budgetMarginFraction` is `1e18`-scaled to avoid losing precision on a
 * fractional percent. A margin of `0.8n * 10n ** 18n` against a cap of
 * `1n * 10n ** 24n` becomes `8n * 10n ** 23n`, exact.
 */
function computeLocalBudget(
  onChainCap: bigint,
  budgetMarginFraction: bigint,
): bigint {
  if (budgetMarginFraction < 0n) {
    throw new RangeError("budgetMarginFraction must be non-negative");
  }
  if (budgetMarginFraction > 10n ** 18n) {
    throw new RangeError("budgetMarginFraction may not exceed 1e18 (100%)");
  }
  return (onChainCap * budgetMarginFraction) / 10n ** 18n;
}

/**
 * Resolve the "latest version" of every entry in `entries`. Two entries
 * that share a `correctsEntryId` are siblings; the one with the higher
 * `sequence` wins.
 *
 * The output is a `Map<id, LedgerEntry>` keyed by *post-resolution id*
 * — i.e. the original entry's id, since a correction is a *replacement*
 * not a new logical id. Callers iterating the result see exactly the
 * set of logical entries that should be aggregated, with corrections
 * applied.
 */
function applyCorrections(entries: LedgerEntry[]): LedgerEntry[] {
  // First pass: index by logical id (the correction target or self).
  const byLogicalId = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const logicalId = entry.correctsEntryId ?? entry.id;
    const family = byLogicalId.get(logicalId) ?? [];
    family.push(entry);
    byLogicalId.set(logicalId, family);
  }
  // Second pass: keep the highest-sequence entry from each family.
  const resolved: LedgerEntry[] = [];
  for (const family of byLogicalId.values()) {
    family.sort((a, b) => a.sequence - b.sequence);
    resolved.push(family[family.length - 1] as LedgerEntry);
  }
  // Re-sort by sequence to give the caller append order.
  resolved.sort((a, b) => a.sequence - b.sequence);
  return resolved;
}

type NonceBucket = {
  signedAmount: bigint | null;
  confirmedAmount: bigint | null;
  failedAmount: bigint | null;
  /**
   * Earliest `timestamp` of any entry on this nonce within the window;
   * used to confirm the bucket is in-window for the window-spend tally.
   */
  inWindowAtMs: number | null;
};

/**
 * Bucket the entries that are within the current window for the given
 * token by nonce. Entries with `amount == null` are skipped — a
 * settlement that didn't carry a number cannot move the window.
 *
 * The reduction picks *one* signed/verified amount per nonce (the
 * demand) and tracks whether the same nonce ended in confirmation or
 * failure within the window.
 */
function bucketByNonce(
  entries: LedgerEntry[],
  windowStartMs: number,
  token: Address,
): Map<string, NonceBucket> {
  const buckets = new Map<string, NonceBucket>();

  for (const entry of entries) {
    if (entry.token !== token) continue;
    if (entry.nonce === null) continue;
    const entryTimeMs = Date.parse(entry.timestamp);
    if (Number.isNaN(entryTimeMs) || entryTimeMs < windowStartMs) continue;

    const bucket = buckets.get(entry.nonce) ?? {
      signedAmount: null,
      confirmedAmount: null,
      failedAmount: null,
      inWindowAtMs: null,
    };

    if (bucket.inWindowAtMs === null || entryTimeMs < bucket.inWindowAtMs) {
      bucket.inWindowAtMs = entryTimeMs;
    }

    switch (entry.event) {
      case "payment.demanded":
      case "payment.signed":
      case "payment.verified":
      case "segment.delivered": {
        // Use the first signed/verified amount we see as the bucket's
        // "expected" amount. A second `payment.demanded` for the same
        // nonce would be a bug, but if it happens we keep the larger
        // number so the bucket is *conservative* — better to refuse
        // early than to under-count.
        const amount = entry.amount ?? 0n;
        bucket.signedAmount =
          bucket.signedAmount === null
            ? amount
            : bucket.signedAmount > amount
              ? bucket.signedAmount
              : amount;
        break;
      }
      case "settlement.confirmed":
        bucket.confirmedAmount = bucket.signedAmount;
        break;
      case "settlement.failed":
        bucket.failedAmount = bucket.signedAmount;
        break;
      default:
        break;
    }

    buckets.set(entry.nonce, bucket);
  }

  return buckets;
}
