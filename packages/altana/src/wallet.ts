/**
 * Wallet provisioning.
 *
 * Creates an Altana smart-account wallet from the admin signer loaded from
 * configuration and returns its address. The caller is responsible for
 * funding the wallet before any on-chain action.
 *
 * The signer returned alongside the address is the admin authority. It is
 * held by the caller and passed into `grantSession` / `revokeSession`
 * later; it is never persisted, logged, or sent over the wire.
 */

import type { Address, Hex } from "@neuro-pay/types";
import {
  signerFromPrivateKey,
  type Client,
  type CreateWalletResult,
  type Signer,
} from "@altananetwork/sdk";

export type WalletProvisionResult = {
  walletAddress: Address;
  /**
   * The admin signer. The caller stores it in memory only and passes it
   * into `grantSession` / `revokeSession`. The store never sees it.
   */
  adminSigner: Signer;
};

/**
 * Provision a wallet for the admin private key.
 *
 * Throws if `adminPrivateKey` is not a 32-byte hex value — `signerFromPrivateKey`
 * validates the shape, and `loadAppConfig` already rejected bad keys at
 * startup, so a runtime failure here means the caller skipped config.
 */
export async function provisionWallet(
  client: Client,
  adminPrivateKey: Hex,
): Promise<WalletProvisionResult> {
  const adminSigner = signerFromPrivateKey(adminPrivateKey);
  const created: CreateWalletResult = await client.createWallet({
    signer: adminSigner,
  });
  return {
    walletAddress: created.address,
    adminSigner: created.signer,
  };
}
