/**
 * Unsettled exposure.
 *
 * "Exposure" is delivered work whose settlement has not yet confirmed.
 * It is the seller's bad-debt risk surface: the buyer received value,
 * and as long as the settlement has not landed the value is technically
 * recoverable only by faith in the chain.
 *
 * Three rules govern the number:
 *
 * 1. Every `segment.delivered` (matching a verified nonce) *rises*
 *    exposure by the demanded amount.
 * 2. Every `settlement.confirmed` *falls* exposure by the same amount.
 * 3. Every `settlement.failed` is *not* a fall — it leaves the amount
 *    counted as "unrecovered" so the operator can chase it.
 *
 * Corrections overlay the source entries before the rise/fall sum is
 * taken: a `settlement.confirmed` that was originally recorded as
 * `settlement.failed` and then corrected still lowers exposure.
 */

import type {
  Address,
  LedgerEntry,
  SmallestUnits,
} from "@neuro-pay/types";

import type { LedgerStore } from "./store.js";

/**
 * Per-token breakdown of unsettled exposure. One `UnsettledExposure`
 * returns an entry per stream that has live exposure, with the same
 * figures summed across streams.
 */
export type UnsettledExposure = {
  streamId: string | null;
  token: Address;
  /**
   * Sum of in-flight (delivered, not yet confirmed, not failed) amounts
   * for this stream/token. Reported as the headline number.
   */
  inFlight: SmallestUnits;
  /**
   * Sum of failed-settlement amounts: the seller delivered something,
   * the settlement did not move funds, and the operator has not yet
   * recovered them. Tracked separately so the console can show it
   * as a distinct alarm.
   */
  unrecovered: SmallestUnits;
};

/**
 * Compute unsettled exposure across every active stream.
 *
 * The result is one row per `(streamId, token)` pair that has live or
 * unrecovered amounts. A stream with neither is omitted — empty rows
 * do not appear in the response.
 */
export async function computeUnsettledExposure(
  store: LedgerStore,
): Promise<UnsettledExposure[]> {
  const resolved = applyCorrections(await store.entries());

  /**
   * Map from `<streamId>|<token>` to per-bucket figures. We key by
   * string so `null` stream ids bucket together; that's deliberate —
   * `null` is reserved for entries that aren't stream-scoped (e.g.
   * session lifecycle), which should not contribute to exposure.
   */
  type Bucket = {
    inFlight: bigint;
    unrecovered: bigint;
    streamId: string | null;
    token: Address;
  };
  const buckets = new Map<string, Bucket>();

  for (const entry of resolved) {
    if (entry.streamId === null) continue;
    if (entry.amount === null) continue;
    const key = `${entry.streamId}|${entry.token}`;
    const bucket = buckets.get(key) ?? {
      inFlight: 0n,
      unrecovered: 0n,
      streamId: entry.streamId,
      token: entry.token,
    };
    switch (entry.event) {
      case "segment.delivered":
        bucket.inFlight += entry.amount;
        break;
      case "settlement.confirmed":
        // Settlements without a matching delivered segment are unusual
        // (the policy says `segment.delivered` precedes confirmation);
        // we still drop the number to honour the spec's "falls by the
        // same amount" rule.
        bucket.inFlight =
          bucket.inFlight >= entry.amount
            ? bucket.inFlight - entry.amount
            : 0n;
        break;
      case "settlement.failed":
        // Failed settlements do *not* lower in-flight. They keep the
        // amount in exposure and *also* mark it as unrecovered, so a
        // stream that has one failed settlement shows up in both
        // numbers: this is the alarm state the console surfaces.
        bucket.unrecovered += entry.amount;
        break;
      default:
        break;
    }
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values()).filter(
    (bucket) => bucket.inFlight > 0n || bucket.unrecovered > 0n,
  );
}

/**
 * Sum the in-flight figures across every stream in the store, for one
 * token. Useful as a single number the seller can read against its
 * `maxInFlightSettlements × settlementThreshold` ceiling.
 */
export async function totalInFlightExposure(
  store: LedgerStore,
  token: Address,
): Promise<SmallestUnits> {
  const all = await computeUnsettledExposure(store);
  let total = 0n;
  for (const row of all) {
    if (row.token === token) total += row.inFlight;
  }
  return total;
}

/**
 * Sum the unrecovered figures across every stream in the store, for one
 * token. Unrecovered amounts stay in the operator's queue until the
 * settlement is retried (and confirmed) or explicitly written off.
 */
export async function totalUnrecoveredExposure(
  store: LedgerStore,
  token: Address,
): Promise<SmallestUnits> {
  const all = await computeUnsettledExposure(store);
  let total = 0n;
  for (const row of all) {
    if (row.token === token) total += row.unrecovered;
  }
  return total;
}

/**
 * Apply corrections and emit a single resolved entry per logical id.
 * Duplicates `window.ts`'s pass because both files need it and the
 * resolution is small enough that a private copy is cheaper than
 * importing across modules.
 */
function applyCorrections(entries: LedgerEntry[]): LedgerEntry[] {
  const byLogicalId = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const logicalId = entry.correctsEntryId ?? entry.id;
    const family = byLogicalId.get(logicalId) ?? [];
    family.push(entry);
    byLogicalId.set(logicalId, family);
  }
  const resolved: LedgerEntry[] = [];
  for (const family of byLogicalId.values()) {
    family.sort((a, b) => a.sequence - b.sequence);
    resolved.push(family[family.length - 1] as LedgerEntry);
  }
  resolved.sort((a, b) => a.sequence - b.sequence);
  return resolved;
}
