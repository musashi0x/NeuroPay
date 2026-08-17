/** A `0x`-prefixed, 20-byte EVM address. */
export type Address = `0x${string}`;

/** Arbitrary `0x`-prefixed hex data. */
export type Hex = `0x${string}`;

/** An ISO-8601 UTC timestamp with millisecond precision, e.g. `2026-08-17T09:41:12.004Z`. */
export type IsoTimestamp = string;

/**
 * A token amount in the smallest indivisible unit of its token.
 *
 * Never a human-readable decimal. Converting to a display value requires the
 * `tokenDecimals` that travels alongside every amount in these wire types —
 * decimals differ per chain (18 on BNB, 6 on Ethereum USDC) and a hard-coded
 * literal is a ~10^12 error, not a rounding error.
 */
export type SmallestUnits = bigint;
