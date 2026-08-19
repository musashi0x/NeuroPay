/**
 * Tests for the async settler (5.8).
 *
 * Verified:
 *  - happy path → tx hash returned, ledger records `settlement.submitted`
 *                   then `settlement.confirmed`
 *  - drained settler (out-of-gas) → ledger records `settlement.failed`
 *                   with classification `settler-out-of-gas`
 *  - reverted settlement → ledger records `settlement.failed` with
 *                   classification `settlement-reverted`
 */

import { describe, expect, it } from "vitest";
import {
  openLedgerStore,
  lookupByNonce,
  type LedgerStore,
} from "@neuro-pay/ledger";
import type { Address } from "@neuro-pay/types";
import {
  createInMemorySettler,
  createSettlementQueue,
  SettlerOutOfGasError,
  SettlementRevertedError,
  type Settler,
  type SettlementInput,
} from "./settle.js";

function newLedger(): LedgerStore {
  return openLedgerStore({ storagePath: ":memory:" });
}

const TOKEN: Address = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d";
const PAYER: Address = "0x000000000000000000000000000000000000c0de";
const PAY_TO: Address = "0x000000000000000000000000000000000000d3ad";

const baseInput: Omit<SettlementInput, "nonce"> = {
  streamId: "s1",
  sessionPublicKey: null,
  chainId: 97,
  token: TOKEN,
  tokenDecimals: 18,
  amount: 1000n,
  payer: PAYER,
  payTo: PAY_TO,
};

describe("settle - classification by cause", () => {
  it("happy path: records settlement.submitted then settlement.confirmed", async () => {
    const store = newLedger();
    const settler: Settler = createInMemorySettler({
      defaultBehavior: "confirm",
    });
    const queue = createSettlementQueue({ settler, store });

    const res = await queue.enqueue({ ...baseInput, nonce: "ok-1" });
    expect(res.transactionHash).toMatch(/^0x[0-9a-f]+$/i);

    await queue.drain();

    const lc = await lookupByNonce(store, "ok-1");
    expect(lc).not.toBeNull();
    if (lc) {
      const types = lc.all.map((e) => e.event);
      expect(types).toContain("settlement.confirmed");
      expect(types).not.toContain("settlement.failed");
    }
  });

  it("drained settler: classify as settler-out-of-gas (distinct from revert)", async () => {
    const store = newLedger();
    const settler = createInMemorySettler({ defaultBehavior: "out-of-gas" });
    const queue = createSettlementQueue({ settler, store });

    await expect(
      queue.enqueue({ ...baseInput, nonce: "gas-1" }),
    ).rejects.toBeInstanceOf(SettlerOutOfGasError);

    await queue.drain();

    const lc = await lookupByNonce(store, "gas-1");
    expect(lc).not.toBeNull();
    if (lc) {
      const failedEntry = lc.settlementFailed[0];
      expect(failedEntry?.classification).toBe("settler-out-of-gas");
    }
  });

  it("reverted settlement: classify as settlement-reverted", async () => {
    const store = newLedger();
    const settler = createInMemorySettler({ defaultBehavior: "revert" });
    const queue = createSettlementQueue({ settler, store });

    await expect(
      queue.enqueue({ ...baseInput, nonce: "revert-1" }),
    ).rejects.toBeInstanceOf(SettlementRevertedError);

    await queue.drain();

    const lc = await lookupByNonce(store, "revert-1");
    expect(lc).not.toBeNull();
    if (lc) {
      const failedEntry = lc.settlementFailed[0];
      expect(failedEntry?.classification).toBe("settlement-reverted");
    }
  });

  it("inFlight() decreases as settlements drain", async () => {
    const store = newLedger();
    const settler = createInMemorySettler({ defaultBehavior: "confirm" });
    const queue = createSettlementQueue({ settler, store });

    await queue.enqueue({ ...baseInput, nonce: "flow-1", amount: 1n });
    expect(queue.inFlight()).toBe(1);
    await queue.drain();
    expect(queue.inFlight()).toBe(0);
  });

  it("invokes onConfirmed after a successful confirmation", async () => {
    const store = newLedger();
    const settler = createInMemorySettler({ defaultBehavior: "confirm" });
    const confirmed: string[] = [];
    const queue = createSettlementQueue({
      settler,
      store,
      hooks: {
        onConfirmed: (s) => {
          confirmed.push(s.nonce);
        },
      },
    });

    await queue.enqueue({ ...baseInput, nonce: "hook-ok" });
    await queue.drain();
    expect(confirmed).toEqual(["hook-ok"]);
  });

  it("invokes onFailed and does not invoke onConfirmed on revert", async () => {
    const store = newLedger();
    const settler = createInMemorySettler({ defaultBehavior: "revert" });
    const confirmed: string[] = [];
    const failed: string[] = [];
    const queue = createSettlementQueue({
      settler,
      store,
      hooks: {
        onConfirmed: (s) => {
          confirmed.push(s.nonce);
        },
        onFailed: (s, failure) => {
          failed.push(`${s.nonce}:${failure.classification}`);
        },
      },
    });

    await expect(
      queue.enqueue({ ...baseInput, nonce: "hook-fail" }),
    ).rejects.toBeInstanceOf(SettlementRevertedError);
    await queue.drain();
    expect(confirmed).toEqual([]);
    expect(failed).toEqual(["hook-fail:settlement-reverted"]);
  });
});
