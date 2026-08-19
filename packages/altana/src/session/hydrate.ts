/**
 * Reconstruct a live SDK `Session` from the persisted public half plus
 * an in-memory signer.
 *
 * `PersistedSession` never carries key material. A buyer process that
 * loads the store from disk must reattach a signer (typically
 * `signerFromPrivateKey(SESSION_PRIVATE_KEY)`) before `fetchWithX402`
 * can sign. This is that reattachment.
 */

import type { Session, Signer } from "@altananetwork/sdk";
import type { PersistedSession } from "./persisted.js";

/**
 * Build the live SDK session the payment client needs.
 *
 * Permissions are projected onto the SDK's tagged-union call/spend
 * shapes so `to: undefined` does not leak onto a `{ signature }` rule.
 */
export function sessionFromPersisted(
  persisted: PersistedSession,
  signer: Signer,
): Session {
  return {
    walletAddress: persisted.walletAddress,
    signer,
    publicKey: persisted.publicKey,
    permissions: {
      calls: persisted.permissions.calls.map((c) =>
        c.to !== undefined
          ? { signature: c.signature, to: c.to }
          : { signature: c.signature },
      ),
      spend: persisted.permissions.spend.map((s) =>
        s.token !== undefined
          ? { limit: s.limit, period: s.period, token: s.token }
          : { limit: s.limit, period: s.period },
      ),
    },
    expiry: persisted.expiry,
  };
}
