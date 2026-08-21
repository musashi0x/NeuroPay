import type {
  Address,
  Hex,
  IsoTimestamp,
  SmallestUnits,
} from "./primitives.js";

/**
 * On-chain authority state for a session key.
 *
 * `revoked` and `expired` are distinct: revocation is a deliberate human act
 * recorded on chain, expiry is the clock running out. Reporting one as the
 * other misrepresents what actually happened.
 */
export type SessionStatus =
  "active" | "expired" | "revoked" | "unprovisioned" | "unknown";

/**
 * One entry of the session's `calls` allowlist.
 *
 * Always set explicitly. An omitted allowlist means *unrestricted within the
 * spend cap*, which is a policy hole that reads like a default.
 */
export type SessionCallPermission = {
  /** Contract the session key may call. */
  to: Address;
  /** 4-byte selector, or null when every selector on `to` is allowed. */
  selector: Hex | null;
};

/**
 * The session policy as shown to a human, derived from what was committed on
 * chain at grant time.
 *
 * Contains no key material: `publicKey` identifies the session, the private
 * half never leaves the server.
 */
export type SessionPolicyView = {
  /** Smart-account wallet the session spends from. This is the address to fund. */
  walletAddress: Address;
  publicKey: Hex;
  status: SessionStatus;
  /** Contracts the session key may call, exactly as granted. */
  allowedCalls: SessionCallPermission[];
  spendCap: {
    token: Address;
    tokenDecimals: number;
    /** ERC-20 symbol of `token`, from config, for display. */
    tokenSymbol: string;
    /** On-chain cap per `periodSeconds`, in smallest units. */
    limit: SmallestUnits;
    periodSeconds: number;
  };
  expiresAt: IsoTimestamp;
  /** Seconds until `expiresAt`, clamped at 0. Recomputed per read, not stored. */
  remainingLifetimeSeconds: number;
  /**
   * Transaction that granted the session. Null before the grant confirms.
   * Note this transaction is charged twice on a wallet's first admin action.
   */
  grantTransactionHash: Hex | null;
  /** True once the token is approved to Permit2 and Permit2 is an approved signature checker. */
  railProvisioned: boolean;
};

/**
 * Two-stage revocation outcome. Local and on-chain are never collapsed
 * into a single boolean — the kill switch reports them separately.
 */
export type RevokeResult = {
  local: {
    revoked: boolean;
  };
  onChain: {
    revoked: boolean;
    /** SDK execute status, or null when the on-chain call did not run. */
    status: string | null;
    transactionHash: Hex | null;
  };
};
