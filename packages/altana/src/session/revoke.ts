/**
 * Two-stage revocation.
 *
 * Revoking a session is two distinct steps that the spec requires to be
 * reported independently:
 *
 *  1. **Local revocation.** Remove the session from the `SessionStore`
 *     so the payment client cannot sign any further payments. This is
 *     effective in milliseconds and is what the operator script's
 *     "kill switch" actually relies on — the on-chain revoke is
 *     authoritative, but it takes block time.
 *
 *  2. **On-chain revocation.** Submit `revokeSession` against the
 *     KeyStore. The returned `status` is reported verbatim: a
 *     `"FAILED"` is a failure, not a success, and the function must
 *     surface it rather than assume the transaction landed.
 *
 * The two stages are reported as separate fields. A caller that cares
 * only about "did signing stop?" reads `localRevoked`; one that needs
 * "is the session provably dead on-chain" reads `onChainRevoked` and
 * `onChainStatus`. `revoked` (the convenience boolean) is the spec's
 * "the session is provably revoked" claim — it requires both stages to
 * have succeeded.
 *
 * Important: the local stage happens FIRST. If the on-chain call
 * reverts or hangs, the operator still has stopped signing. If the
 * order were reversed, a failed on-chain revoke would leave a session
 * in the local store that can still sign.
 */

import type { Hex } from "@neuro-pay/types";
import {
  type Client,
  type ExecuteResult,
  type Session,
  type Signer,
  type Wallet,
} from "@altananetwork/sdk";
import type { SessionStore } from "./store.js";
import type { PersistedSession } from "./persisted.js";

/**
 * On-chain revocation result, propagated from the SDK verbatim.
 *
 * `"FAILED"` is a real outcome — relayed transactions can be dropped,
 * reverted, or left in a pending state that never confirms. The spec
 * requires that a `FAILED` status be surfaced as a failure rather than
 * assumed successful.
 */
export type OnChainRevokeStatus = ExecuteResult["status"];

/**
 * The full two-stage revocation result.
 *
 * The fields are independently meaningful:
 *
 *  - `localRevoked` — whether the session was removed from the local
 *     store. `true` after the first stage succeeds regardless of
 *     on-chain outcome.
 *  - `onChainRevoked` — whether the on-chain revoke reported a
 *     non-`FAILED` status. `false` on `"FAILED"`, on any thrown
 *     exception, and when the local store had no record to revoke.
 *  - `onChainStatus` — the SDK's `ExecuteResult.status` verbatim, or
 *     `null` when the on-chain call could not be made (no persisted
 *     session).
 *  - `onChainTransactionHash` — the relay-reported transaction hash, or
 *     `null` when the SDK did not return one.
 *  - `revoked` — convenience boolean: `localRevoked && onChainRevoked`.
 *     The spec's "the session is provably revoked" claim.
 */
export type RevokeSessionResult = {
  localRevoked: boolean;
  onChainRevoked: boolean;
  onChainStatus: OnChainRevokeStatus | null;
  onChainTransactionHash: Hex | null;
  revoked: boolean;
};

export type RevokeSessionInput = {
  /** The Altana client, used for the on-chain revoke call. */
  client: Client;
  /** The wallet the session acts on. */
  wallet: Wallet;
  /** The admin signer — same authority that did the grant. */
  adminSigner: Signer;
};

/** The on-chain-only outcome, shared by the first attempt and any retry. */
export type OnChainRevokeOutcome = {
  onChainRevoked: boolean;
  onChainStatus: OnChainRevokeStatus | null;
  onChainTransactionHash: Hex | null;
};

export type RetryOnChainRevokeInput = {
  /** The Altana client, used for the on-chain revoke call. */
  client: Client;
  /** The wallet the session acts on. */
  wallet: Wallet;
  /** The admin signer — same authority that did the grant. */
  adminSigner: Signer;
  /**
   * The persisted session snapshot captured at the time local revocation
   * removed it from the store. The store no longer has this record — a
   * retry cannot re-read it — so the caller (the console composition
   * root) is responsible for holding onto the snapshot from the first
   * `revokeSession` call.
   */
  session: Pick<
    PersistedSession,
    "walletAddress" | "publicKey" | "permissions" | "expiry"
  >;
};

/**
 * Revoke a session.
 *
 * Runs the two stages in order:
 *
 *  1. Read the persisted session from the store (the store is the only
 *     place that knows which wallet maps to which persisted session).
 *  2. Remove the persisted record. `localRevoked` is the result.
 *  3. Submit `client.revokeSession(...)` on-chain. The returned
 *     `status` flows into `onChainStatus`; a `"FAILED"` status surfaces
 *     as `onChainRevoked === false`.
 *
 * Errors at the on-chain stage do NOT undo the local removal — the
 * ordering is intentional. They are caught and translated into
 * `onChainRevoked: false`, `onChainStatus: null`, so the caller can
 * retry the on-chain stage without leaking the local state.
 *
 * Throws when there is no persisted session to revoke — a missing
 * record is a programmer error, not a transient failure.
 */
export async function revokeSession(
  store: SessionStore,
  input: RevokeSessionInput,
): Promise<RevokeSessionResult> {
  const persisted: PersistedSession | undefined = store.read(
    input.wallet.address,
  );
  if (persisted === undefined) {
    throw new Error(
      `revokeSession: no persisted session for wallet ${input.wallet.address}`,
    );
  }

  // Stage 1 — local. The store flips the persisted record immediately;
  // subsequent payment attempts cannot resolve a signer for this wallet.
  const localRevoked = store.remove(input.wallet.address);

  const onChain = await submitOnChainRevoke(
    input.client,
    input.wallet,
    input.adminSigner,
    persisted,
  );

  return {
    localRevoked,
    ...onChain,
    revoked: localRevoked && onChain.onChainRevoked,
  };
}

/**
 * Retry the on-chain stage only.
 *
 * Local revocation is not retried — it is idempotent, already happened,
 * and the store no longer has the record to remove a second time. This
 * resubmits `revokeSession` against the chain using the persisted
 * snapshot the caller captured from the failed attempt, so a dropped or
 * reverted relay submission can be retried without leaking the local
 * store's state.
 */
export async function retryOnChainRevoke(
  input: RetryOnChainRevokeInput,
): Promise<OnChainRevokeOutcome> {
  return submitOnChainRevoke(
    input.client,
    input.wallet,
    input.adminSigner,
    input.session,
  );
}

async function submitOnChainRevoke(
  client: Client,
  wallet: Wallet,
  adminSigner: Signer,
  session: Pick<
    PersistedSession,
    "walletAddress" | "publicKey" | "permissions" | "expiry"
  >,
): Promise<OnChainRevokeOutcome> {
  // The SDK accepts a Session or a publicKey. We rebuild a minimal
  // Session from the persisted record because the signer half is
  // intentionally absent from the persisted shape — local revocation
  // already stopped signing, so on-chain revocation only needs the
  // public key.
  const sessionForSdk: Session = {
    walletAddress: session.walletAddress,
    // The signer is not required by the on-chain revoke (the admin
    // signer carries the authority), but the SDK's `Session` type
    // expects one. We pass the admin signer — revocation is an
    // admin-signed action and the SDK uses it.
    signer: adminSigner,
    publicKey: session.publicKey,
    permissions: session.permissions,
    expiry: session.expiry,
  };

  try {
    const result: ExecuteResult = await client.revokeSession({
      wallet,
      signer: adminSigner,
      session: sessionForSdk,
    });
    // The spec is explicit: a "FAILED" status is a failure, not a
    // success. Anything else (PENDING, CONFIRMED) is treated as
    // on-chain revoked being true. PENDING is reported honestly — the
    // caller can poll the chain or the relay to confirm.
    return {
      onChainStatus: result.status,
      onChainTransactionHash: result.transactionHash ?? null,
      onChainRevoked: result.status !== "FAILED",
    };
  } catch {
    // A thrown on-chain call is the same outcome as a "FAILED" status
    // for our purposes: the local stage is intact, the on-chain stage
    // did not complete, and the caller can retry.
    return {
      onChainRevoked: false,
      onChainStatus: null,
      onChainTransactionHash: null,
    };
  }
}
