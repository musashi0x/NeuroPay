/**
 * `grantSession` with an explicit `calls` allowlist and a `spend` entry
 * expressed in the configured token's smallest units.
 *
 * Spend derivation:
 *
 *   limit = wholeTokens * 10^tokenDecimals
 *
 * `wholeTokens` is what the operator wrote into `SESSION_SPEND_CAP`
 * (e.g. "50" for 50 USDC per day). `tokenDecimals` is the chain-specific
 * integer (18 on BNB, 6 on Ethereum USDC). The on-chain limit MUST be in
 * smallest units — passing `50n` on an 18-decimal chain is 10^18 short of
 * the intended cap and every payment reverts against a limit that reads
 * as generous.
 *
 * The `calls` allowlist is REQUIRED — never omitted. The spec calls an
 * omitted allowlist a policy hole that reads like a default.
 *
 * Expiry is bounded: `now + lifetimeSeconds`, in Unix epoch seconds.
 */

import type { Address } from "@neuro-pay/types";
import type {
  Client,
  Signer,
  Wallet,
  Session,
  GrantSessionResult,
  CallPermission as SdkCallPermission,
  SpendPermission as SdkSpendPermission,
  SessionPermissions as SdkSessionPermissions,
} from "@altananetwork/sdk";
import { deriveSpendLimit } from "../spend.js";
import type { SessionConfig } from "@neuro-pay/types";
import type {
  PersistedCallPermission,
  PersistedSession,
  PersistedSessionPermissions,
  PersistedSpendPermission,
} from "./persisted.js";
import type { SessionStore } from "./store.js";

/** Raised when the caller's `calls` allowlist is empty (a spec violation). */
export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantError";
  }
}

export type GrantSessionInput = {
  /**
   * The smart-account wallet to grant the session on. Created by
   * `provisionWallet` and funded before this call.
   */
  wallet: Wallet;
  /** The admin signer — same key that provisioned the wallet. */
  adminSigner: Signer;
  /** Session policy (lifetime, spend cap, period). */
  config: SessionConfig;
  /** Token address the spend cap applies to. */
  token: Address;
  /** Token decimals — used to derive the on-chain smallest-unit limit. */
  tokenDecimals: number;
  /**
   * Explicit calls allowlist. Required and non-empty; an omitted
   * allowlist means *unrestricted within the spend cap*, which the spec
   * calls a policy hole that reads like a default.
   */
  calls: readonly PersistedCallPermission[];
  /**
   * Unix epoch seconds the grant is submitted. Injected so tests can
   * pin expiry; defaults to `Math.floor(Date.now() / 1000)`.
   */
  now?: number;
  /**
   * Operator-supplied session signer. When set, the grant registers this
   * key on chain so a later buyer process can reconstruct the live
   * `Session` from `SESSION_PRIVATE_KEY`. When omitted the SDK generates
   * an ephemeral key that dies with this process.
   */
  sessionSigner?: Signer;
};

export type GrantedSession = {
  /** The live SDK session — carries the signer in memory only. */
  session: Session;
  /**
   * The persisted half — wallet address, public key, permissions,
   * expiry, and the grant transaction hash when the relay reported one.
   */
  persisted: PersistedSession;
};

/**
 * Compute the smallest-units spend limit from the configured whole-token
 * cap and the chain's token decimals.
 *
 * Re-exported from `./spend.js` so the test file can import the helper
 * directly without going through the grant path.
 */
export { deriveSpendLimit };

/**
 * Grant a session with an explicit `calls` allowlist and a `spend` entry
 * in smallest units, then persist the public half.
 *
 * The function:
 *
 *  1. Builds the on-chain permissions from the persisted shapes (sorting
 *     keys so the resulting wire matches what the SDK encodes).
 *  2. Computes `expiry = now + lifetimeSeconds`.
 *  3. Calls `client.grantSession(...)`.
 *  4. Persists the public half to the store, including the relay-reported
 *     `transactionHash` (which may arrive later via
 *     `SessionStore.setGrantTransactionHash`).
 *
 * The signer the SDK generates is returned alongside the persisted record
 * — the caller must hold it (in memory) so the agent process can sign
 * payments before this call returns. The signer is never persisted.
 */
export async function grantSession(
  client: Client,
  store: SessionStore,
  input: GrantSessionInput,
): Promise<GrantedSession> {
  if (input.calls.length === 0) {
    throw new GrantError(
      "grantSession requires a non-empty `calls` allowlist. " +
        "An omitted allowlist means unrestricted within the spend cap — " +
        "the spec calls this a policy hole that reads like a default.",
    );
  }

  const sdkCalls: SdkCallPermission[] = input.calls.map((c) => {
    // The SDK's `CallPermission` is a tagged union: { signature, to } both,
    // { signature } alone, or { to } alone. Persisted shapes carry a
    // string signature and an optional `to`; we project that onto the
    // appropriate SDK variant.
    if (c.to !== undefined) {
      return { signature: c.signature, to: c.to } satisfies SdkCallPermission;
    }
    return { signature: c.signature } satisfies SdkCallPermission;
  });

  // `config.spendCap` is already in smallest units — the config layer
  // converted from whole tokens using the same `tokenDecimals` we were
  // handed here. Don't re-multiply.
  const limit = input.config.spendCap;
  const sdkSpend: SdkSpendPermission[] = [
    {
      limit,
      // Altana SDK uses string-literal period names. Our config gives
      // seconds; the SDK's vocabulary maps directly: day = 86_400, etc.
      period: "day",
      token: input.token,
    },
  ];

  const sdkPermissions: SdkSessionPermissions = {
    calls: sdkCalls,
    spend: sdkSpend,
  };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expiry = now + input.config.lifetimeSeconds;

  const result: GrantSessionResult = await client.grantSession({
    wallet: input.wallet,
    signer: input.adminSigner,
    permissions: sdkPermissions,
    expiry,
    ...(input.sessionSigner !== undefined
      ? { sessionSigner: input.sessionSigner }
      : {}),
  });

  // Project the SDK `Session` to our narrower `PersistedSession`. The
  // signer (with private key) is intentionally dropped — it stays in the
  // running process only. The grant transaction hash may be `undefined`
  // when the relay confirms without surfacing a receipt; we treat that
  // as `null` here and let a later setter fill it in.
  const persistedPermissions: PersistedSessionPermissions = {
    calls: input.calls,
    spend: [
      {
        limit,
        period: "day",
        token: input.token,
      } satisfies PersistedSpendPermission,
    ],
  };

  const persisted: PersistedSession = {
    walletAddress: result.walletAddress,
    publicKey: result.publicKey,
    permissions: persistedPermissions,
    expiry: result.expiry,
    grantTransactionHash: result.transactionHash ?? null,
    railProvisioned: false,
    createdAt: now,
  };

  store.save(persisted);

  return { session: result, persisted };
}
