/**
 * Read the persisted session for the server-rendered chrome.
 *
 * Used by the page's server component to render the session wallet,
 * expiry, and grant hash — the public half. The BFF's own loop reads
 * the store again with a signer; the two reads are independent
 * because the store caches in memory after the first disk load.
 *
 * Returns `null` when the store is empty, missing, or unprovisioned,
 * so the page can render the empty-state copy without a try/catch.
 */
import { existsSync } from "node:fs";
import { SessionStore } from "@neuro-pay/altana";
import type { Address, Hex } from "@neuro-pay/types";

export type PersistedSessionInfo = {
  walletAddress: Address;
  expiry: number;
  grantTransactionHash: Hex | null;
  chainId: number | null;
};

export function readPersistedSession(
  storePath: string,
): PersistedSessionInfo | null {
  if (!existsSync(storePath)) return null;
  const store = new SessionStore({ fileStorePath: storePath });
  const wallets = store.list();
  if (wallets.length === 0) return null;
  const wallet = wallets[0];
  if (wallet === undefined) return null;
  const persisted = store.read(wallet);
  if (persisted === undefined) return null;
  return {
    walletAddress: persisted.walletAddress,
    expiry: persisted.expiry,
    grantTransactionHash: persisted.grantTransactionHash,
    chainId: null,
  };
}

/**
 * Whether the showcase has its signing key in server env.
 *
 * The runtime check is purely string-shape: the value is a 0x-prefixed
 * 32-byte hex. The actual signer is built on the BFF side; the page
 * only needs to know whether the BFF can start a run.
 */
export function hasSigningKey(): boolean {
  const raw = process.env.SESSION_PRIVATE_KEY?.trim();
  if (raw === undefined || raw === "") return false;
  return /^0x[0-9a-fA-F]{64}$/.test(raw);
}
