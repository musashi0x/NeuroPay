/**
 * Coverage for the derived operational metrics.
 *
 * The fold is exercised directly with hand-built entries because the
 * interesting cases are orderings a happy-path integration test never
 * produces: a settlement recorded by both event families, a failure
 * followed by a late confirmation, a retry that resubmits. Each of those
 * is a way the naive "count the rows" implementation gets the number
 * wrong, and each is asserted here.
 */

import { describe, expect, it } from "vitest";

import type { LedgerEntry, LedgerEventType } from "@neuro-pay/types";

import { computeLedgerMetrics, foldLedgerMetrics } from "../src/metrics.js";
import {
  newLedger,
  SAMPLE_CHAIN_ID,
  SAMPLE_TOKEN,
  SAMPLE_TOKEN_DECIMALS,
} from "./_fixtures.js";

let seq = 0;

/** Minimal entry builder — only the fields the fold reads are meaningful. */
function entry(
  event: LedgerEventType,
  overrides: Partial<LedgerEntry> = {},
): LedgerEntry {
  seq += 1;
  return {
    id: `e-${seq}`,
    sequence: seq,
    timestamp: "2026-01-01T00:00:00.000Z",
    event,
    streamId: "stream-1",
    sessionPublicKey: null,
    chainId: SAMPLE_CHAIN_ID,
    token: SAMPLE_TOKEN,
    tokenDecimals: SAMPLE_TOKEN_DECIMALS,
    amount: null,
    nonce: null,
    transactionHash: null,
    classification: null,
    correctsEntryId: null,
    detail: null,
    ...overrides,
  };
}

describe("foldLedgerMetrics", () => {
  it("returns the empty shape for an empty ledger", () => {
    const metrics = foldLedgerMetrics([]);
    expect(metrics.entries).toBe(0);
    expect(metrics.settlement.latency).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  it("counts a settlement once when both event families record it", () => {
    // The queue writes `settlement.*` and the chain settler writes
    // `payment.settlement.*` for the same nonce. Counting rows would
    // report two settlements where one happened.
    const metrics = foldLedgerMetrics([
      entry("settlement.submitted", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      entry("payment.settlement.submitted", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:00.100Z",
      }),
      entry("payment.settlement.confirmed", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:04.000Z",
      }),
      entry("settlement.confirmed", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:04.050Z",
      }),
    ]);

    expect(metrics.settlement.submitted).toBe(1);
    expect(metrics.settlement.confirmed).toBe(1);
    expect(metrics.settlement.inFlight).toBe(0);
    // Measured from the first submission to the first confirmation:
    // 00.000 → 04.000.
    expect(metrics.settlement.latency).toEqual({
      count: 1,
      p50Ms: 4000,
      p95Ms: 4000,
      maxMs: 4000,
    });
  });

  it("measures latency from the first submission, not a resubmit", () => {
    const metrics = foldLedgerMetrics([
      entry("settlement.submitted", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      entry("settlement.retry", { nonce: "n1" }),
      entry("settlement.submitted", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:09.000Z",
      }),
      entry("settlement.confirmed", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:10.000Z",
      }),
    ]);

    expect(metrics.settlement.retried).toBe(1);
    expect(metrics.settlement.latency.maxMs).toBe(10_000);
  });

  it("counts a submitted-but-unresolved settlement as in flight", () => {
    const metrics = foldLedgerMetrics([
      entry("settlement.submitted", { nonce: "n1" }),
      entry("settlement.submitted", { nonce: "n2" }),
      entry("settlement.confirmed", { nonce: "n2" }),
    ]);

    expect(metrics.settlement.inFlight).toBe(1);
    expect(metrics.settlement.failedUnrecovered).toBe(0);
  });

  it("lets a late confirmation clear an earlier failure", () => {
    const metrics = foldLedgerMetrics([
      entry("settlement.submitted", {
        nonce: "n1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      entry("payment.settlement.lost", { nonce: "n1" }),
      entry("payment.settlement.confirmed", {
        nonce: "n1",
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    ]);

    expect(metrics.settlement.lost).toBe(0);
    expect(metrics.settlement.failed).toBe(0);
    expect(metrics.settlement.confirmed).toBe(1);
    expect(metrics.settlement.failedUnrecovered).toBe(0);
    expect(metrics.settlement.latency.maxMs).toBe(60_000);
  });

  it("counts a failure as unrecovered until a recovery event lands", () => {
    const failing = [
      entry("settlement.submitted", { nonce: "n1" }),
      entry("settlement.failed", {
        nonce: "n1",
        classification: "settlement-reverted",
      }),
    ];
    expect(foldLedgerMetrics(failing).settlement.failedUnrecovered).toBe(1);

    const recovered = [
      ...failing,
      entry("settlement.recovered", { nonce: "n1" }),
    ];
    const metrics = foldLedgerMetrics(recovered);
    expect(metrics.settlement.failed).toBe(1);
    expect(metrics.settlement.recovered).toBe(1);
    expect(metrics.settlement.failedUnrecovered).toBe(0);
  });

  it("buckets refusals and rejections by classification", () => {
    const metrics = foldLedgerMetrics([
      entry("payment.demanded"),
      entry("payment.verified"),
      entry("payment.refused", { classification: "budget-exhausted" }),
      entry("payment.refused", { classification: "budget-exhausted" }),
      entry("payment.rejected", { classification: "verification-failed" }),
      entry("payment.rejected", { classification: null }),
    ]);

    expect(metrics.verification.demanded).toBe(1);
    expect(metrics.verification.verified).toBe(1);
    expect(metrics.verification.refused).toBe(2);
    expect(metrics.verification.rejected).toBe(2);
    expect(metrics.verification.byClassification).toEqual({
      "budget-exhausted": 2,
      "verification-failed": 1,
      unclassified: 1,
    });
  });

  it("reports nearest-rank quantiles over the whole sample", () => {
    const entries: LedgerEntry[] = [];
    // Ten settlements, 1s through 10s.
    for (let i = 1; i <= 10; i += 1) {
      entries.push(
        entry("settlement.submitted", {
          nonce: `n${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        entry("settlement.confirmed", {
          nonce: `n${i}`,
          timestamp: new Date(
            Date.parse("2026-01-01T00:00:00.000Z") + i * 1000,
          ).toISOString(),
        }),
      );
    }

    expect(foldLedgerMetrics(entries).settlement.latency).toEqual({
      count: 10,
      p50Ms: 5000,
      p95Ms: 10_000,
      maxMs: 10_000,
    });
  });

  it("counts stream and session lifecycle events", () => {
    const metrics = foldLedgerMetrics([
      entry("stream.opened"),
      entry("stream.opened"),
      entry("stream.ended"),
      entry("stream.abandoned"),
      entry("segment.delivered", { nonce: "n1" }),
      entry("session.granted"),
      entry("session.revoked"),
    ]);

    expect(metrics.streams).toEqual({ opened: 2, ended: 1, abandoned: 1 });
    expect(metrics.delivery.segments).toBe(1);
    expect(metrics.session).toEqual({ granted: 1, revoked: 1 });
  });
});

describe("computeLedgerMetrics", () => {
  it("reads through a real store", async () => {
    const store = newLedger();
    await store.append({
      event: "stream.opened",
      streamId: "s1",
      sessionPublicKey: null,
      chainId: SAMPLE_CHAIN_ID,
      token: SAMPLE_TOKEN,
      tokenDecimals: SAMPLE_TOKEN_DECIMALS,
      amount: null,
      nonce: null,
      transactionHash: null,
      classification: null,
      correctsEntryId: null,
      detail: null,
    });

    const metrics = await computeLedgerMetrics(store);
    expect(metrics.entries).toBe(1);
    expect(metrics.streams.opened).toBe(1);
    store.close();
  });
});
