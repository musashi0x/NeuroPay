import { describe, expect, it } from "vitest";
import { formatAmount } from "../src/lib/format-amount";

describe("formatAmount", () => {
  it("renders 18-decimal amounts without using floating point", () => {
    const formatted = formatAmount(50n * 10n ** 18n, 18, "USDT");
    expect(formatted.human).toBe("50.000000000000000000");
    expect(formatted.raw).toBe("50000000000000000000");
    expect(formatted.labelled).toBe("50 USDT");
  });

  it("renders 6-decimal amounts without a 18-decimal literal", () => {
    const formatted = formatAmount(50_000_000n, 6, "USDC");
    expect(formatted.human).toBe("50.000000");
    expect(formatted.labelled).toBe("50 USDC");
  });

  it("preserves amounts larger than Number.MAX_SAFE_INTEGER", () => {
    const amount = 50n * 10n ** 18n + 1n;
    const formatted = formatAmount(amount, 18);
    expect(formatted.raw).toBe(amount.toString(10));
    expect(formatted.human.endsWith("000000000000000001")).toBe(true);
  });

  it("rejects a non-integer decimals value", () => {
    expect(() => formatAmount(1n, 1.5)).toThrow(RangeError);
  });
});
