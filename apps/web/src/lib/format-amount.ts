/**
 * Shared amount formatter for the stream console.
 *
 * Every displayed amount goes through this helper so a 18-decimal BNB
 * token and a 6-decimal Ethereum token never get a hard-coded `/ 1e18`.
 * Arithmetic is integer-only: the human value is `amount / 10^decimals`
 * with the remainder padded, never `Number(amount)`.
 */

export type FormattedAmount = {
  /** Exact decimal string, e.g. `"50.000000000000000000"`. */
  human: string;
  /** Exact smallest-unit decimal string. */
  raw: string;
  /** Human value plus optional symbol, e.g. `"50 USDT"`. */
  labelled: string;
};

export function formatAmount(
  amount: bigint,
  decimals: number,
  symbol?: string,
): FormattedAmount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(
      `formatAmount: decimals must be an integer in [0, 36], received ${decimals}`,
    );
  }

  const zero = BigInt(0);
  const negative = amount < zero;
  const abs = negative ? -amount : amount;
  const raw = amount.toString(10);

  let human: string;
  if (decimals === 0) {
    human = abs.toString(10);
  } else {
    const scale = BigInt(10) ** BigInt(decimals);
    const whole = abs / scale;
    const fraction = (abs % scale).toString(10).padStart(decimals, "0");
    human = `${whole.toString(10)}.${fraction}`;
  }
  if (negative) human = `-${human}`;

  const trimmed = trimTrailingZeros(human);
  const labelled = symbol ? `${trimmed} ${symbol}` : trimmed;
  return { human, raw, labelled };
}

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}
