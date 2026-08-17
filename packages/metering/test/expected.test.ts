import { describe, expect, it } from "vitest";
import {
  compareToExpected,
  computeExpectedCost,
} from "../src/expected.js";
import type { PriceSheet } from "@neuro-pay/types";

/**
 * Spec scenarios covered:
 *
 * - "Buyer independently verifies the demanded amount":
 *     overcharge is refused (demanded exceeds expectation beyond tolerance),
 *     small differences within tolerance are paid,
 *     disagreement is recorded in the refusal.
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

describe("computeExpectedCost", () => {
  it("sums per-call, per-second, and per-unit against observed counts", () => {
    // 1 call (100) + 4 s (40) + 1000 units (2000) = 2140.
    const expected = computeExpectedCost(PRICE_SHEET, {
      calls: 1,
      seconds: 4,
      units: 1000,
    });
    expect(expected).toBe(2140n);
  });

  it("returns zero when no consumption has been observed", () => {
    expect(
      computeExpectedCost(PRICE_SHEET, { calls: 0, seconds: 0, units: 0 }),
    ).toBe(0n);
  });

  it("ignores dimensions whose price is zero", () => {
    const sheet: PriceSheet = { ...PRICE_SHEET, perCall: 0n, perSecond: 0n };
    expect(
      computeExpectedCost(sheet, { calls: 5, seconds: 100, units: 1000 }),
    ).toBe(2000n);
  });

  it("rejects fractional counts at the boundary", () => {
    expect(() =>
      computeExpectedCost(PRICE_SHEET, { calls: 1.5, seconds: 0, units: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      computeExpectedCost(PRICE_SHEET, { calls: 0, seconds: -1, units: 0 }),
    ).toThrow(RangeError);
  });

  it("rejects a price sheet with a negative price component", () => {
    const sheet: PriceSheet = { ...PRICE_SHEET, perCall: -1n };
    expect(() =>
      computeExpectedCost(sheet, { calls: 1, seconds: 0, units: 0 }),
    ).toThrow(RangeError);
  });
});

describe("compareToExpected", () => {
  it("refuses an overcharge above the tolerance and records the disagreement", () => {
    // Scenario: overcharge is refused.
    // Expected = 1000, demanded = 1100, tolerance = 5%. Allowance = floor(1000 × 0.05) = 50.
    // difference = 100 > 50 → refuse.
    const result = compareToExpected(1_000n, 1_100n, 0.05);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("over-tolerance");
      expect(result.demanded).toBe(1_100n);
      expect(result.expected).toBe(1_000n);
      expect(result.difference).toBe(100n);
    }
  });

  it("refuses the smallest possible overcharge against a zero tolerance", () => {
    // Tolerance of 0 means any demanded amount above expectation refuses.
    const result = compareToExpected(1_000n, 1_001n, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("over-tolerance");
      expect(result.difference).toBe(1n);
    }
  });

  it("signs a demand within the tolerance, recording the difference", () => {
    // Scenario: small differences within tolerance are paid.
    // Expected = 1000, demanded = 1020, tolerance = 5%. Allowance = 50.
    // difference = 20 ≤ 50 → pay.
    const result = compareToExpected(1_000n, 1_020n, 0.05);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.difference).toBe(20n);
    }
  });

  it("signs exactly at the tolerance bound (allowance is inclusive)", () => {
    // Expected = 1000, tolerance = 5% → allowance = 50. Demanded 1050 is
    // equal to the allowance, not strictly above, so it pays.
    const result = compareToExpected(1_000n, 1_050n, 0.05);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.difference).toBe(50n);
    }
  });

  it("signs an exact match (demanded equals expected)", () => {
    const result = compareToExpected(1_000n, 1_000n, 0.05);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.difference).toBe(0n);
    }
  });

  it("signs an under-demand (seller charges less than expected)", () => {
    // Refusing to sign against an under-demand punishes the buyer for the
    // seller's generosity — under-demanding is the seller's problem.
    const result = compareToExpected(1_000n, 800n, 0.05);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // difference is expected - demanded, the amount the seller left on the table.
      expect(result.difference).toBe(200n);
    }
  });

  it("floors the allowance so a fractional expected × tolerance refuses the unit above", () => {
    // Expected = 99, tolerance = 20%. Allowance = floor(99 × 0.2) = 19.
    // Demanded 119 → difference 20 > 19 → refuse. This proves the allowance
    // is exact (floored) rather than a float-derived ceiling.
    const result = compareToExpected(99n, 119n, 0.2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.difference).toBe(20n);
      expect(result.demanded).toBe(119n);
      expect(result.expected).toBe(99n);
    }
  });

  it("rejects tolerances outside [0, 1)", () => {
    expect(() => compareToExpected(100n, 100n, -0.1)).toThrow(RangeError);
    expect(() => compareToExpected(100n, 100n, 1)).toThrow(RangeError);
    expect(() => compareToExpected(100n, 100n, 1.5)).toThrow(RangeError);
  });

  it("rejects negative inputs", () => {
    expect(() => compareToExpected(-1n, 100n, 0.05)).toThrow(RangeError);
    expect(() => compareToExpected(100n, -1n, 0.05)).toThrow(RangeError);
  });
});