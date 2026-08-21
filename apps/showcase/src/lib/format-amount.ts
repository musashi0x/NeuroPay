/**
 * Integer-only amount formatter.
 *
 * Mirrors `apps/web/src/lib/format-amount.ts`. Private copy because
 * the apps do not share a `lib/` package; the contract is small
 * enough to keep in sync by hand.
 */
export type FormattedAmount = {
  human: string;
  raw: string;
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
