/**
 * On-chain authority verification.
 *
 * A session is "authorized" on-chain when the wallet's KeyStore entry for
 * the session's keyId is registered, unexpired, and unrevoked. The spec
 * asks for an `isValidKey`-style read: a one-call, free Keystore check
 * that the payment client can run before signing.
 *
 * The local half matters too: a session whose `expiry` has passed is no
 * longer authorized regardless of what the chain says, because the
 * smart-account validates against the committed expiry. We combine the
 * two:
 *
 *   - `onChainValid === true`  AND  `now < expiry`  -> "active"
 *   - `now >= expiry`                            -> "expired"
 *   - `onChainValid === false`                   -> "revoked"
 *
 * `expired` wins over `revoked` because an expired session key might
 * never have been revoked on chain — the on-chain record is still
 * "valid" but the session is dead. Conversely, a session that was
 * revoked before its expiry reports "revoked", because the on-chain
 * record is the authoritative revocation source.
 *
 * The function performs a single Keystore read. It does not pay gas and
 * is safe to call before every signing attempt.
 *
 * The SDK exposes `readIsValidKey` from its internal keystore module but
 * does not re-export it through the package boundary. We inline the
 * `isValidKey(user, keyId)` view call here so this package does not
 * reach across the SDK's `exports` map. The wire shape is identical to
 * the SDK's helper and a future SDK rev that promotes the export is a
 * drop-in replacement.
 */

import type { Address, Hex } from "@neuro-pay/types";
import type { NetworkConfig } from "@altananetwork/sdk";
import { keccak256, type PublicClient, type Transport } from "viem";
import type { PersistedSession } from "./persisted.js";

/**
 * The tri-state authority result.
 *
 * `"active"` — granted, unexpired, unrevoked. The payment client may sign.
 * `"expired"` — `now >= expiry`. The on-chain entry may still read valid,
 *                but the session is dead. Never sign.
 * `"revoked"` — the Keystore reads unregistered or explicitly revoked.
 *                Never sign.
 */
export type AuthorityStatus = "active" | "expired" | "revoked";

export type AuthorityResult = {
  status: AuthorityStatus;
  /** The on-chain Keystore read; `true` for active + expired, `false` for revoked. */
  onChainValid: boolean;
  /** The session's `expiry` from the persisted record. Echoed for diagnostics. */
  expiry: number;
  /** Unix epoch seconds the read was taken at. `undefined` when injected via `now`. */
  checkedAt: number;
};

export type AuthorityCheckInput = {
  /** The persisted session record (carries the wallet address and expiry). */
  session: PersistedSession;
  /** The on-chain network config (chain id, keyStore address). */
  network: NetworkConfig;
  /** viem public client used to call the Keystore contract. */
  publicClient: PublicClient<Transport>;
  /**
   * Override the clock. Injected so tests can pin the comparison to
   * `session.expiry` boundary cases without depending on `Date.now()`.
   * Defaults to `Math.floor(Date.now() / 1000)`.
   */
  now?: number;
};

/**
 * Minimal ABI for the KeyStore view we need.
 *
 * Mirrors the SDK's `KEYSTORE_ABI` entry for `isValidKey`. We do not
 * import the internal SDK ABI because the SDK's `package.json` only
 * exposes `"."`; reaching into `internal/keystore.js` would break under
 * any future `exports` tightening.
 */
const KEYSTORE_IS_VALID_KEY_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * Derive the KeyStore v0 keyId from a SEC1-encoded public key.
 *
 * `keyId = keccak256(publicKey)`. The spec calls this out as the v0
 * convention; any change is a coordinated SDK + KeyStore upgrade.
 */
export function deriveKeyId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

/**
 * Read the current on-chain authority for a session.
 *
 * Combines the Keystore `isValidKey` read with the local `expiry` to
 * return a tri-state. The on-chain read alone is not enough — an
 * expired session still reads valid on chain, and the payment client
 * needs to know.
 *
 * Throws whatever the underlying `readContract` throws on RPC failure;
 * callers are expected to surface transport errors distinctly from the
 * `"revoked"` outcome, since a transient network error is not a
 * revocation.
 */
export async function checkSessionAuthority(
  input: AuthorityCheckInput,
): Promise<AuthorityResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const isExpired = now >= input.session.expiry;
  const onChainValid = await input.publicClient.readContract({
    address: input.network.keyStore as Address,
    abi: KEYSTORE_IS_VALID_KEY_ABI,
    functionName: "isValidKey",
    args: [
      input.session.walletAddress as Address,
      deriveKeyId(input.session.publicKey),
    ],
  });
  // Expired wins over revoked: a session that's expired but never
  // revoked still produces a usable on-chain "valid" read, and the
  // payment client must reject it on the expiry check, not the
  // keystore check.
  const status: AuthorityStatus = isExpired
    ? "expired"
    : onChainValid
      ? "active"
      : "revoked";
  return {
    status,
    onChainValid,
    expiry: input.session.expiry,
    checkedAt: now,
  };
}
