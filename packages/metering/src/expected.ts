/**
 * The buyer-side expected-cost computation and the overcharge tolerance check.
 *
 * ## What "expected" means
 *
 * The buyer computes its own expected cost from the pinned price sheet and
 * the consumption it has actually observed in delivered segments. The math
 * is the same three additions the seller's meter does — `arithmetic.ts`'s
 * rounding rule is shared, the price sheet is pinned at stream open and
 * travels on every segment, so on a correct seller the two sides agree to
 * the unit.
 *
 * The point of running the buyer's own meter is *not* to agree with the
 * seller — it is to detect disagreement. A seller bug, a hostile seller, or
 * a stale price sheet produces a demanded amount above the buyer's
 * expectation, and the buyer refuses to sign when that disagreement exceeds
 * the configured tolerance.
 *
 * ## Tolerance
 *
 * The tolerance is the fraction by which the demanded amount may exceed the
 * expectation without refusal. A tolerance of 0.05 lets the demanded amount
 * be up to 5% higher than expected. The comparison goes through
 * `applyBasisPoints` so the bound is exact — `demanded - expected ≤
 * floor(expected × tolerance)` — and a tolerance of 0 refuses everything
 * above the expectation.
 *
 * A refusal carries the demanded and expected amounts so the operator can
 * see exactly how far apart the two meters are. Disagreement above the
 * tolerance is an alarm, not a value to silently accept.
 */

import {
  applyBasisPoints,
  fractionToBasisPoints,
  requireNonNegativeAmount,
  requireNonNegativeCount,
} from "./arithmetic.js";
import type { PriceSheet, SmallestUnits } from "@neuro-pay/types";

/**
 * The consumption the buyer has observed across delivered segments.
 *
 * Counts are whole numbers: the segment response reports `secondsDelivered`
 * and `unitsDelivered` as integers, and the buyer increments per segment.
 * Fractional amounts never enter this struct.
 */
export type ObservedConsumption = {
  calls: number;
  seconds: number;
  units: number;
};

/**
 * Compute the buyer's expected cost for `consumption` against `priceSheet`.
 *
 * The arithmetic mirrors `accrueCalls` + `accrueSeconds` + `accrueUnits`
 * from the seller's side, with the same rounding rule applied to the
 * per-second term. The function takes the consumption as input rather than
 * maintaining its own meter state, because the buyer recomputes on each
 * demand: a fresh expected number each segment is exactly the property that
 * lets it disagree with the seller and refuse.
 */
export function computeExpectedCost(
  priceSheet: PriceSheet,
  consumption: ObservedConsumption,
): SmallestUnits {
  requireNonNegativeAmount(priceSheet.perCall, "priceSheet.perCall");
  requireNonNegativeAmount(priceSheet.perSecond, "priceSheet.perSecond");
  requireNonNegativeAmount(priceSheet.perUnit, "priceSheet.perUnit");
  requireNonNegativeCount(consumption.calls, "consumption.calls");
  requireNonNegativeCount(consumption.seconds, "consumption.seconds");
  requireNonNegativeCount(consumption.units, "consumption.units");

  // Per-second cost uses the same `divideRoundHalfUp` rule the seller's
  // accrual uses: price × elapsedMs / 1000, half-up to the nearest unit.
  // Here `consumption.seconds` is whole seconds, so elapsedMs = seconds × 1000
  // is an integer count and the rounding is exact.
  const callCost = priceSheet.perCall * BigInt(consumption.calls);
  const secondCost = priceSheet.perSecond * BigInt(consumption.seconds);
  const unitCost = priceSheet.perUnit * BigInt(consumption.units);

  return callCost + secondCost + unitCost;
}

/**
 * The outcome of comparing the seller's demand against the buyer's
 * expectation. `pay` carries the difference for reporting when the demand is
 * within tolerance; `refuse` carries both numbers so the operator can see
 * the disagreement.
 */
export type ToleranceCheckResult =
  | {
      ok: true;
      /** `demanded - expected`, always ≥ 0 and within tolerance. */
      difference: SmallestUnits;
    }
  | {
      ok: false;
      reason: "over-tolerance";
      demanded: SmallestUnits;
      expected: SmallestUnits;
      /** `demanded - expected`, always > the tolerance bound. */
      difference: SmallestUnits;
    };

/**
 * Compare the seller's `demanded` amount against the buyer's `expected`
 * amount under `tolerance` (a fraction in `[0, 1)`).
 *
 * Tolerance of 0 refuses any demanded amount above the expectation, byte for
 * byte. Tolerance of 0.05 admits up to `floor(expected × 0.05)` of slack.
 *
 * If `demanded ≤ expected` the check always passes — under-demanding is a
 * seller problem, not a buyer problem, and refusing to sign against an
 * under-demand would be punishing the buyer for the seller's generosity.
 */
export function compareToExpected(
  expected: SmallestUnits,
  demanded: SmallestUnits,
  tolerance: number,
): ToleranceCheckResult {
  requireNonNegativeAmount(expected, "expected");
  requireNonNegativeAmount(demanded, "demanded");
  if (tolerance < 0 || tolerance >= 1) {
    throw new RangeError(
      `compareToExpected: tolerance must be in [0, 1), received ${tolerance}`,
    );
  }

  if (demanded <= expected) {
    return { ok: true, difference: expected - demanded };
  }

  const toleranceBp = fractionToBasisPoints(tolerance);
  const allowance = applyBasisPoints(expected, toleranceBp);
  const difference = demanded - expected;

  if (difference > allowance) {
    return {
      ok: false,
      reason: "over-tolerance",
      demanded,
      expected,
      difference,
    };
  }

  return { ok: true, difference };
}
