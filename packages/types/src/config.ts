import type { Address, Hex, SmallestUnits } from "./primitives.js";

/**
 * Configuration shapes shared across the workspace.
 *
 * These are declarations only. The module that *reads* them from the
 * environment and fails startup on missing required values lives in
 * `@neuro-pay/altana`, which is the only package allowed to touch chain
 * libraries. They live here rather than there so `@neuro-pay/metering` can
 * type its policy inputs without taking a dependency that would drag `viem`
 * and `@altananetwork/sdk` into a package that must stay chain-free.
 */

/** Chain, token, and recipient. Every amount elsewhere is in `tokenDecimals`. */
export type ChainConfig = {
  /** Defaults to 97 (BNB Smart Chain testnet). */
  chainId: number;
  rpcUrl: string;
  token: Address;
  /**
   * Decimals of `token`, from config and never a literal. Asserted against the
   * token contract's `decimals()` at startup: a cap written for 6 decimals is
   * ~10^12 too small on an 18-decimal chain, and every payment reverts against
   * a limit that reads as generous.
   */
  tokenDecimals: number;
  /** Recipient of settled payments; bound into every Permit2 witness. */
  payTo: Address;
};

/**
 * Server-side key material. Never logged, never serialized to the ledger,
 * never sent to a browser.
 */
export type SecretsConfig = {
  /** EOA that submits `permitWitnessTransferFrom`. Needs gas. */
  settlerPrivateKey: Hex;
  /**
   * Wallet admin key. Required only for wallet creation, `grantSession`, rail
   * provisioning, and `revokeSession` — null in a running agent process, which
   * is the point: a leaked session key is bounded, a leaked admin key is not.
   */
  adminPrivateKey: Hex | null;
};

/** Bounds a human approves once, committed on chain at grant time. */
export type SessionConfig = {
  /** Session lifetime in seconds, used to derive the absolute `expiry`. */
  lifetimeSeconds: number;
  /**
   * Per-period spend cap as a whole-token count. The grant path multiplies
   * by `10n ** tokenDecimals` to derive the on-chain smallest-unit limit;
   * the multiplication lives in `@neuro-pay/altana`'s `deriveSpendLimit` and
   * is exercised by the codec / spend-decimal tests.
   *
   * Storing whole tokens (not smallest units) here is the spec's
   * "policy of 50 USDC per day is configured on a chain where the token
   * has 18 decimals" — `50n * 10n ** 18n` is computed from this value and
   * `tokenDecimals`, never a literal in the grant code.
   */
  spendCap: bigint;
  /** The `period` the on-chain cap resets over; the budget window aligns to it. */
  spendPeriodSeconds: number;
};

/**
 * The settlement policy. Chain-free by construction: every field here is a
 * plain number or a `bigint`, so `@neuro-pay/metering` can consume it without
 * importing anything that talks to a network.
 */
export type MeteringConfig = {
  /**
   * Fraction of the on-chain cap held back as local headroom, in `[0, 1)`.
   * A margin of 0.2 puts the local budget at 80% of the cap so exhaustion is a
   * refusal to sign rather than a revert after delivery.
   */
  budgetMargin: number;
  /** Accrued amount that triggers a payment demand, in smallest units. */
  settlementThreshold: SmallestUnits;
  /** Seconds since the last payment that trigger a demand regardless of accrual. */
  tickIntervalSeconds: number;
  /**
   * Concurrent settlements the seller will carry. Delivery stops at
   * `settlementThreshold × maxInFlightSettlements`, which is the seller's
   * maximum unrecoverable exposure.
   */
  maxInFlightSettlements: number;
};

/** Everything `apps/api` needs to compose the buyer and the seller. */
export type AppConfig = {
  chain: ChainConfig;
  secrets: SecretsConfig;
  session: SessionConfig;
  metering: MeteringConfig;
};
