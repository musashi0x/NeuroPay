/**
 * Spend-limit derivation.
 *
 * Operators configure caps as whole tokens in human-readable form (e.g.
 * "50 USDC per day"). The on-chain `permissions.spend[].limit` field is in
 * smallest units — `50n * 10n ** 18n` on a chain where the token has 18
 * decimals. Forgetting the conversion is the classic "10^12 too small"
 * bug that surfaces only at the first payment.
 *
 * The derivation lives in its own module so the test file can exercise
 * exactly the function the grant path uses, without standing up the SDK.
 */

import type { SmallestUnits } from "@neuro-pay/types";

/** Raised when a spend cap cannot be turned into a valid on-chain limit. */
export class SpendLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendLimitError";
  }
}

/**
 * Convert a whole-token spend cap into the on-chain smallest units.
 *
 *   wholeTokens = 50n, decimals = 18   -> 50n * 10n**18n
 *   wholeTokens = 50n, decimals = 6    -> 50n * 10n**6n   (50_000_000n)
 *
 * Throws `SpendLimitError` on a negative whole-token value — the on-chain
 * limit is unsigned, and a negative cap is either a sign error or a
 * misconfig.
 */
export function deriveSpendLimit(
  wholeTokens: bigint,
  decimals: number,
): SmallestUnits {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new SpendLimitError(
      `token decimals must be an integer in [0, 36]; got ${decimals}`,
    );
  }
  if (wholeTokens < 0n) {
    throw new SpendLimitError(
      `whole-token spend cap must be non-negative; got ${wholeTokens.toString()}`,
    );
  }
  return wholeTokens * 10n ** BigInt(decimals);
}
