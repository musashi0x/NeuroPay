/**
 * Immutable delivery records keyed by authorization nonce.
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore } from "../src/index.js";
import type { Address } from "@neuro-pay/types";

const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;

describe("delivery records", () => {
  it("round-trips a payload including amounts above Number.MAX_SAFE_INTEGER", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    const unpaid = (2n ** 63n) as bigint;
    const inserted = await store.putDelivery({
      nonce: "n-big",
      recordedAt: "2024-01-01T00:00:00.000Z",
      payload: {
        streamId: "s-1",
        sequence: 2,
        data: "hello",
        secondsDelivered: 5,
        unitsDelivered: 9,
        accruedUnpaid: unpaid,
        totalAccrued: unpaid,
        streamEnded: false,
        endReason: null,
      },
    });
    expect(inserted).toBe(true);

    const read = await store.getDelivery("n-big");
    expect(read).not.toBeNull();
    expect(read?.payload.data).toBe("hello");
    expect(read?.payload.accruedUnpaid).toBe(unpaid);
    expect(read?.payload.totalAccrued).toBe(unpaid);
    expect(read?.payload.sequence).toBe(2);
    void TOKEN;
  });

  it("ignores a second write for the same nonce (immutable)", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    const first = {
      streamId: "s-1",
      sequence: 1,
      data: "original",
      secondsDelivered: 1,
      unitsDelivered: 1,
      accruedUnpaid: 10n,
      totalAccrued: 10n,
      streamEnded: false,
      endReason: null,
    };
    await store.putDelivery({
      nonce: "n-imm",
      recordedAt: "2024-01-01T00:00:00.000Z",
      payload: first,
    });
    const second = await store.putDelivery({
      nonce: "n-imm",
      recordedAt: "2024-01-01T00:00:01.000Z",
      payload: { ...first, data: "mutated", accruedUnpaid: 99n },
    });
    expect(second).toBe(false);
    const read = await store.getDelivery("n-imm");
    expect(read?.payload.data).toBe("original");
    expect(read?.payload.accruedUnpaid).toBe(10n);
  });

  it("returns null for an unknown nonce", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    expect(await store.getDelivery("missing")).toBeNull();
  });
});
