import type { Address, IsoTimestamp, SmallestUnits } from "./primitives.js";

/**
 * The prices a seller charges for one metered stream, quoted in the smallest
 * unit of `token`.
 *
 * A price sheet is served at stream open and pinned for the life of that
 * stream: a mid-stream price change ends the stream rather than repricing
 * usage already accrued. `id` plus `version` identify the exact sheet a
 * segment was accrued against, so buyer and seller meters can be compared.
 */
export type PriceSheet = {
  /** Stable identifier for this sheet across versions. */
  id: string;
  /** Monotonic version of `id`; a bump means the seller changed prices. */
  version: number;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /** Charged once per delivered segment. */
  perCall: SmallestUnits;
  /** Charged per whole second of delivery. */
  perSecond: SmallestUnits;
  /** Charged per delivered unit, as counted by `unitName`. */
  perUnit: SmallestUnits;
  /** Names what `perUnit` counts, e.g. `"token"` or `"frame"`. */
  unitName: string;
  issuedAt: IsoTimestamp;
};
