/**
 * Block-explorer URLs for console identifiers.
 *
 * Chain id is authoritative (same rule as the 402 wire). Only BNB Smart
 * Chain is mapped today; anything else returns null so the UI can fall
 * back to a plain truncated hash instead of inventing a host.
 */

const EXPLORERS: Readonly<Record<number, string>> = {
  56: "https://bscscan.com",
  97: "https://testnet.bscscan.com",
};

export type ExplorerKind = "tx" | "address" | "token";

const PATH_FOR: Readonly<Record<ExplorerKind, string>> = {
  tx: "tx",
  address: "address",
  token: "token",
};

export function explorerOrigin(chainId: number): string | null {
  return EXPLORERS[chainId] ?? null;
}

export function explorerUrl(
  chainId: number,
  kind: ExplorerKind,
  value: string,
): string | null {
  const origin = explorerOrigin(chainId);
  const trimmed = value.trim();
  if (origin === null || trimmed.length === 0) return null;
  return `${origin}/${PATH_FOR[kind]}/${trimmed}`;
}

/**
 * Chain the console should use for session-level hashes (grant, revoke,
 * wallet) that do not carry their own `chainId`. Prefers a live payment
 * or stream, then BNB testnet — the product default.
 */
export function consoleChainId(input: {
  payments?: ReadonlyArray<{ chainId: number }>;
  streams?: ReadonlyArray<{ priceSheet: { chainId: number } }>;
}): number {
  const fromPayment = input.payments?.[0]?.chainId;
  if (fromPayment !== undefined) return fromPayment;
  const fromStream = input.streams?.[0]?.priceSheet.chainId;
  if (fromStream !== undefined) return fromStream;
  return 97;
}
