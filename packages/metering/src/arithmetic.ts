/**
 * The integer arithmetic every amount in this package goes through.
 *
 * ## The rounding rule
 *
 * **Round half up to the nearest smallest unit.** One rule, applied everywhere
 * a price meets a quantity that does not divide evenly — per-second cost over
 * fractional seconds is the only place it currently bites, but it is stated
 * once here so a second dimension cannot quietly pick a different one.
 *
 * The rationale is agreement, not accuracy. The buyer's mirror meter and the
 * seller's meter run the same arithmetic over the same pinned price sheet and
 * the same observed consumption; if they round differently they disagree by a
 * unit on exactly the segments where the tolerance check is tightest, and a
 * correct seller gets refused. Half-up is chosen over half-even because it is
 * the rule a human reimplementing this from the prose will pick.
 *
 * Deliberately *not* half up: limits. {@link applyBasisPoints} floors, because
 * a budget ceiling rounded up is a ceiling above the one that was configured.
 *
 * ## No floats
 *
 * Nothing here converts a `number` to an amount by arithmetic. Fractions that
 * arrive from configuration (a budget margin, an overcharge tolerance) are
 * converted once, at the boundary, into exact basis points via decimal string
 * formatting — never multiplied into a `bigint`.
 */

/** Denominator of a basis-point fraction: 10000 bp = 1. */
export const BASIS_POINTS_SCALE = 10_000n;

/** Decimal places of a fraction that survive conversion to basis points. */
const BASIS_POINT_DECIMALS = 4;

/**
 * `numerator / denominator`, rounded half up.
 *
 * Both arguments are non-negative by construction — prices, quantities, and
 * durations are all non-negative — and negative inputs throw rather than pick
 * a tie-breaking direction nobody asked for.
 */
export function divideRoundHalfUp(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (numerator < 0n) {
    throw new RangeError(
      `divideRoundHalfUp: numerator must be non-negative, received ${numerator}`,
    );
  }
  if (denominator <= 0n) {
    throw new RangeError(
      `divideRoundHalfUp: denominator must be positive, received ${denominator}`,
    );
  }

  // floor((2n + d) / 2d) is round-half-up for non-negative n.
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * `amount × basisPoints / 10000`, rounded **down**.
 *
 * Used to derive limits and allowances, where rounding toward zero is the
 * conservative direction: a floored budget never exceeds the budget that was
 * configured, and a floored tolerance never admits an overcharge the operator
 * did not authorize.
 */
export function applyBasisPoints(amount: bigint, basisPoints: bigint): bigint {
  // A negative `amount` is a type-shaped error — the caller almost certainly
  // passed a signed value into an unsigned-amount slot. Surface it as a
  // `TypeError` so the misconfiguration is visible at the call site rather
  // than silently turning a refund into a zero-multiplied signed amount.
  // (`requireNonNegativeAmount` covers the not-a-bigint case but maps
  // negative bigints to `RangeError`; this function wants the strict
  // non-negativity contract to be `TypeError`-shaped for both.)
  if (typeof amount !== "bigint") {
    throw new TypeError(
      `applyBasisPoints: amount must be a bigint in smallest units, received ${typeof amount}`,
    );
  }
  if (amount < 0n) {
    throw new TypeError(
      `applyBasisPoints: amount must be non-negative, received ${amount}`,
    );
  }
  if (basisPoints < 0n) {
    throw new RangeError(
      `applyBasisPoints: basisPoints must be non-negative, received ${basisPoints}`,
    );
  }

  return (amount * basisPoints) / BASIS_POINTS_SCALE;
}

/**
 * Convert a configured fraction in `[0, 1]` to exact basis points.
 *
 * The conversion goes through a fixed-point decimal string rather than
 * `fraction * 10000`, so no float multiplication produces the integer that
 * later scales an amount. Precision beyond four decimals is not representable
 * in basis points and is dropped by the formatting, which is the whole reason
 * the knob is documented in basis points downstream.
 */
export function fractionToBasisPoints(fraction: number): bigint {
  if (!Number.isFinite(fraction)) {
    throw new RangeError(
      `fractionToBasisPoints: fraction must be finite, received ${fraction}`,
    );
  }
  if (fraction < 0 || fraction > 1) {
    throw new RangeError(
      `fractionToBasisPoints: fraction must be within [0, 1], received ${fraction}`,
    );
  }

  // Truncate to four decimals via string formatting rather than `toFixed`.
  // `Number.toFixed(4)` rounds the IEEE-754 representation before
  // formatting, so `0.20005.toFixed(4)` becomes `"0.2001"` and the
  // basis-point value drifts up by one. We want truncation, not rounding,
  // because a budget configured at 20.005% should behave as 20.0%, not as
  // 20.1%. The path is: format with one extra decimal of precision via
  // `toFixed`, then drop the last digit. The extra digit absorbs any single
  // ULP of float rounding inside `toFixed`; if the user-configured fraction
  // is genuinely more than 4 decimals precise, the precision is unrepresentable
  // in basis points and dropping it is the documented behavior.
  const fixed = fraction.toFixed(BASIS_POINT_DECIMALS + 1);
  const [whole = "0", decimals = ""] = fixed.split(".");
  const truncated = decimals.slice(0, BASIS_POINT_DECIMALS);

  return (
    BigInt(whole) * BASIS_POINTS_SCALE +
    BigInt(truncated.padEnd(BASIS_POINT_DECIMALS, "0"))
  );
}

/** Guard for a token amount: a non-negative `bigint` in smallest units. */
export function requireNonNegativeAmount(amount: bigint, name: string): void {
  if (typeof amount !== "bigint") {
    throw new TypeError(
      `${name} must be a bigint in smallest units, received ${typeof amount}`,
    );
  }
  if (amount < 0n) {
    throw new RangeError(`${name} must be non-negative, received ${amount}`);
  }
}

/**
 * Guard for a counted quantity — calls, units, milliseconds.
 *
 * Rejects non-integers outright instead of rounding them, so a caller that
 * computed a quantity in floating point finds out here rather than at the
 * point where two meters disagree by a unit.
 */
export function requireNonNegativeCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${name} must be a safe integer, received ${value}. ` +
        `Fractional quantities must be converted at the boundary, not rounded here.`,
    );
  }
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative, received ${value}`);
  }
}
