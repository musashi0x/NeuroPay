import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import type { PriceSheet } from "@neuro-pay/types";
import {
  accrueCalls,
  accrueSeconds,
  accrueUnits,
  createMeterState,
  settle,
} from "../src/accrual.js";

/**
 * Spec scenarios covered here:
 *
 * - "Three metering dimensions":
 *     per-call accrual,
 *     per-second accrual (with fractional seconds),
 *     per-unit accrual,
 *     dimensions combine.
 * - "Accrual arithmetic is exact":
 *     amounts are bigints,
 *     fractional seconds round consistently (the 4.5-second → 45-unit scenario).
 */

const PRICE_SHEET: PriceSheet = {
  id: "test",
  version: 1,
  chainId: 97,
  token: "0x0000000000000000000000000000000000000000",
  tokenDecimals: 18,
  perCall: 100n,
  perSecond: 10n,
  perUnit: 2n,
  unitName: "token",
  issuedAt: "2026-08-17T00:00:00.000Z",
};

const FIXED_CLOCK: Clock = { now: () => 1_700_000_000_000 };

describe("createMeterState", () => {
  it("starts with zero accrual and no lastPaidAt", () => {
    const state = createMeterState();
    expect(state.accruedUnpaid).toBe(0n);
    expect(state.totalAccrued).toBe(0n);
    expect(state.deliveredCalls).toBe(0);
    expect(state.deliveredSeconds).toBe(0);
    expect(state.deliveredUnits).toBe(0);
    expect(state.lastPaidAtMs).toBeNull();
  });
});

describe("three metering dimensions", () => {
  it("accrues per-call across three calls: 3 × 100 = 300", () => {
    // Scenario: 100 units per call × 3 calls → 300.
    const start = createMeterState();
    const afterOne = accrueCalls(start, PRICE_SHEET, 1);
    const afterThree = accrueCalls(afterOne, PRICE_SHEET, 2);

    expect(afterThree.accruedUnpaid).toBe(300n);
    expect(afterThree.totalAccrued).toBe(300n);
    expect(afterThree.deliveredCalls).toBe(3);
  });

  it("accrues per-second with fractional seconds: 10 × 4500 ms = 45 units", () => {
    // Scenario: 10 units/sec over 4.5 s → 45 units, rounded half-up.
    const start = createMeterState();
    const after = accrueSeconds(start, PRICE_SHEET, 4500);

    expect(after.accruedUnpaid).toBe(45n);
    expect(after.totalAccrued).toBe(45n);
    expect(after.deliveredSeconds).toBe(4);
  });

  it("accrues per-unit: 2 units/token × 1000 tokens = 2000", () => {
    // Scenario: 2 units per token × 1000 tokens → 2000.
    const start = createMeterState();
    const after = accrueUnits(start, PRICE_SHEET, 1000);

    expect(after.accruedUnpaid).toBe(2000n);
    expect(after.totalAccrued).toBe(2000n);
    expect(after.deliveredUnits).toBe(1000);
  });

  it("sums across all three dimensions", () => {
    // Dimensions combine: 100 (1 call) + 45 (4500 ms) + 2000 (1000 units) = 2145.
    const start = createMeterState();
    const a = accrueCalls(start, PRICE_SHEET, 1);
    const b = accrueSeconds(a, PRICE_SHEET, 4500);
    const c = accrueUnits(b, PRICE_SHEET, 1000);

    expect(c.accruedUnpaid).toBe(2145n);
    expect(c.totalAccrued).toBe(2145n);
    expect(c.deliveredCalls).toBe(1);
    expect(c.deliveredSeconds).toBe(4);
    expect(c.deliveredUnits).toBe(1000);
  });

  it("treats zero in any dimension as a no-op", () => {
    const zeroSheet: PriceSheet = {
      ...PRICE_SHEET,
      perCall: 0n,
      perSecond: 0n,
      perUnit: 0n,
    };
    const start = createMeterState();
    const after = accrueCalls(
      accrueSeconds(accrueUnits(start, zeroSheet, 100), zeroSheet, 5000),
      zeroSheet,
      5,
    );

    expect(after.accruedUnpaid).toBe(0n);
    expect(after.totalAccrued).toBe(0n);
  });
});

describe("accrual arithmetic is exact", () => {
  it("produces bigint amounts", () => {
    const start = createMeterState();
    const after = accrueCalls(start, PRICE_SHEET, 1);

    expect(typeof after.accruedUnpaid).toBe("bigint");
    expect(typeof after.totalAccrued).toBe("bigint");
  });

  it("rounds half-up: 4501 ms at 10 units/sec → 45 (no half)", () => {
    const start = createMeterState();
    const after = accrueSeconds(start, PRICE_SHEET, 4501);

    // 10 × 4501 / 1000 = 45.01, rounds to 45.
    expect(after.accruedUnpaid).toBe(45n);
  });

  it("rounds half-up: 4500 ms at 1 unit/sec → 5 (half-up at 4.5)", () => {
    const sheet: PriceSheet = { ...PRICE_SHEET, perSecond: 1n };
    const start = createMeterState();
    const after = accrueSeconds(start, sheet, 4500);

    expect(after.accruedUnpaid).toBe(5n);
  });

  it("rejects fractional calls", () => {
    const start = createMeterState();
    expect(() => accrueCalls(start, PRICE_SHEET, 1.5)).toThrow(RangeError);
  });

  it("rejects fractional units", () => {
    const start = createMeterState();
    expect(() => accrueUnits(start, PRICE_SHEET, 0.5)).toThrow(RangeError);
  });
});

describe("settle", () => {
  it("reduces accruedUnpaid by the settled amount", () => {
    // Scenario: a demanded amount is settled → accrued unpaid is reduced.
    const accrued = accrueUnits(createMeterState(), PRICE_SHEET, 1000);
    const settled = settle(accrued, accrued.accruedUnpaid, FIXED_CLOCK);

    expect(settled.accruedUnpaid).toBe(0n);
    // totalAccrued survives — the stream-life total is reported untouched.
    expect(settled.totalAccrued).toBe(2000n);
    expect(settled.lastPaidAtMs).toBe(FIXED_CLOCK.now());
  });

  it("stamps lastPaidAtMs from the injected clock", () => {
    const accrued = accrueCalls(createMeterState(), PRICE_SHEET, 1);
    const settled = settle(accrued, 100n, FIXED_CLOCK);

    expect(settled.lastPaidAtMs).toBe(1_700_000_000_000);
  });

  it("rejects an amount larger than accruedUnpaid", () => {
    const accrued = accrueCalls(createMeterState(), PRICE_SHEET, 1);
    expect(() => settle(accrued, 200n, FIXED_CLOCK)).toThrow(RangeError);
  });

  it("rejects a negative amount", () => {
    const accrued = accrueCalls(createMeterState(), PRICE_SHEET, 1);
    expect(() => settle(accrued, -1n, FIXED_CLOCK)).toThrow(RangeError);
  });

  it("supports a partial settlement that is less than accrued", () => {
    const accrued = accrueCalls(createMeterState(), PRICE_SHEET, 5);
    const settled = settle(accrued, 200n, FIXED_CLOCK);

    expect(settled.accruedUnpaid).toBe(300n);
    expect(settled.totalAccrued).toBe(500n);
    expect(settled.lastPaidAtMs).toBe(FIXED_CLOCK.now());
  });
});
