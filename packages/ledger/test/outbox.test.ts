import { describe, expect, it } from "vitest";
import { openLedgerStore } from "../src/index.js";
import type { Address, Hex } from "@neuro-pay/types";
import type { SettlementIntent } from "../src/outbox.js";

const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const PAYER = "0x000000000000000000000000000000000000c0de" as Address;
const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;

function intent(
  nonce: string,
  overrides: Partial<SettlementIntent> = {},
): SettlementIntent {
  return {
    nonce,
    streamId: "s-1",
    sessionPublicKey: null,
    chainId: 97,
    token: TOKEN,
    tokenDecimals: 18,
    amount: 1000n,
    payer: PAYER,
    payTo: PAY_TO,
    deadline: null,
    status: "pending",
    transactionHash: null,
    attempts: 0,
    lastError: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("settlement outbox", () => {
  it("round-trips a pending intent", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    expect(await store.putIntent(intent("n-1"))).toBe(true);
    const read = await store.getIntent("n-1");
    expect(read?.status).toBe("pending");
    expect(read?.amount).toBe(1000n);
    expect(read?.payer).toBe(PAYER);
  });

  it("ignores a second insert for the same nonce", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    await store.putIntent(intent("n-1", { amount: 1n }));
    expect(await store.putIntent(intent("n-1", { amount: 99n }))).toBe(false);
    expect((await store.getIntent("n-1"))?.amount).toBe(1n);
  });

  it("updates status, tx hash, and attempts", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    await store.putIntent(intent("n-1"));
    const hash = ("0x" + "ab".repeat(32)) as Hex;
    const updated = await store.updateIntent("n-1", {
      status: "submitted",
      transactionHash: hash,
      attempts: 2,
    });
    expect(updated?.status).toBe("submitted");
    expect(updated?.transactionHash).toBe(hash);
    expect(updated?.attempts).toBe(2);
    const listed = await store.listIntents("submitted");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.nonce).toBe("n-1");
  });

  it("lists delivery nonces for unknown-intent detection", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    await store.putDelivery({
      nonce: "d-1",
      recordedAt: "2024-01-01T00:00:00.000Z",
      payload: {
        streamId: "s-1",
        sequence: 1,
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
        accruedUnpaid: 0n,
        totalAccrued: 0n,
        streamEnded: false,
        endReason: null,
      },
    });
    expect(await store.listDeliveryNonces()).toEqual(["d-1"]);
  });
});
