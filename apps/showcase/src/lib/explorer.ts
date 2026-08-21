/**
 * Block-explorer URLs for showcase identifiers.
 *
 * The same map `apps/web/src/lib/explorer.ts` uses — duplicated here
 * because the apps do not share a lib package. Chain id is
 * authoritative; anything unmapped returns null so the UI falls back
 * to a plain truncated hash instead of inventing a host.
 */

const EXPLORERS: Readonly<Record<number, string>> = {
  56: "https://bscscan.com",
  97: "https://testnet.bscscan.com",
};

export type ExplorerKind = "tx" | "address";

const PATH_FOR: Readonly<Record<ExplorerKind, string>> = {
  tx: "tx",
  address: "address",
};

export function explorerUrl(
  chainId: number,
  kind: ExplorerKind,
  value: string,
): string | null {
  const origin = EXPLORERS[chainId];
  const trimmed = value.trim();
  if (origin === undefined || trimmed.length === 0) return null;
  return `${origin}/${PATH_FOR[kind]}/${trimmed}`;
}
