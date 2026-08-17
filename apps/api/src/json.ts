/**
 * JSON codec for wire types that carry `bigint` amounts.
 *
 * `JSON.stringify` throws on bigint. Every console and seller response
 * that includes a smallest-unit amount goes through `toJsonSafe` so the
 * number travels as a decimal string and comes back as the same `bigint`.
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

export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = toJsonSafe(child);
    }
    return out;
  }
  return value;
}

export function reviveBigints(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reviveBigints);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (
        AMOUNT_KEYS.has(key) &&
        typeof child === "string" &&
        /^-?\d+$/.test(child)
      ) {
        out[key] = BigInt(child);
        continue;
      }
      if (
        key === "spendCap" &&
        child !== null &&
        typeof child === "object" &&
        "limit" in (child as object)
      ) {
        const spend = child as Record<string, unknown>;
        out[key] = {
          ...spend,
          limit:
            typeof spend.limit === "string" && /^-?\d+$/.test(spend.limit)
              ? BigInt(spend.limit)
              : reviveBigints(spend.limit),
        };
        continue;
      }
      out[key] = reviveBigints(child);
    }
    return out;
  }
  return value;
}
