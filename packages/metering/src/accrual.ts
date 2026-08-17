/**
 * Accrual: the math that turns observed consumption into a bigint cost.
 *
 * The seller and the buyer run the same three additions against the same
 * pinned price sheet. If the additions disagree by a unit — which is the only
 * place a small drift turns into a wrong refusal or a wrong payment — the
 * tolerance check on the buyer side will catch it, but the goal is to never
 * disagree in the first place. The implementation is the literal sum of three
 * bigint products, with the single documented rounding rule from
 * `arithmetic.ts` applied to the one term that can produce a non-integer
 * (per-second cost over fractional elapsed seconds).
 *
 * ## No floats reach an amount
 *
 * Every quantity passed in is an integer: `calls`, `units`, and `elapsedMs`
 * are safe integers, never a `number` rounded on the way in. Per-second
 * multiplication goes through `divideRoundHalfUp` with an explicit `1000n`
 * denominator, not a `Number(seconds)` conversion.
 */

import {
  divideRoundHalfUp,
  requireNonNegativeAmount,
  requireNonNegativeCount,
} from "./arithmetic.js";
import type { Clock } from "./clock.js";
import type { PriceSheet, SmallestUnits } from "@neuro-pay/types";

/**
 * The state the meter maintains for one stream.
 *
 * Lives entirely in memory while the stream is open and is serialized only
 * into `SegmentResponse` when delivery returns a segment. `lastPaidAtMs` is
 * `null` until the first demand is settled, so the policy can fire on the
 * very first tick without a previous-paid-time baseline.
 */
export type MeterState = {
  /** Cost accrued since the last settlement, in smallest units. */
  accruedUnpaid: SmallestUnits;
  /** Cost accrued over the stream's full life, paid and unpaid, in smallest units. */
  totalAccrued: SmallestUnits;
  /** Total calls delivered over the stream's life. */
  deliveredCalls: number;
  /** Total seconds delivered, accumulated across segments. */
  deliveredSeconds: number;
  /** Total units delivered, accumulated across segments. */
  deliveredUnits: number;
  /**
   * Epoch milliseconds of the last settlement. `null` until the first
   * settlement, so the tick policy has no false baseline before it.
   */
  lastPaidAtMs: number | null;
};

/**
 * The first state of a meter: nothing accrued, no deliveries yet, no last
 * payment.
 */
export function createMeterState(): MeterState {
  return {
    accruedUnpaid: 0n,
    totalAccrued: 0n,
    deliveredCalls: 0,
    deliveredSeconds: 0,
    deliveredUnits: 0,
    lastPaidAtMs: null,
  };
}

/**
 * Add `calls` per-call charges to the meter. `calls` must be a non-negative
 * safe integer; a fractional call count is a programming error, not a value
 * to silently round, and the guard surfaces it here.
 */
export function accrueCalls(
  state: MeterState,
  priceSheet: PriceSheet,
  calls: number,
): MeterState {
  requireNonNegativeCount(calls, "calls");
  requireNonNegativeAmount(priceSheet.perCall, "priceSheet.perCall");

  const cost = priceSheet.perCall * BigInt(calls);

  return {
    ...state,
    accruedUnpaid: state.accruedUnpaid + cost,
    totalAccrued: state.totalAccrued + cost,
    deliveredCalls: state.deliveredCalls + calls,
  };
}

/**
 * Add per-second charges for `elapsedMs` of delivery.
 *
 * `elapsedMs` is an integer count of milliseconds — the boundary that
 * converts the clock's real-valued seconds into a safe integer before any
 * arithmetic touches it. The per-second price is multiplied by the elapsed
 * milliseconds and divided by 1000, rounded half-up to the nearest smallest
 * unit, so 10 units/sec over 4501 ms rounds to 45 (half-up from 45.01) and
 * 7 units/sec over 500 ms rounds to 4 (half-up from 3.5).
 */
export function accrueSeconds(
  state: MeterState,
  priceSheet: PriceSheet,
  elapsedMs: number,
): MeterState {
  requireNonNegativeCount(elapsedMs, "elapsedMs");
  requireNonNegativeAmount(priceSheet.perSecond, "priceSheet.perSecond");

  const cost = divideRoundHalfUp(
    priceSheet.perSecond * BigInt(elapsedMs),
    1000n,
  );

  return {
    ...state,
    accruedUnpaid: state.accruedUnpaid + cost,
    totalAccrued: state.totalAccrued + cost,
    deliveredSeconds: state.deliveredSeconds + Math.floor(elapsedMs / 1000),
  };
}

/**
 * Add `units` per-unit charges to the meter.
 *
 * `units` is a safe integer (whole tokens, whole frames, whole bytes). A
 * partial unit is a boundary concern; the meter does not round here.
 */
export function accrueUnits(
  state: MeterState,
  priceSheet: PriceSheet,
  units: number,
): MeterState {
  requireNonNegativeCount(units, "units");
  requireNonNegativeAmount(priceSheet.perUnit, "priceSheet.perUnit");

  const cost = priceSheet.perUnit * BigInt(units);

  return {
    ...state,
    accruedUnpaid: state.accruedUnpaid + cost,
    totalAccrued: state.totalAccrued + cost,
    deliveredUnits: state.deliveredUnits + units,
  };
}

/**
 * Settle `amount` from `state.accruedUnpaid` against the clock and return the
 * new state. The settled amount is subtracted from the unpaid bucket, the
 * tick clock is restarted at `clock.now()`, and total accrual is left
 * unchanged so the stream-life total remains intact for reporting.
 *
 * `amount` must be non-negative and must not exceed `accruedUnpaid`: the
 * policy is what computes the demanded amount, and it always equals
 * `accruedUnpaid` at demand time, so overpaying here would be a logic bug,
 * not a configuration.
 */
export function settle(
  state: MeterState,
  amount: SmallestUnits,
  clock: Clock,
): MeterState {
  requireNonNegativeAmount(amount, "amount");
  if (amount > state.accruedUnpaid) {
    throw new RangeError(
      `settle: amount ${amount} exceeds accruedUnpaid ${state.accruedUnpaid}`,
    );
  }

  return {
    ...state,
    accruedUnpaid: state.accruedUnpaid - amount,
    lastPaidAtMs: clock.now(),
  };
}
