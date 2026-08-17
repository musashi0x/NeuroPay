/**
 * The threshold-or-tick settlement policy.
 *
 * ## What the policy is
 *
 * A pure function over the meter's accrual state and an injected clock. It
 * returns either `{ demand: 0n }` (no settlement needed right now) or
 * `{ demand: accruedUnpaid }` (the whole unpaid bucket, exactly). The
 * demand is whole-bucket by construction: any partial settlement breaks the
 * invariant that `accruedUnpaid - settled = 0` after the next demand, and
 * half-paid buckets are exactly where rounding disagreements become visible.
 *
 * ## When the policy fires
 *
 * - **Threshold.** `accruedUnpaid ≥ settlementThreshold` — the buyer is about
 *   to receive enough work to justify a settlement, and holding the credit
 *   longer is unbounded risk on the seller.
 * - **Tick.** `now - lastPaidAt ≥ tickIntervalSeconds × 1000` — even on a
 *   slow stream where the threshold never trips, the seller collects on a
 *   timer so exposure is bounded by `threshold × maxInFlightSettlements`.
 *
 * Whichever fires first wins. Both are evaluated from the same `now` so the
 * decision is deterministic and reproducible.
 *
 * ## Idle streams
 *
 * A stream with `accruedUnpaid = 0n` never demands. The tick fires, the
 * policy reads zero accrual, and the function returns no demand. This is the
 * one place where the threshold-or-tick design quietly does what it says:
 * "settle when there is something to settle, not on a timer regardless".
 *
 * ## Settlement baseline
 *
 * `lastPaidAtMs === null` is the initial state. On the first call after
 * creation the tick has not yet "elapsed" because no time has been budgeted
 * for it, so the policy demands only on threshold. The first settle stamps
 * `lastPaidAtMs`, and subsequent ticks measure from there.
 */

import { requireNonNegativeAmount } from "./arithmetic.js";
import type { Clock } from "./clock.js";
import type { MeterState } from "./accrual.js";
import type { MeteringConfig, SmallestUnits } from "@neuro-pay/types";

/**
 * The output of the policy: either nothing is owed right now, or a demanded
 * amount the buyer must sign for.
 *
 * The shape (object, not `bigint | null`) keeps the call site uniform and
 * lets a future variant add `reason: "threshold" | "tick"` without breaking
 * existing destructures.
 */
export type PolicyDecision =
  | { demand: 0n; reason: "idle" | "below-threshold" | "below-tick" }
  | { demand: SmallestUnits; reason: "threshold" | "tick" };

const MS_PER_SECOND = 1000n;
const ZERO = 0n as const;

/**
 * Evaluate the threshold-or-tick policy against `state` at `clock.now()`.
 *
 * Returns `{ demand: 0n }` if `accruedUnpaid` is zero (an idle stream never
 * settles), if both conditions are unmet, or if the tick has not yet elapsed
 * since the last settlement. Otherwise returns the full `accruedUnpaid`
 * tagged with which condition fired.
 *
 * `settlementThreshold` and `tickIntervalSeconds` come from `MeteringConfig`
 * — they are policy inputs, not policy. `state.lastPaidAtMs === null` is
 * treated as "tick has never elapsed" so a fresh meter only fires on
 * threshold.
 */
export function evaluatePolicy(
  state: MeterState,
  config: MeteringConfig,
  clock: Clock,
): PolicyDecision {
  requireNonNonNegativeThreshold(config.settlementThreshold);

  if (state.accruedUnpaid === ZERO) {
    return { demand: 0n, reason: "idle" };
  }

  // Threshold first: it is the cheaper check and the one that should govern
  // cheap, fast streams. Tick is the backstop on slow traffic.
  if (state.accruedUnpaid >= config.settlementThreshold) {
    return { demand: state.accruedUnpaid, reason: "threshold" };
  }

  const now = clock.now();
  if (state.lastPaidAtMs !== null) {
    const elapsedMs = BigInt(now - state.lastPaidAtMs);
    const tickMs = BigInt(config.tickIntervalSeconds) * MS_PER_SECOND;
    if (elapsedMs >= tickMs) {
      return { demand: state.accruedUnpaid, reason: "tick" };
    }
  }

  return { demand: 0n, reason: "below-threshold" };
}

function requireNonNonNegativeThreshold(value: bigint): void {
  requireNonNegativeAmount(value, "settlementThreshold");
}
