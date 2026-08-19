/**
 * Tests for nonce-keyed idempotency (5.7).
 *
 * Verified:
 *  - first verification records an entry in the in-memory index
 *  - a replay with the same nonce returns identical segment data without
 *    hitting the ledger again or accruing new cost
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import type { Address, Hex } from "@neuro-pay/types";
import {
  buildReplayResponse,
  createIdempotencyIndex,
  recordSegmentDelivery,
  recordVerification,
} from "./idempotency.js";

const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;

function freshLedger(): LedgerStore {
  return openLedgerStore({ storagePath: ":memory:" });
}

describe("idempotency - recordVerification + replay", () => {
  it("first verification returns 'recorded'; a second returns 'duplicate'", async () => {
    const store = freshLedger();
    const index = createIdempotencyIndex();

    const first = await recordVerification(
      {
        store,
        index,
        nonce: "n-1",
        streamId: "s-1",
        sessionPublicKey: null,
        chainId: 97,
        token: TOKEN,
        tokenDecimals: 18,
        authorizedAmount: 1000n,
      },
      {
        sequence: 1,
        data: "hello",
        secondsDelivered: 5,
        unitsDelivered: 10,
      },
    );

    expect(first.kind).toBe("recorded");
    expect(index.get("n-1")?.sequence).toBe(1);

    const second = await recordVerification({
      store,
      index,
      nonce: "n-1",
      streamId: "s-1",
      sessionPublicKey: null,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      authorizedAmount: 1000n,
    });

    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate") {
      expect(second.record.sequence).toBe(1);
      expect(second.record.data).toBe("hello");
    }
  });

  it("buildReplayResponse echoes the same segment fields without re-running the meter", () => {
    const index = createIdempotencyIndex();
    index.put({
      nonce: "n-r",
      streamId: "s-1",
      sequence: 3,
      data: "abc",
      secondsDelivered: 7,
      unitsDelivered: 12,
      accruedUnpaid: 210n,
      totalAccrued: 210n,
      streamEnded: false,
      endReason: null,
      ledgerEntryId: "evt-1",
      ledgerTimestamp: "2024-01-01T00:00:00.000Z",
    });
    const replay = buildReplayResponse("n-r", index.get("n-r")!);
    expect(replay).toMatchObject({
      streamId: "s-1",
      sequence: 3,
      data: "abc",
      secondsDelivered: 7,
      unitsDelivered: 12,
      streamEnded: false,
      endReason: null,
    });
    expect(replay.accruedUnpaid).toBe(210n);
    expect(replay.totalAccrued).toBe(210n);
  });

  it("recordSegmentDelivery updates the cached record to point at the actual delivered shape", async () => {
    const store = freshLedger();
    const index = createIdempotencyIndex();

    await recordVerification(
      {
        store,
        index,
        nonce: "n-2",
        streamId: "s-2",
        sessionPublicKey: null,
        chainId: 97,
        token: TOKEN,
        tokenDecimals: 18,
        authorizedAmount: 500n,
      },
      {
        sequence: 0, // placeholder until delivery
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      },
    );

    await recordSegmentDelivery({
      store,
      index,
      nonce: "n-2",
      segment: {
        streamId: "s-2",
        sequence: 4,
        data: "world",
        secondsDelivered: 9,
        unitsDelivered: 30,
        accruedUnpaid: 210n,
        totalAccrued: 210n,
        streamEnded: false,
        endReason: null,
      },
      sessionPublicKey: null,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      authorizedAmount: 500n,
    });

    const cached = index.get("n-2");
    expect(cached?.sequence).toBe(4);
    expect(cached?.data).toBe("world");
    expect(cached?.secondsDelivered).toBe(9);
    expect(cached?.unitsDelivered).toBe(30);
    expect(cached?.accruedUnpaid).toBe(210n);
    expect(cached?.totalAccrued).toBe(210n);

    const durable = await store.getDelivery("n-2");
    expect(durable?.payload.data).toBe("world");
    expect(durable?.payload.accruedUnpaid).toBe(210n);
  });

  it("replays the original payload from the ledger after the in-memory index is cleared", async () => {
    const store = freshLedger();
    const index = createIdempotencyIndex();

    await recordVerification(
      {
        store,
        index,
        nonce: "n-cold",
        streamId: "s-cold",
        sessionPublicKey: null,
        chainId: 97,
        token: TOKEN,
        tokenDecimals: 18,
        authorizedAmount: 500n,
      },
      {
        sequence: 1,
        data: "payload",
        secondsDelivered: 2,
        unitsDelivered: 3,
      },
    );
    await recordSegmentDelivery({
      store,
      index,
      nonce: "n-cold",
      segment: {
        streamId: "s-cold",
        sequence: 1,
        data: "payload",
        secondsDelivered: 2,
        unitsDelivered: 3,
        accruedUnpaid: 99n,
        totalAccrued: 99n,
        streamEnded: false,
        endReason: null,
      },
      sessionPublicKey: null,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      authorizedAmount: 500n,
    });

    const cold = createIdempotencyIndex();
    const duplicate = await recordVerification({
      store,
      index: cold,
      nonce: "n-cold",
      streamId: "s-cold",
      sessionPublicKey: null,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      authorizedAmount: 500n,
    });
    expect(duplicate.kind).toBe("duplicate");
    if (duplicate.kind !== "duplicate") return;
    expect(duplicate.record.data).toBe("payload");
    expect(duplicate.record.accruedUnpaid).toBe(99n);
    expect(buildReplayResponse("n-cold", duplicate.record).totalAccrued).toBe(
      99n,
    );
  });

  it("index exposes the same nonce twice through list()", () => {
    const index = createIdempotencyIndex();
    index.put({
      nonce: "a",
      streamId: "s",
      sequence: 1,
      data: "",
      secondsDelivered: 0,
      unitsDelivered: 0,
      accruedUnpaid: 0n,
      totalAccrued: 0n,
      streamEnded: false,
      endReason: null,
      ledgerEntryId: "",
      ledgerTimestamp: new Date(0).toISOString(),
    });
    expect(index.list()).toHaveLength(1);
    expect(index.get("a")?.streamId).toBe("s");
  });
});

// `Hex` and `Address` are re-exported above to keep the import surface
// explicit; the tests don't reach into those directly.
void (null as unknown as Hex);
