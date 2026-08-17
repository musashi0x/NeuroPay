import { describe, expect, it } from "vitest";
import {
  divideRoundHalfUp,
  fractionToBasisPoints,
  applyBasisPoints,
  requireNonNegativeAmount,
  requireNonNegativeCount,
} from "../src/arithmetic.js";

describe("divideRoundHalfUp", () => {
  it("rounds half up at exact halves", () => {
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divideRoundHalfUp(7n, 2n)).toBe(4n);
  });

  it("rounds down below half", () => {
    expect(divideRoundHalfUp(9n, 10n)).toBe(1n);
    expect(divideRoundHalfUp(1n, 3n)).toBe(0n);
  });

  it("handles large bigints without precision loss", () => {
    // 4501 ms at 10 units/sec: 10 × 4501 / 1000 = 45.01 → 45 (round down — not half)
    expect(divideRoundHalfUp(10n * 4501n, 1000n)).toBe(45n);
    // 4500 ms at 10 units/sec: 10 × 4500 / 1000 = 45 exact
    expect(divideRoundHalfUp(10n * 4500n, 1000n)).toBe(45n);
    // 4501 ms at 1 unit/sec: 4501/1000 = 4.501 → 5 (round up)
    expect(divideRoundHalfUp(4501n, 1000n)).toBe(5n);
    // 7 units × 500 ms / 1000 = 3.5 → 4 (half up)
    expect(divideRoundHalfUp(7n * 500n, 1000n)).toBe(4n);
  });

  it("rejects negative numerator", () => {
    expect(() => divideRoundHalfUp(-1n, 2n)).toThrow(RangeError);
  });

  it("rejects non-positive denominator", () => {
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divideRoundHalfUp(1n, -2n)).toThrow(RangeError);
  });
});

describe("fractionToBasisPoints", () => {
  it("converts whole fractions exactly", () => {
    expect(fractionToBasisPoints(0)).toBe(0n);
    expect(fractionToBasisPoints(1)).toBe(10_000n);
    expect(fractionToBasisPoints(0.2)).toBe(2_000n);
    expect(fractionToBasisPoints(0.05)).toBe(500n);
  });

  it("truncates beyond four decimals", () => {
    expect(fractionToBasisPoints(0.20005)).toBe(2_000n);
  });

  it("rejects out-of-range fractions", () => {
    expect(() => fractionToBasisPoints(-0.1)).toThrow(RangeError);
    expect(() => fractionToBasisPoints(1.1)).toThrow(RangeError);
    expect(() => fractionToBasisPoints(Number.NaN)).toThrow(RangeError);
  });
});

describe("applyBasisPoints", () => {
  it("floors toward zero", () => {
    // 100 × 20% = 20
    expect(applyBasisPoints(100n, 2_000n)).toBe(20n);
    // 101 × 20% = 20.2 → 20 (floored)
    expect(applyBasisPoints(101n, 2_000n)).toBe(20n);
  });

  it("returns zero for zero basis points", () => {
    expect(applyBasisPoints(1_000n, 0n)).toBe(0n);
  });

  it("rejects negative inputs", () => {
    expect(() => applyBasisPoints(-1n, 100n)).toThrow(TypeError);
    expect(() => applyBasisPoints(100n, -1n)).toThrow(RangeError);
  });
});

describe("requireNonNegativeAmount", () => {
  it("passes for valid bigints", () => {
    expect(() => requireNonNegativeAmount(0n, "x")).not.toThrow();
    expect(() => requireNonNegativeAmount(42n, "x")).not.toThrow();
  });

  it("rejects non-bigints and negatives", () => {
    expect(() => requireNonNegativeAmount(0 as unknown as bigint, "x")).toThrow(TypeError);
    expect(() => requireNonNegativeAmount(-1n, "x")).toThrow(RangeError);
  });
});

describe("requireNonNegativeCount", () => {
  it("passes for safe integers", () => {
    expect(() => requireNonNegativeCount(0, "x")).not.toThrow();
    expect(() => requireNonNegativeCount(100, "x")).not.toThrow();
  });

  it("rejects fractions and negatives", () => {
    expect(() => requireNonNegativeCount(1.5, "x")).toThrow(RangeError);
    expect(() => requireNonNegativeCount(-1, "x")).toThrow(RangeError);
    expect(() => requireNonNegativeCount(Number.NaN, "x")).toThrow(RangeError);
  });
});
