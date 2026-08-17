/**
 * The persisted record of a granted session.
 *
 * This is the *only* shape we write to disk. It is intentionally narrower
 * than the SDK's `Session`:
 *
 *  - The signer (and the private key it carries) is never persisted. The
 *    signer lives only in the running process, generated at grant time and
 *    held in memory; the operator script writes the public-key half here
 *    so a follow-up process can identify and revoke the session, and so
 *    the on-chain authority check has something to point at.
 *  - `walletAddress` is the smart-account address — what an operator
 *    funds and what an on-chain read keys off of.
 *  - `publicKey` is the session key's SEC1-encoded public half. The Keystore
 *    `isValidKey(wallet, keyHash)` read takes the `keyHash = keccak256(pubkey)`,
 *    which is also derivable here, but storing the pubkey keeps the audit
 *    trail self-contained.
 *  - `permissions` carries the on-chain `calls` allowlist and `spend`
 *    caps, exactly as granted. Re-encoded under the byte-exact codec so a
 *    load-time re-encode-and-compare catches any drift.
 *  - `expiry` is the on-chain Unix epoch seconds.
 *  - `grantTransactionHash` is the relay-reported hash from the grant
 *    transaction. Note this transaction is charged twice on a wallet's
 *    first admin action.
 *  - `railProvisioned` is the local flag that gates the payment client's
 *    "rail not provisioned" refusal; set true after a successful
 *    `provisionRail()` run.
 *
 * `signer` (with the private key) is deliberately absent — no field on this
 * type, no method that returns one. The shape is the contract.
 */

import type { Address, Hex } from "@neuro-pay/types";

/** A single allowed call on the session. Mirrors the SDK's wire shape. */
export type PersistedCallPermission = {
  signature: string;
  to?: Address;
};

/** A single token spend cap on the session, in smallest units per period. */
export type PersistedSpendPermission = {
  limit: bigint;
  period: "minute" | "hour" | "day" | "week" | "month" | "year";
  /** Omit for native. Always set explicitly here — required by the spec. */
  token?: Address;
};

export type PersistedSessionPermissions = {
  /**
   * Allowed calls. The spec REQUIRES this be non-empty at grant time — an
   * omitted allowlist means *unrestricted within the spend cap*, which is a
   * policy hole that reads like a default.
   */
  calls: readonly PersistedCallPermission[];
  /** Per-token spending caps. */
  spend: readonly PersistedSpendPermission[];
};

/** The persisted half of a session — no key material anywhere in here. */
export type PersistedSession = {
  /** Smart-account wallet this session acts on. The address to fund. */
  walletAddress: Address;
  /** Session key's SEC1-encoded public half (secp256k1 or P256). */
  publicKey: Hex;
  permissions: PersistedSessionPermissions;
  /** Unix epoch seconds when this session expires. */
  expiry: number;
  /** Transaction that granted the session; null only before grant confirms. */
  grantTransactionHash: Hex | null;
  /** True once the permit2 rail has been provisioned against this wallet. */
  railProvisioned: boolean;
  /**
   * Unix epoch seconds the session was created. Diagnostic; not enforced
   * on-chain. Excluded from byte-exact verification because it's metadata,
   * not part of the on-chain commitment.
   */
  createdAt: number;
};
