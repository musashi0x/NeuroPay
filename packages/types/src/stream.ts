import type { Address, IsoTimestamp, SmallestUnits } from "./primitives.js";
import type { PriceSheet } from "./pricing.js";

/** Why a stream stopped delivering. A stream never resumes after ending. */
export type StreamEndReason =
  | "completed"
  | "price-changed"
  | "session-expired"
  | "session-revoked"
  | "budget-exhausted"
  | "exposure-limit"
  | "seller-error"
  | "abandoned";

/**
 * Console/API lifecycle of a stream.
 *
 * Derived from `endReason`, never stored separately, so the ledger's
 * `stream.ended` / `stream.abandoned` events and this view cannot
 * disagree. `abandoned` is first-class: collapsing it into `ended`
 * hides the idle-sweep outcome the operator is looking for.
 */
export type StreamStatus = "active" | "ended" | "abandoned";

/** Project `endReason` onto the three-state console lifecycle. */
export function streamStatusFromEndReason(
  endReason: StreamEndReason | null,
): StreamStatus {
  if (endReason === null) return "active";
  if (endReason === "abandoned") return "abandoned";
  return "ended";
}

/**
 * The response to opening a stream (`POST /v1/streams`).
 *
 * Carries everything a buyer needs to run its own mirror meter and to size a
 * payment without a second round trip: the pinned price sheet, the settlement
 * token and its decimals, the chain, and the recipient bound into every
 * payment witness.
 */
export type StreamOpenResponse = {
  streamId: string;
  /** Pinned at open; segments accrue against this sheet for the stream's life. */
  priceSheet: PriceSheet;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /** The recipient bound into the Permit2 witness of every payment. */
  payTo: Address;
  openedAt: IsoTimestamp;
  /** Hard stop for the stream, never later than the session expiry. */
  expiresAt: IsoTimestamp;
  /** Upper bound on seconds one segment may cover. */
  maxSecondsPerSegment: number;
  /** Upper bound on units one segment may deliver. */
  maxUnitsPerSegment: number;
};

/**
 * A delivered segment (`GET /v1/streams/:id/next` returning 200).
 *
 * A segment covers up to `maxSecondsPerSegment` seconds or
 * `maxUnitsPerSegment` units, whichever ends first; the actual amounts
 * delivered are reported here so the buyer's mirror meter accrues from
 * observed consumption rather than from the seller's arithmetic.
 */
export type SegmentResponse = {
  streamId: string;
  /** Monotonic, gap-free index of this segment within the stream. */
  sequence: number;
  /** The delivered payload. */
  data: string;
  secondsDelivered: number;
  unitsDelivered: number;
  /** Cost accrued and not yet covered by a settled payment. */
  accruedUnpaid: SmallestUnits;
  /** Cost accrued over the stream's whole life, paid and unpaid. */
  totalAccrued: SmallestUnits;
  /** True when this is the last segment; `endReason` is then non-null. */
  streamEnded: boolean;
  endReason: StreamEndReason | null;
};

/**
 * Console view of one stream. Amounts stay `bigint`; the HTTP boundary
 * stringifies them. `segmentProducer` never appears here.
 */
export type StreamView = {
  streamId: string;
  status: StreamStatus;
  endReason: StreamEndReason | null;
  priceSheet: PriceSheet;
  /** ERC-20 symbol of the stream's settlement token, from seller config. */
  tokenSymbol: string;
  accruedUnpaid: SmallestUnits;
  totalAccrued: SmallestUnits;
  deliveredCalls: number;
  deliveredSeconds: number;
  deliveredUnits: number;
  /** Seconds until the tick policy would fire; 0 if already due. */
  secondsUntilNextTick: number;
  inFlightSettlements: number;
  openedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
};
