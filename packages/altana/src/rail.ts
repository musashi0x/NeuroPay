/**
 * Permit2 rail provisioning.
 *
 * Before the first payment, the system must:
 *
 *  1. Verify that contract code exists at `PERMIT2_ADDRESS` on the
 *     configured chain — a missing Permit2 means every signed envelope is
 *     unspendable, and the spec calls that a startup failure, not a
 *     runtime surprise.
 *  2. Approve the payment token to Permit2 via `approveTokenForPermit2`.
 *  3. Approve Permit2 as the session's signature checker via
 *     `approveSignatureChecker`, using the canonical Permit2 address.
 *
 * Both approvals are admin-signed. The grant's transaction hash for the
 * second step may arrive after the call returns; the rail is considered
 * provisioned only after the second step returns, and `SessionStore.markRailProvisioned`
 * flips the local flag that the payment client asserts against.
 */

import type { Address, Hex } from "@neuro-pay/types";
import {
  approveSignatureChecker,
  approveTokenForPermit2,
  PERMIT2_ADDRESS,
  type Client,
  type Session,
  type Signer,
  type Wallet,
  type ExecuteResult,
} from "@altananetwork/sdk";
import type { PublicClient, Transport } from "viem";
import type { SessionStore } from "./session/store.js";

/** Raised when Permit2 is not deployed at `PERMIT2_ADDRESS` on the chain. */
export class Permit2NotDeployedError extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(
      `Permit2 is not deployed at ${PERMIT2_ADDRESS} on chain ${chainId}. ` +
        `The rail cannot be provisioned; either the address is wrong for ` +
        `this chain or Permit2 is not deployed there. Refusing to sign ` +
        `envelopes nothing can settle.`,
    );
    this.name = "Permit2NotDeployedError";
    this.chainId = chainId;
  }
}

export type ProvisionRailInput = {
  /** Smart-account wallet to provision the rail on. */
  wallet: Wallet;
  /** Admin signer — same key that provisioned the wallet. */
  adminSigner: Signer;
  /** The granted session whose checker we'll approve Permit2 for. */
  session: Session;
  /** The payment token address to approve to Permit2. */
  token: Address;
};

export type ProvisionRailResult = {
  permit2Address: Address;
  /** Transaction that approved the token to Permit2. */
  approveTokenTransactionHash: Hex | null;
  /** Transaction that approved Permit2 as the session's signature checker. */
  approveCheckerTransactionHash: Hex | null;
};

/**
 * Assert contract code exists at `PERMIT2_ADDRESS` on the configured chain.
 *
 * Throws `Permit2NotDeployedError` when `getCode` returns empty bytes —
 * either the chain is not the canonical Permit2 deployment or Permit2
 * was redeployed and our constant is stale.
 */
export async function assertPermit2Deployed(
  publicClient: PublicClient<Transport>,
  chainId: number,
): Promise<void> {
  const code = await publicClient.getCode({ address: PERMIT2_ADDRESS });
  if (code === undefined || code === "0x") {
    throw new Permit2NotDeployedError(chainId);
  }
}

/**
 * Provision the permit2 rail end to end:
 *
 *   1. Verify Permit2 is deployed at `PERMIT2_ADDRESS`.
 *   2. Approve the payment token to Permit2.
 *   3. Approve Permit2 as the session's signature checker.
 *   4. Mark `railProvisioned` in the store.
 *
 * On any failure the function throws and the store's `railProvisioned`
 * flag stays `false`, which means the payment client refuses to sign
 * for this session. The whole point of the two-stage kill switch on
 * revocation is to make sure a *missing* rail looks the same as a
 * deliberately-revoked session to the payment client.
 */
export async function provisionRail(
  client: Client,
  publicClient: PublicClient<Transport>,
  store: SessionStore,
  input: ProvisionRailInput,
): Promise<ProvisionRailResult> {
  const chainId = await publicClient.getChainId();
  await assertPermit2Deployed(publicClient, chainId);

  const approveTokenResult: ExecuteResult = await approveTokenForPermit2(
    input.wallet,
    input.adminSigner,
    input.token,
    { network: client.chains[0]! },
  );

  const approveCheckerResult: ExecuteResult = await approveSignatureChecker(
    input.wallet,
    input.adminSigner,
    { session: input.session, checker: PERMIT2_ADDRESS },
    { network: client.chains[0]! },
  );

  // Only flip the local flag when both approvals succeeded. A "FAILED"
  // status on either is a hard error — paying without the rail means
  // every envelope is unspendable.
  if (approveTokenResult.status === "FAILED") {
    throw new Error(
      `approveTokenForPermit2 returned status "FAILED"; rail provisioning aborted`,
    );
  }
  if (approveCheckerResult.status === "FAILED") {
    throw new Error(
      `approveSignatureChecker returned status "FAILED"; rail provisioning aborted`,
    );
  }

  store.markRailProvisioned(input.wallet.address);

  return {
    permit2Address: PERMIT2_ADDRESS,
    approveTokenTransactionHash: approveTokenResult.transactionHash ?? null,
    approveCheckerTransactionHash: approveCheckerResult.transactionHash ?? null,
  };
}

/**
 * The canonical Permit2 contract address on every supported chain.
 * Re-exported from `@altananetwork/sdk` so the runtime can compose
 * without depending on the SDK directly.
 */
export { PERMIT2_ADDRESS } from "@altananetwork/sdk";
