/**
 * Round-trip coverage for the P0 `payment.settlement.*` ledger helpers.
 *
 * The P0 settlement flow adds four new event types — submitted,
 * confirmed, failed, lost — alongside the existing `settlement.*` events
 * the in-memory settler has always emitted. Each helper must:
 *
 * - accept a typed input,
 * - append a row whose `kind` matches the helper's event type,
 * - carry the `amount`, `nonce`, and `transactionHash` (when present)
 *   fields verbatim through the SQLite store.
 *
 * Tests use the in-memory `node:sqlite` backend via `openLedgerStore` so
 * no on-disk fixture is created and no network is touched.
 */

import { describe, expect, it } from "vitest";

import {
  recordPaymentSettlementConfirmed,
  recordPaymentSettlementFailed,
  recordPaymentSettlementLost,
  recordPaymentSettlementSubmitted,
} from "../src/index.js";
import type { EventContext, LedgerStore } from "../src/index.js";
import { newLedger, resetIdCounter } from "./_fixtures.js";

const CTX: EventContext = {
  streamId: "stream-1",
  sessionPublicKey: null,
  chainId: 97,
  token: "0x000000000000000000000000000000000000bEEF",
  tokenDecimals: 18,
};

function txHash(seed: number): `0x${string}` {
  return ("0x" + seed.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
}

describe("payment.settlement.* helpers (P0)", () => {
  let ledger: LedgerStore & { __clockMs: () => number };
  resetIdCounter();

  it("submitted carries amount, nonce, and tx hash", async () => {
    ledger = newLedger();
    const entry = await recordPaymentSettlementSubmitted({
      store: ledger,
      ctx: CTX,
      amount: 12_345n,
      nonce: "nonce-submitted",
      transactionHash: txHash(1),
    });
    expect(entry.event).toBe("payment.settlement.submitted");
    expect(entry.amount).toBe(12_345n);
    expect(entry.nonce).toBe("nonce-submitted");
    expect(entry.transactionHash).toBe(txHash(1));
  });

  it("confirmed carries amount, nonce, and tx hash", async () => {
    ledger = newLedger();
    const entry = await recordPaymentSettlementConfirmed({
      store: ledger,
      ctx: CTX,
      amount: 99_000n,
      nonce: "nonce-confirmed",
      transactionHash: txHash(2),
    });
    expect(entry.event).toBe("payment.settlement.confirmed");
    expect(entry.amount).toBe(99_000n);
    expect(entry.nonce).toBe("nonce-confirmed");
    expect(entry.transactionHash).toBe(txHash(2));
  });

  it("failed carries classification and an optional tx hash", async () => {
    ledger = newLedger();
    const entry = await recordPaymentSettlementFailed({
      store: ledger,
      ctx: CTX,
      amount: 5_000n,
      nonce: "nonce-failed",
      classification: "settler-out-of-gas",
      transactionHash: txHash(3),
      detail: "drained settler",
    });
    expect(entry.event).toBe("payment.settlement.failed");
    expect(entry.amount).toBe(5_000n);
    expect(entry.nonce).toBe("nonce-failed");
    expect(entry.classification).toBe("settler-out-of-gas");
    expect(entry.transactionHash).toBe(txHash(3));
    expect(entry.detail).toBe("drained settler");
  });

  it("lost carries null tx hash when never submitted", async () => {
    ledger = newLedger();
    const entry = await recordPaymentSettlementLost({
      store: ledger,
      ctx: CTX,
      amount: 7_500n,
      nonce: "nonce-lost",
      transactionHash: null,
      detail: "no tx ever submitted",
    });
    expect(entry.event).toBe("payment.settlement.lost");
    expect(entry.amount).toBe(7_500n);
    expect(entry.nonce).toBe("nonce-lost");
    expect(entry.transactionHash).toBeNull();
  });
});
