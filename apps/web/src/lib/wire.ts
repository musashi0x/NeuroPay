/**
 * Revive decimal-string amounts that the API encoded from `bigint`.
 * Known amount keys only — a nonce that happens to be numeric stays a string.
 */

const AMOUNT_KEYS = new Set([
  "amount",
  "accruedUnpaid",
  "totalAccrued",
  "perCall",
  "perSecond",
  "perUnit",
  "spent",
  "localLimit",
  "localRemaining",
  "onChainCap",
  "onChainRemaining",
]);

export function reviveWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveWire);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === "spendCap" && child && typeof child === "object") {
        const spend = child as Record<string, unknown>;
        out[key] = {
          ...spend,
          limit:
            typeof spend.limit === "string" && /^-?\d+$/.test(spend.limit)
              ? BigInt(spend.limit)
              : reviveWire(spend.limit),
        };
        continue;
      }
      if (
        AMOUNT_KEYS.has(key) &&
        typeof child === "string" &&
        /^-?\d+$/.test(child)
      ) {
        out[key] = BigInt(child);
        continue;
      }
      out[key] = reviveWire(child);
    }
    return out;
  }
  return value;
}
