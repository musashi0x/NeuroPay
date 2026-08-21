import type { Address, IsoTimestamp, SmallestUnits } from "./primitives.js";

/**
 * Spend for one session and token over the current window, against both
 * limits that can stop a payment.
 *
 * The two limits are reported separately and never collapsed into one number.
 * The local budget sits below the on-chain cap so exhaustion is a clean,
 * logged refusal to sign; the on-chain cap is the backstop against our own
 * code being wrong, and hitting it means a reverted settlement after delivery.
 */
export type BudgetState = {
  token: Address;
  tokenDecimals: number;
  /** ERC-20 symbol of `token`, from config, for display. */
  tokenSymbol: string;
  /** Window start, aligned to the session's spend `period`. */
  windowStart: IsoTimestamp;
  /** Window end; the window rolls at this instant. */
  windowEnd: IsoTimestamp;
  periodSeconds: number;
  /** Spend in this window, counting signed-but-unconfirmed payments. */
  spent: SmallestUnits;
  /** Local limit: the on-chain cap less the configured margin. */
  localLimit: SmallestUnits;
  /** `localLimit - spent`, clamped at 0. */
  localRemaining: SmallestUnits;
  /** The session's on-chain `spend.limit` for this period. */
  onChainCap: SmallestUnits;
  /** `onChainCap - spent`, clamped at 0. */
  onChainRemaining: SmallestUnits;
  /** True when `localRemaining` is 0; signing must refuse. */
  exhausted: boolean;
};
