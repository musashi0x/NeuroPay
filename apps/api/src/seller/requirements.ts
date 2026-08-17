/**
 * 402 generation (5.4).
 *
 * The shared policy in `@neuro-pay/metering` decides whether to demand
 * payment; this module is the `accepts[]` shape that goes on the wire.
 *
 * Single accepts[] entry, permit2 rail, small `maxTimeoutSeconds` (≤480,
 * specifically 60 here so a slow buyer retry cannot be re-priced against
 * a moved clock). `resource` is the request URL with the stream id in
 * the path; `description` is the unit name from the pinned price sheet.
 *
 * `accepts[]` carries one entry by design: the permit2-exact rail is the
 * only rail implemented on BNB (see design.md §5), and a buyer's
 * "wrong chain" or "no payable option" classifications need a single,
 * unambiguous target to fail against.
 */

import type {
  Address,
  PriceSheet,
  SmallestUnits,
  X402Extra,
  X402PaymentRequired,
  X402Rail,
  X402Requirement,
} from "@neuro-pay/types";

const PERMIT2_RAIL: X402Rail = "permit2";
const SCHEME = "exact" as const;
const MAX_TIMEOUT_SECONDS = 60;
const ABSOLUTE_MAX_TIMEOUT_SECONDS = 480;

export type BuildRequirementsInput = {
  amount: SmallestUnits;
  /** The chain id read from the pinned price sheet. */
  chainId: number;
  /** URL the client used to ask for this segment. */
  resource: string;
  /** The token from the pinned price sheet. */
  token: Address;
  tokenDecimals: number;
  /** Recipient bound into the witness of every payment. */
  payTo: Address;
  /** A human-readable description of what the payment buys. */
  description: string;
  /** Resource MIME type the segment will be served as. */
  mimeType?: string;
  /** Network label (e.g. `"bsc-testnet"`); the chain id is authoritative. */
  network?: string;
  /** Optional EIP-712 extra fields; Permit2 needs the typed-data domain. */
  extra?: X402Extra | null;
};

/**
 * Validate a value looks like an http(s) url. Used by the request URL path
 * before it gets written into the wire `resource` field.
 */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the `402` body. Always returns the same shape for a given input
 * so a buyer that retries with the same nonce sees the same requirements.
 */
export function buildPaymentRequired(
  input: BuildRequirementsInput,
): X402PaymentRequired {
  const requirement: X402Requirement = {
    scheme: SCHEME,
    network: input.network ?? defaultNetworkFor(input.chainId),
    chainId: input.chainId,
    rail: PERMIT2_RAIL,
    asset: input.token,
    assetDecimals: input.tokenDecimals,
    maxAmountRequired: input.amount,
    payTo: input.payTo,
    resource: input.resource,
    description: input.description,
    mimeType: input.mimeType ?? "application/octet-stream",
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: input.extra ?? null,
  };
  return {
    x402Version: 1,
    error: null,
    accepts: [requirement],
  };
}

/**
 * Defensive constructor: rejects malformed inputs that the route layer
 * would not catch before they reach `buildPaymentRequired`.
 */
export function assertRequirementsInputs(input: BuildRequirementsInput): void {
  if (input.amount < 0n) {
    throw new RangeError("requirements: amount must be non-negative");
  }
  if (!isHttpUrl(input.resource)) {
    throw new TypeError(
      `requirements: resource must be a http(s) URL (got ${JSON.stringify(input.resource)})`,
    );
  }
  if (!input.payTo.startsWith("0x") || input.payTo.length !== 42) {
    throw new TypeError(
      "requirements: payTo must be a 0x-prefixed 20-byte address",
    );
  }
  if (MAX_TIMEOUT_SECONDS > ABSOLUTE_MAX_TIMEOUT_SECONDS) {
    // Sanity-check the constant against the wire cap; flipped here so a
    // future edit that raises MAX_TIMEOUT_SECONDS past 480 cannot ship.
    throw new RangeError(
      "MAX_TIMEOUT_SECONDS exceeded the wire cap (480); relax before raising",
    );
  }
}

/**
 * Build a `resource` for a `402` on a stream's next-segment endpoint.
 *
 * `requestUrl` is normally the Hono request URL (e.g. `https://api/v1/streams/abc/next`).
 * The path is left as-is so the buyer can deduplicate demands across
 * retries; the segment URL is the natural scope of "this payment buys
 * this segment".
 */
export function buildSegmentResource(input: {
  requestUrl: string;
  streamId: string;
}): string {
  return input.requestUrl;
}

/** Map a chain id to its conventional network label. */
export function defaultNetworkFor(chainId: number): string {
  switch (chainId) {
    case 97:
      return "bsc-testnet";
    case 56:
      return "bsc";
    default:
      return `chain-${chainId}`;
  }
}

/**
 * Pull the `description` from a pinned price sheet. The unit name is the
 * meter-aligned label a buyer can read on its own meter without an extra
 * round trip.
 */
export function descriptionForPriceSheet(sheet: PriceSheet): string {
  return `${sheet.unitName} usage on stream`;
}

export function asSegmentUrl(value: string): string {
  if (!isHttpUrl(value)) {
    throw new TypeError(
      `asSegmentUrl: value must be a http(s) URL (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

export type JsonSafePaymentRequired = {
  x402Version: number;
  error: string | null;
  accepts: JsonSafeRequirement[];
};

export type JsonSafeRequirement = {
  scheme: "exact";
  network: string;
  chainId: number;
  rail: X402Rail;
  asset: Address;
  assetDecimals: number;
  maxAmountRequired: string;
  payTo: Address;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: X402Extra | null;
};

/**
 * Convert a `402` body to JSON-safe values. `bigint` amounts become
 * decimal strings; every other field is already JSON-native.
 *
 * Centralized so the route does not have to walk the response to
 * serialize it, and so a future addition of a `bigint` field cannot
 * ship unconverted.
 */
export function stringifyPaymentRequired(
  body: X402PaymentRequired,
): JsonSafePaymentRequired {
  return {
    x402Version: body.x402Version,
    error: body.error,
    accepts: body.accepts.map((req) => ({
      scheme: req.scheme,
      network: req.network,
      chainId: req.chainId,
      rail: req.rail,
      asset: req.asset,
      assetDecimals: req.assetDecimals,
      maxAmountRequired: req.maxAmountRequired.toString(10),
      payTo: req.payTo,
      resource: req.resource,
      description: req.description,
      mimeType: req.mimeType,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    })),
  };
}
