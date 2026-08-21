import { describe, expect, it } from "vitest";
import type { LedgerEntry, StreamView } from "@neuro-pay/types";
import { paginatePayments, paginateStreams } from "./page.js";

function entry(
  sequence: number,
  event: LedgerEntry["event"] = "payment.signed",
): LedgerEntry {
  return {
    id: `e-${sequence}`,
    sequence,
    timestamp: "2026-08-17T00:00:00.000Z",
    event,
    streamId: sequence % 2 === 0 ? "s-even" : "s-odd",
    sessionPublicKey: null,
    chainId: 97,
    token: "0x0000000000000000000000000000000000000001",
    tokenDecimals: 18,
    amount: BigInt(sequence),
    nonce: String(sequence),
    transactionHash: null,
    classification: null,
    correctsEntryId: null,
    detail: null,
  };
}

function stream(
  id: string,
  openedAt: string,
  status: StreamView["status"],
): StreamView {
  return {
    streamId: id,
    status,
    endReason:
      status === "active"
        ? null
        : status === "abandoned"
          ? "abandoned"
          : "completed",
    tokenSymbol: "npUSD",
    priceSheet: {
      id: "p",
      version: 1,
      chainId: 97,
      token: "0x0000000000000000000000000000000000000001",
      tokenDecimals: 18,
      perCall: 0n,
      perSecond: 0n,
      perUnit: 0n,
      unitName: "u",
      issuedAt: openedAt,
    },
    accruedUnpaid: 0n,
    totalAccrued: 0n,
    deliveredCalls: 0,
    deliveredSeconds: 0,
    deliveredUnits: 0,
    secondsUntilNextTick: 0,
    inFlightSettlements: 0,
    openedAt,
    expiresAt: openedAt,
  };
}

describe("paginatePayments", () => {
  it("returns newest first and walks by sequence cursor", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)];
    const first = paginatePayments(entries, { limit: 2 });
    expect(first.items.map((e) => e.sequence)).toEqual([4, 3]);
    expect(first.nextCursor).toBe("3");

    const second = paginatePayments(entries, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((e) => e.sequence)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((e) => e.id)).size,
    ).toBe(4);
  });

  it("filters by event and streamId", () => {
    const entries = [entry(1, "payment.signed"), entry(2, "payment.verified")];
    const page = paginatePayments(entries, { event: "payment.verified" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.event).toBe("payment.verified");
  });
});

describe("paginateStreams", () => {
  it("filters abandoned separately from ended", () => {
    const streams = [
      stream("a", "2026-08-17T00:00:02.000Z", "active"),
      stream("b", "2026-08-17T00:00:01.000Z", "abandoned"),
      stream("c", "2026-08-17T00:00:00.000Z", "ended"),
    ];
    const page = paginateStreams(streams, { status: "abandoned" });
    expect(page.items.map((s) => s.streamId)).toEqual(["b"]);
  });

  it("pages newest-opened first", () => {
    const streams = [
      stream("old", "2026-08-17T00:00:00.000Z", "active"),
      stream("new", "2026-08-17T00:00:02.000Z", "active"),
    ];
    const first = paginateStreams(streams, { limit: 1 });
    expect(first.items[0]?.streamId).toBe("new");
    expect(first.nextCursor).toBeTruthy();
    const second = paginateStreams(streams, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items[0]?.streamId).toBe("old");
    expect(second.nextCursor).toBeNull();
  });
});
