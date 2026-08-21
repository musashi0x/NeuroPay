/**
 * The buyer-side budget mirror.
 *
 * ## What the budget is
 *
 * A local ceiling on per-period spend that sits below the session's on-chain
 * `spend.limit` by the configured margin. The on-chain cap is the backstop
 * against our own arithmetic being wrong; the local budget is what makes the
 * common case (slow drift toward the cap) a clean refusal to sign rather
 * than a reverted settlement after delivery.
 *
 * ## Why a margin and not a flat discount
 *
 * The cap is in token units and the margin is dimensionless — a 20% margin
 * on a 50-token cap is a 10-token cushion that scales with the cap. A flat
 * subtraction would either be tiny on a large cap or a quarter of the cap on
 * a small one, and the wrong choice either way is a denial-of-service or a
 * missed backstop.
 *
 * ## Window alignment
 *
 * The window aligns to the on-chain period the same way the chain does:
 * `windowStart = floor(now / periodMs) * periodMs`. Aligning the buyer's
 * window to the chain's window keeps a payment demanded just after a chain
 * roll from being double-counted against the buyer's local window. The roll
 * is computed at read time, not pushed by a timer, so the budget is still
 * correct after the process sleeps through a roll.
 *
 * ## Pre-sign check
 *
 * The check is "would `spent + amount` exceed `localLimit`?" with an explicit
 * refusal classification. The refusal is a value the caller maps to a
 * payment failure, not an exception: a refusal is an expected operational
 * outcome, not a programming error.
 */

import {
  applyBasisPoints,
  fractionToBasisPoints,
  requireNonNegativeAmount,
} from "./arithmetic.js";
import type { Clock } from "./clock.js";
import type { Address, BudgetState, SmallestUnits } from "@neuro-pay/types";

/**
 * Why a payment was refused before signing. Distinct classifications matter
 * because the operator needs to tell "we hit the cap" (a budget problem,
 * maybe raise it) from "we are about to hit the cap" (a margin problem,
 * maybe widen the margin) and from "we're misconfigured" (a margin problem,
 * but a different one).
 */
export type BudgetRefusalReason =
  "over-local-budget" | "over-on-chain-cap" | "margin-out-of-range";

/**
 * The input shape for a budget check. Carries the live window state plus
 * the configuration that drove it, so a refusal can cite the limit it ran
 * into without the caller having to thread extra context.
 */
export type BudgetCheckInput = {
  /** The live budget window state — read or freshly rolled. */
  state: BudgetState;
  /** The amount the buyer is about to authorize. */
  amount: SmallestUnits;
};

/**
 * The output of a budget check: either signing may proceed, or signing is
 * refused with the reason. The refusal is a value, not an exception.
 */
export type BudgetCheckResult =
  { ok: true } | { ok: false; reason: BudgetRefusalReason };

const MS_PER_SECOND = 1000n;

/**
 * The inputs to compute a budget window.
 */
export type BudgetConfig = {
  /** The on-chain `spend.limit` per period, in smallest units. */
  spendCap: SmallestUnits;
  /** The on-chain `spend.period`, in seconds. */
  spendPeriodSeconds: number;
  /** Fraction of the on-chain cap held back as local headroom, in `[0, 1)`. */
  budgetMargin: number;
  /** Token the budget tracks. Recorded on the state for reporting. */
  token: Address;
  /** Decimals of `token`, for human reporting alongside raw units. */
  tokenDecimals: number;
  /** ERC-20 symbol of `token`. Optional here; the console fills it from chain config. */
  tokenSymbol?: string;
};

/**
 * Compute the local budget limit from the on-chain cap and the configured
 * margin.
 *
 * `localLimit = floor(spendCap × (1 - margin))`. The floor is deliberate:
 * the local budget must not exceed the cap after margin, and a ceiling
 * rounded up is a ceiling above the one configured.
 *
 * Throws if `margin` is outside `[0, 1)` — a negative margin widens the
 * budget past the cap, and a margin of 1 zeroes it. Both are misconfigurations
 * to surface at startup, not silent failures at run time.
 */
export function computeLocalLimit(
  spendCap: SmallestUnits,
  budgetMargin: number,
): SmallestUnits {
  requireNonNegativeAmount(spendCap, "spendCap");
  if (budgetMargin < 0 || budgetMargin >= 1) {
    throw new RangeError(
      `computeLocalLimit: budgetMargin must be in [0, 1), received ${budgetMargin}`,
    );
  }

  // floor(spendCap × (1 - margin)): the complement of margin, in basis points.
  const retention = BASIS_POINTS_SCALE - fractionToBasisPoints(budgetMargin);
  return applyBasisPoints(spendCap, retention);
}

/** Re-exported locally so this file is readable without the arithmetic import. */
const BASIS_POINTS_SCALE = 10_000n;

/**
 * Roll the budget window to align with `now` and return a fresh state.
 *
 * If `now` is still inside the current window the state is returned unchanged.
 * If `now` has crossed `windowEnd`, `spent` is reset and `windowStart` /
 * `windowEnd` are advanced to the window containing `now`.
 *
 * The roll is idempotent: calling it repeatedly with the same `now` returns
 * the same state, so the budget is safe to read-and-roll on every segment.
 */
export function rollBudgetWindow(state: BudgetState, now: number): BudgetState {
  const windowStartMs = Date.parse(state.windowStart);
  const windowEndMs = Date.parse(state.windowEnd);

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    throw new RangeError(
      `rollBudgetWindow: window timestamps are not valid ISO strings`,
    );
  }

  if (now < windowEndMs) {
    return state;
  }

  // Advance to the window containing `now`, aligned to periodMs boundaries.
  const periodMs = BigInt(state.periodSeconds) * MS_PER_SECOND;
  const nowMs = BigInt(now);
  const newStartMs = (nowMs / periodMs) * periodMs;

  // If the existing window is still valid for `now`, keep it; only reset on
  // a real advance. This keeps the boundary idempotent at the exact roll
  // instant.
  if (newStartMs === BigInt(windowStartMs) && now < windowEndMs) {
    return state;
  }

  return {
    ...state,
    windowStart: new Date(Number(newStartMs)).toISOString(),
    windowEnd: new Date(Number(newStartMs + periodMs)).toISOString(),
    spent: 0n,
    localRemaining: state.localLimit,
    onChainRemaining: state.onChainCap,
    exhausted: state.localLimit === 0n,
  };
}

/**
 * Read the current budget state, rolling the window first so a read after
 * the period boundary always sees the fresh window.
 */
export function readBudgetState(
  config: BudgetConfig,
  clock: Clock,
  current: BudgetState,
): BudgetState {
  const rolled = rollBudgetWindow(current, clock.now());
  return rolled;
}

/**
 * Build the initial budget state for a freshly granted session.
 *
 * `spent` starts at zero; the window is anchored at the session open time
 * rounded down to the period boundary. `localLimit` and `onChainRemaining`
 * are derived from the cap and the configured margin.
 */
export function initializeBudget(
  config: BudgetConfig,
  clock: Clock,
): BudgetState {
  requireNonNegativeAmount(config.spendCap, "spendCap");
  if (config.spendPeriodSeconds <= 0) {
    throw new RangeError(
      `initializeBudget: spendPeriodSeconds must be positive, received ${config.spendPeriodSeconds}`,
    );
  }

  const localLimit = computeLocalLimit(config.spendCap, config.budgetMargin);
  const now = clock.now();
  const periodMs = BigInt(config.spendPeriodSeconds) * MS_PER_SECOND;
  const windowStartMs = (BigInt(now) / periodMs) * periodMs;
  const windowEndMs = windowStartMs + periodMs;

  return {
    token: config.token,
    tokenDecimals: config.tokenDecimals,
    tokenSymbol: config.tokenSymbol ?? "token",
    windowStart: new Date(Number(windowStartMs)).toISOString(),
    windowEnd: new Date(Number(windowEndMs)).toISOString(),
    periodSeconds: config.spendPeriodSeconds,
    spent: 0n,
    localLimit,
    localRemaining: localLimit,
    onChainCap: config.spendCap,
    onChainRemaining: config.spendCap,
    exhausted: localLimit === 0n,
  };
}

/**
 * Record a payment against the budget window and return the updated state.
 *
 * The amount is added to `spent` and the remaining figures are recomputed.
 * Recording is a separate step from the pre-sign check so a successful check
 * can be made visible: the refusal is a refusal, the success is a deduction.
 *
 * Recording more than the local limit overshoots `spent` and the remaining
 * fields go to zero (clamped, never negative); the call does not refuse here,
 * because refusal is the pre-sign check's job.
 */
export function recordPayment(
  state: BudgetState,
  amount: SmallestUnits,
): BudgetState {
  requireNonNegativeAmount(amount, "amount");
  const newSpent = state.spent + amount;
  const localRemaining =
    newSpent >= state.localLimit ? 0n : state.localLimit - newSpent;
  const onChainRemaining =
    newSpent >= state.onChainCap ? 0n : state.onChainCap - newSpent;

  return {
    ...state,
    spent: newSpent,
    localRemaining,
    onChainRemaining,
    exhausted: localRemaining === 0n,
  };
}

/**
 * Pre-sign check: would signing `amount` against `state` exceed the local
 * budget or the on-chain cap?
 *
 * The local budget is checked first: it is the tighter ceiling. The on-chain
 * cap is checked as a backstop in case the local limit drifted above the cap
 * (which only happens on a misconfiguration, but the budget should refuse
 * the misconfigured case loudly rather than sign and revert).
 *
 * Returns `{ ok: true }` if signing may proceed; otherwise an explicit
 * refusal the caller can surface as a payment-failure classification.
 */
export function preSignCheck(input: BudgetCheckInput): BudgetCheckResult {
  const { state, amount } = input;
  requireNonNegativeAmount(amount, "amount");

  if (state.spent + amount > state.localLimit) {
    return { ok: false, reason: "over-local-budget" };
  }
  if (state.spent + amount > state.onChainCap) {
    return { ok: false, reason: "over-on-chain-cap" };
  }
  return { ok: true };
}
