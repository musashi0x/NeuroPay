/**
 * Behavioural coverage for the append-only ledger surface.
 *
 * Complements `secret-leak.test.ts` (which exercises the write-path
 * security guard) by driving the rest of the public API:
 *
 * - **6.x large-amount fidelity** — amounts above `2n ** 53n` survive a
 *   round trip without precision loss.
 * - **6.x window roll** — payments aged past `periodMs` no longer count
 *   toward the current window spend.
 * - **6.x nonce reconciliation** — `lookupByNonce` returns the full
 *   lifecycle (demanded → signed → verified → delivered →
 *   settlement.submitted → settlement.confirmed) in append order.
 * - **6.x correction-by-append** — appending a correction referencing an
 *   earlier entry leaves the original untouched and surfaces the
 *   correction in `computeWindowSpend` / `computeUnsettledExposure`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeUnsettledExposure,
  computeWindowSpend,
  fraction,
  lookupByNonce,
  recordCorrection,
  recordPaymentDemanded,
  recordPaymentSigned,
  recordPaymentVerified,
  recordSegmentDelivered,
  recordSettlementConfirmed,
  recordSettlementFailed,
  recordSettlementSubmitted,
  recordStreamOpened,
} from "../src/index.js";
import type { EventContext } from "../src/index.js";
import type { LedgerStore } from "../src/store.js";
import {
  SAMPLE_CHAIN_ID,
  SAMPLE_SESSION_PUBKEY,
  SAMPLE_TOKEN,
  SAMPLE_TOKEN_DECIMALS,
  SAMPLE_TX_HASH,
  newLedger,
  resetIdCounter,
} from "./_fixtures.js";

/**
 * Two values well above `2n ** 53n` (the JS-number precision ceiling).
 * We pick `2n ** 64n` because the spec calls out that a 50-ether-style
 * smallest-unit figure must survive a round trip, and `50n * 10n ** 18n`
 * fits comfortably under 2^53; pushing to 2^64 makes any silent narrowing
 * to a double impossible.
 */
const LARGE_A = 2n ** 64n;
const LARGE_B = 2n ** 64n - 7n;

const ctx = (
  streamId: string,
  sessionPublicKey: typeof SAMPLE_SESSION_PUBKEY = SAMPLE_SESSION_PUBKEY,
): EventContext => ({
  streamId,
  sessionPublicKey,
  chainId: SAMPLE_CHAIN_ID,
  token: SAMPLE_TOKEN,
  tokenDecimals: SAMPLE_TOKEN_DECIMALS,
});

describe("ledger — large-amount fidelity", () => {
  let store: LedgerStore;

  beforeEach(() => {
    resetIdCounter();
    store = newLedger();
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips a single amount above 2^53 exactly", async () => {
    await recordStreamOpened({ store, ctx: ctx("stream-big") });
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-big"),
      amount: LARGE_A,
      nonce: "0x01",
    });
    await recordPaymentVerified({
      store,
      ctx: ctx("stream-big"),
      amount: LARGE_A,
      nonce: "0x01",
    });

    const entries = await store.entries();
    const verified = entries.find((e) => e.event === "payment.verified");
    expect(verified?.amount).toBe(LARGE_A);
    // Sanity: the value is *strictly* above JS-number precision so any
    // accidental narrowing to a `number` would change it.
    expect(LARGE_A).toBeGreaterThan(2n ** 53n);
  });

  it("preserves two distinct large amounts side by side", async () => {
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-a"),
      amount: LARGE_A,
      nonce: "0xa1",
    });
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-b"),
      amount: LARGE_B,
      nonce: "0xb1",
    });

    const entries = await store.entries();
    const demanded = entries.filter((e) => e.event === "payment.demanded");
    expect(demanded).toHaveLength(2);
    const amounts = demanded.map((e) => e.amount).sort();
    expect(amounts[0]).toBe(LARGE_B);
    expect(amounts[1]).toBe(LARGE_A);
  });

  it("sums large amounts without overflow in window spend", async () => {
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-sum"),
      amount: LARGE_A,
      nonce: "0xa",
    });
    await recordPaymentVerified({
      store,
      ctx: ctx("stream-sum"),
      amount: LARGE_A,
      nonce: "0xa",
    });

    const spend = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: LARGE_A * 10n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: Date.parse("2026-01-01T00:00:00.000Z") + 5,
      periodMs: 60_000,
    });
    expect(spend.windowSpend).toBe(LARGE_A);
    expect(spend.paymentCount).toBe(1);
  });
});

describe("ledger — window roll", () => {
  let store: LedgerStore;

  beforeEach(() => {
    resetIdCounter();
    store = newLedger();
  });

  afterEach(() => {
    store.close();
  });

  it("drops payments that aged past the rolling window", async () => {
    const periodMs = 60_000;
    // The fixtures clock starts at 2026-01-01T00:00:00.000Z and ticks
    // 1 ms per call. We treat `t=0` as "first event".
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-roll"),
      amount: 1_000n,
      nonce: "0x01",
    });
    await recordPaymentVerified({
      store,
      ctx: ctx("stream-roll"),
      amount: 1_000n,
      nonce: "0x01",
    });

    // Inside the window: the payment counts.
    const insideMs = (
      store as LedgerStore & { __clockMs: () => number }
    ).__clockMs();
    const inside = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: 100_000n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: insideMs,
      periodMs,
    });
    expect(inside.windowSpend).toBe(1_000n);
    expect(inside.paymentCount).toBe(1);

    // Past the window: the payment must no longer count.
    const outside = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: 100_000n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: insideMs + periodMs + 1,
      periodMs,
    });
    expect(outside.windowSpend).toBe(0n);
    expect(outside.paymentCount).toBe(0);
    // But the cap and budget figures are still reported (just no spend).
    expect(outside.onChainCap).toBe(100_000n);
    expect(outside.remainingLocalBudget).toBe(80_000n);
    expect(outside.remainingOnChainCap).toBe(100_000n);
  });

  it("does not carry old payments into a fresh window", async () => {
    const periodMs = 30_000;
    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-old"),
      amount: 500n,
      nonce: "0x02",
    });
    await recordPaymentVerified({
      store,
      ctx: ctx("stream-old"),
      amount: 500n,
      nonce: "0x02",
    });

    // A second, fresh payment after the first has rolled out.
    const ledgerNow = (
      store as LedgerStore & { __clockMs: () => number }
    ).__clockMs();
    const futureNow = ledgerNow + periodMs + 5;

    await recordPaymentDemanded({
      store,
      ctx: ctx("stream-new"),
      amount: 200n,
      nonce: "0x03",
      timestamp: new Date(futureNow).toISOString(),
    });
    await recordPaymentVerified({
      store,
      ctx: ctx("stream-new"),
      amount: 200n,
      nonce: "0x03",
      timestamp: new Date(futureNow + 1).toISOString(),
    });

    const spend = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: 10_000n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: futureNow + 2,
      periodMs,
    });
    expect(spend.windowSpend).toBe(200n);
    expect(spend.paymentCount).toBe(1);
  });
});

describe("ledger — nonce reconciliation", () => {
  let store: LedgerStore;

  beforeEach(() => {
    resetIdCounter();
    store = newLedger();
  });

  afterEach(() => {
    store.close();
  });

  it("returns the full lifecycle for one payment in append order", async () => {
    const nonce = "0xabcd";
    const streamCtx = ctx("stream-life");

    await recordPaymentDemanded({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
    });
    await recordPaymentSigned({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
    });
    await recordPaymentVerified({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
    });
    await recordSegmentDelivered({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
      secondsDelivered: 1,
      unitsDelivered: 1,
    });
    await recordSettlementSubmitted({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
      transactionHash: SAMPLE_TX_HASH,
    });
    await recordSettlementConfirmed({
      store,
      ctx: streamCtx,
      amount: 7_777n,
      nonce,
      transactionHash: SAMPLE_TX_HASH,
    });

    const life = await lookupByNonce(store, nonce);
    expect(life).not.toBeNull();
    expect(life!.nonce).toBe(nonce);

    // `all` carries every entry on the nonce in append order, which
    // is the canonical "full lifecycle" view the spec asks for.
    expect(life!.all.map((e) => e.event)).toEqual([
      "payment.demanded",
      "payment.signed",
      "payment.verified",
      "segment.delivered",
      "settlement.submitted",
      "settlement.confirmed",
    ]);

    // Each phase is also surfaced in its own bucket.
    expect(life!.verification).toHaveLength(1);
    expect(life!.delivery).toHaveLength(1);
    expect(life!.settlementSubmitted).toHaveLength(1);
    expect(life!.settlementConfirmed).toHaveLength(1);
    expect(life!.settlementFailed).toHaveLength(0);
    expect(life!.failures).toHaveLength(0);
  });

  it("routes a settlement.failed into the failures bucket", async () => {
    const nonce = "0xbad";
    const streamCtx = ctx("stream-fail");
    await recordPaymentDemanded({
      store,
      ctx: streamCtx,
      amount: 100n,
      nonce,
    });
    await recordPaymentVerified({
      store,
      ctx: streamCtx,
      amount: 100n,
      nonce,
    });
    await recordSettlementFailed({
      store,
      ctx: streamCtx,
      amount: 100n,
      nonce,
      classification: "settler-out-of-gas",
    });

    const life = await lookupByNonce(store, nonce);
    expect(life).not.toBeNull();
    expect(life!.settlementFailed).toHaveLength(1);
    expect(life!.settlementFailed[0]?.classification).toBe(
      "settler-out-of-gas",
    );
    expect(life!.settlementConfirmed).toHaveLength(0);
  });

  it("returns null for an unseen nonce", async () => {
    expect(await lookupByNonce(store, "0x-missing")).toBeNull();
  });
});

describe("ledger — correction by append", () => {
  let store: LedgerStore;

  beforeEach(() => {
    resetIdCounter();
    store = newLedger();
  });

  afterEach(() => {
    store.close();
  });

  it("preserves the original entry and appends a correction", async () => {
    const streamCtx = ctx("stream-correct");
    const original = await recordPaymentVerified({
      store,
      ctx: streamCtx,
      amount: 1_000n,
      nonce: "0xc0",
    });

    const correction = await recordCorrection(store, original, {
      amount: 5_000n,
      detail: "amount was wrong; corrected after replaying audit log",
    });

    const entries = await store.entries();
    // Both entries are present; the original is byte-for-byte unchanged.
    expect(entries).toHaveLength(2);
    const stillThere = entries.find((e) => e.id === original.id);
    expect(stillThere?.amount).toBe(1_000n);
    expect(stillThere?.event).toBe("payment.verified");
    expect(stillThere?.correctsEntryId).toBeNull();

    // The correction points at the original and carries the new amount.
    expect(correction.correctsEntryId).toBe(original.id);
    expect(correction.amount).toBe(5_000n);
    expect(correction.event).toBe("payment.verified");

    // Original sequence < correction sequence.
    expect(original.sequence).toBeLessThan(correction.sequence);
  });

  it("surfaces the correction in computeWindowSpend", async () => {
    const streamCtx = ctx("stream-correct-win");
    const original = await recordPaymentVerified({
      store,
      ctx: streamCtx,
      amount: 100n,
      nonce: "0xc1",
    });

    // Before the correction: window spend is 100n.
    let spend = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: 100_000n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: Date.parse("2026-01-01T00:00:00.000Z") + 5,
      periodMs: 60_000,
    });
    expect(spend.windowSpend).toBe(100n);

    await recordCorrection(store, original, { amount: 900n });

    // After the correction: the same logical payment now counts as 900n.
    spend = await computeWindowSpend(store, {
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      token: SAMPLE_TOKEN,
      onChainCap: 100_000n,
      budgetMarginFraction: fraction(8n * 10n ** 17n),
      nowMs: Date.parse("2026-01-01T00:00:00.000Z") + 5,
      periodMs: 60_000,
    });
    expect(spend.windowSpend).toBe(900n);
    expect(spend.paymentCount).toBe(1);
  });

  it("surfaces a correction that reclassifies a settlement.failed (event type preserved)", async () => {
    // Correction-by-append never changes the event type — the correction
    // is "same stage, fixed classification". This test pins that contract
    // and confirms the aggregator honours it.
    const streamCtx = ctx("stream-correct-exposure");
    const segment = await recordSegmentDelivered({
      store,
      ctx: streamCtx,
      amount: 2_000n,
      nonce: "0xc2",
      secondsDelivered: 2,
      unitsDelivered: 2,
    });
    const failed = await recordSettlementFailed({
      store,
      ctx: streamCtx,
      amount: 2_000n,
      nonce: "0xc2",
      classification: "settler-out-of-gas",
    });

    // Before correction: in-flight exposure is up, unrecovered is up.
    let exposure = await computeUnsettledExposure(store);
    let byStream = exposure.find(
      (e) => e.streamId === "stream-correct-exposure",
    );
    expect(byStream?.inFlight).toBe(2_000n);
    expect(byStream?.unrecovered).toBe(2_000n);

    // Correct the failed entry's classification (still a `settlement.failed`,
    // but with the right reason). The contract is the event stays the same.
    await recordCorrection(store, failed, {
      classification: "settlement-reverted",
      detail: "settler actually reverted on-chain with a different reason",
    });

    // In-flight is unchanged (still 2000n — failed settlements don't fall
    // exposure), unrecovered is also unchanged (the correction is still a
    // failed settlement from the aggregator's point of view).
    exposure = await computeUnsettledExposure(store);
    byStream = exposure.find((e) => e.streamId === "stream-correct-exposure");
    expect(byStream?.inFlight).toBe(2_000n);
    expect(byStream?.unrecovered).toBe(2_000n);

    // The aggregator's view is corrected: only the latest entry in the
    // logical family is counted. The original `settlement.failed` is on
    // disk but invisible to the aggregator.
    const entries = await store.entries();
    expect(entries.filter((e) => e.correctsEntryId === failed.id)).toHaveLength(
      1,
    );

    // The delivered segment is still on disk unchanged.
    const segmentEntry = entries.find((e) => e.id === segment.id);
    expect(segmentEntry?.event).toBe("segment.delivered");
    expect(segmentEntry?.amount).toBe(2_000n);
    expect(entries.some((e) => e.id === failed.id)).toBe(true);
  });

  it("append-only invariant: store.entries grows monotonically and never edits a row", async () => {
    const streamCtx = ctx("stream-appendonly");
    const original = await recordPaymentDemanded({
      store,
      ctx: streamCtx,
      amount: 1n,
      nonce: "0xaa",
    });
    const beforeSeq = original.sequence;

    // Snapshot of every field on the original; the test asserts the
    // snapshot is unchanged after a correction is appended.
    const stringify = (v: unknown) =>
      JSON.stringify(v, (_k, val) =>
        typeof val === "bigint" ? val.toString() : val,
      );
    const snapshot = stringify(await store.entries());

    await recordCorrection(store, original, { amount: 2n });

    const allAfter = await store.entries();
    const afterSeq = allAfter[allAfter.length - 1]?.sequence;
    expect(afterSeq).toBeGreaterThan(beforeSeq);

    // Re-derive: the original row in the new entries list matches the
    // snapshot exactly. We compare by re-stringifying.
    const newSnapshot = stringify(
      (await store.entries()).filter((e) => e.id === original.id),
    );
    expect(newSnapshot).toBe(stringify([original]));
    // And the full ledger snapshot differs only by the appended row.
    expect(stringify(await store.entries())).not.toBe(snapshot);
  });
});
