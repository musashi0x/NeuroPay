import { describe, expect, it } from "vitest";
import type { ConsoleSnapshot } from "../src/index.js";
import { reviveBigints, reviveWire, toJsonSafe } from "../src/wire.js";

const SNAPSHOT: ConsoleSnapshot = {
  session: {
    walletAddress: "0x1111111111111111111111111111111111111111",
    publicKey: `0x${"ab".repeat(33)}`,
    status: "active",
    allowedCalls: [],
    spendCap: {
      token: "0x2222222222222222222222222222222222222222",
      tokenDecimals: 18,
      tokenSymbol: "npUSD",
      limit: 50n * 10n ** 18n,
      periodSeconds: 86_400,
    },
    expiresAt: "2026-08-21T00:00:00.000Z",
    remainingLifetimeSeconds: 3_600,
    grantTransactionHash: null,
    railProvisioned: true,
  },
  streams: [
    {
      streamId: "stream-1",
      status: "active",
      endReason: null,
      tokenSymbol: "npUSD",
      priceSheet: {
        id: "sheet-1",
        version: 1,
        chainId: 97,
        token: "0x2222222222222222222222222222222222222222",
        tokenDecimals: 18,
        perCall: 1n,
        perSecond: 2n,
        perUnit: 10_000_000_000_000n,
        unitName: "unit",
        issuedAt: "2026-08-17T00:00:00.000Z",
      },
      accruedUnpaid: 10_000_000_000_000_000n,
      totalAccrued: 20_000_000_000_000_000n,
      deliveredCalls: 2,
      deliveredSeconds: 12,
      deliveredUnits: 4,
      secondsUntilNextTick: 48,
      inFlightSettlements: 0,
      openedAt: "2026-08-17T00:00:00.000Z",
      expiresAt: "2026-08-17T01:00:00.000Z",
    },
  ],
  budget: {
    token: "0x2222222222222222222222222222222222222222",
    tokenDecimals: 18,
    tokenSymbol: "npUSD",
    windowStart: "2026-08-17T00:00:00.000Z",
    windowEnd: "2026-08-18T00:00:00.000Z",
    periodSeconds: 86_400,
    spent: 1n,
    localLimit: 40n * 10n ** 18n,
    localRemaining: 40n * 10n ** 18n - 1n,
    onChainCap: 50n * 10n ** 18n,
    onChainRemaining: 50n * 10n ** 18n - 1n,
    exhausted: false,
  },
  payments: [
    {
      id: "pay-1",
      sequence: 1,
      timestamp: "2026-08-17T00:00:01.000Z",
      event: "payment.verified",
      streamId: "stream-1",
      sessionPublicKey: `0x${"ab".repeat(33)}`,
      chainId: 97,
      token: "0x2222222222222222222222222222222222222222",
      tokenDecimals: 18,
      amount: 5n * 10n ** 16n,
      nonce: "12345678901234567890",
      transactionHash: null,
      classification: null,
      correctsEntryId: null,
      detail: null,
    },
  ],
};

describe("bigint wire codec", () => {
  it("round-trips a console snapshot through JSON", () => {
    const encoded = toJsonSafe(SNAPSHOT);
    const json = JSON.parse(JSON.stringify(encoded)) as unknown;
    const revived = reviveBigints(json) as ConsoleSnapshot;

    expect(revived.session?.spendCap.limit).toBe(50n * 10n ** 18n);
    expect(revived.streams[0]?.accruedUnpaid).toBe(10_000_000_000_000_000n);
    expect(revived.streams[0]?.priceSheet.perUnit).toBe(10_000_000_000_000n);
    expect(revived.budget?.localLimit).toBe(40n * 10n ** 18n);
    expect(revived.payments[0]?.amount).toBe(5n * 10n ** 16n);
  });

  it("leaves a decimal-looking nonce as a string", () => {
    const revived = reviveBigints(toJsonSafe(SNAPSHOT)) as ConsoleSnapshot;
    expect(revived.payments[0]?.nonce).toBe("12345678901234567890");
    expect(typeof revived.payments[0]?.nonce).toBe("string");
  });

  it("reviveWire is the same function as reviveBigints", () => {
    expect(reviveWire).toBe(reviveBigints);
  });
});
