import type { Address, SmallestUnits } from "./primitives.js";

/**
 * The settlement rail a requirement is payable over.
 *
 * `permit2` is the only rail implemented on BNB: EIP-3009 needs an
 * ERC-1271-aware token implementation, which BNB's tokens are not.
 */
export type X402Rail = "permit2" | "eip3009";

/**
 * The `extra.assetTransferMethod` label a b402 merchant publishes to say
 * which on-chain rail its 402 is payable over. The SDK dispatches on this
 * before it falls back to reading `scheme`.
 */
export type X402AssetTransferMethod = "permit2-exact" | "permit2" | "eip3009";

/** Extra typed-data context a merchant may attach to a requirement. */
export type X402Extra = {
  /** EIP-712 domain name of the verifying contract, when the rail needs one. */
  name: string | null;
  /** EIP-712 domain version, when the rail needs one. */
  version: string | null;
  verifyingContract: Address | null;
  /**
   * The address bound as the Permit2 `spender` in the signature.
   *
   * Permit2 requires the signed `spender` to equal `msg.sender` of whoever
   * calls `permitWitnessTransferFrom` — the merchant's settler EOA, which is
   * a third address distinct from both the payer and `payTo`. A buyer that
   * guesses this wrong produces a signature that reverts on chain, so the
   * merchant has to publish it in the 402.
   */
  spenderAddress?: Address | null;
  /** Which rail this option is payable over; the SDK's primary rail selector. */
  assetTransferMethod?: X402AssetTransferMethod | null;
};

/**
 * One payable option from a `402` response's `accepts[]`.
 *
 * A buyer selects among these by chain then rail, and fails explicitly rather
 * than silently when nothing matches — no payable option, a wrong-chain-only
 * offer, and an unpermitted token are three distinct outcomes.
 */
export type X402Requirement = {
  /** Only `"exact"` is supported: the amount is fixed, not a maximum to bid under. */
  scheme: "exact";
  /** Merchant's own network label, e.g. `"bsc-testnet"`. Advisory; `chainId` is authoritative. */
  network: string;
  chainId: number;
  rail: X402Rail;
  /** The token the payment is denominated in. */
  asset: Address;
  assetDecimals: number;
  /** Amount demanded, in the smallest unit of `asset`. */
  maxAmountRequired: SmallestUnits;
  /** Recipient, bound into the Permit2 witness so a compromised settler cannot redirect it. */
  payTo: Address;
  /**
   * The resource being paid for. Never null and never empty — b402 merchants
   * reject an absent resource, so a request URL is used as the fallback.
   */
  resource: string;
  description: string;
  mimeType: string;
  /** Validity window for the signed authorization. Capped at 480 seconds. */
  maxTimeoutSeconds: number;
  extra: X402Extra | null;
};

/** The body of a `402 Payment Required` response. */
export type X402PaymentRequired = {
  x402Version: number;
  /** Human-readable reason the request was not served, if the merchant gave one. */
  error: string | null;
  accepts: X402Requirement[];
};
