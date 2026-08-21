/**
 * Tests for the spend-limit decimal derivation.
 *
 * The spec scenario is verbatim: "a policy of 50 USDC per day is
 * configured on a chain where the token has 18 decimals" — the
 * granted `spend[0].limit` SHALL be `50n * 10n ** 18n` and SHALL NOT
 * be `50_000_000n`. That assertion is the single most important
 * guard in the package: a wrong-decimals cap is ~10^12 too small on
 * an 18-decimal chain and every payment reverts against a limit
 * that reads as generous.
 */

import { describe, expect, it } from "vitest";
import { loadAppConfig } from "./config/config.js";
import type { EnvSource } from "./config/env.js";
import { deriveSpendLimit, SpendLimitError } from "./spend.js";

describe("deriveSpendLimit — spec scenario", () => {
  it("50 USDC × 18 decimals equals 50n * 10n**18n", () => {
    expect(deriveSpendLimit(50n, 18)).toBe(50n * 10n ** 18n);
  });

  it("a 50 USDC cap on an 18-decimal chain is NOT 50_000_000n", () => {
    // The classic wrong-decimals bug: a 6-decimal-style multiplier on
    // an 18-decimal token. A passing test here is the spec's
    // explicit anti-pattern.
    const limit = deriveSpendLimit(50n, 18);
    expect(limit).not.toBe(50_000_000n);
    // And the magnitude is orders of magnitude larger: 50 * 10^18 = 5 * 10^19.
    expect(limit).toBe(50_000_000_000_000_000_000n);
  });

  it("a 50 USDC cap on a 6-decimal chain is exactly 50_000_000n", () => {
    expect(deriveSpendLimit(50n, 6)).toBe(50_000_000n);
  });
});

describe("deriveSpendLimit — wholeToken × decimals correctness", () => {
  it("1 token × 0 decimals = 1n", () => {
    expect(deriveSpendLimit(1n, 0)).toBe(1n);
  });

  it("1 token × 18 decimals = 10n**18n", () => {
    expect(deriveSpendLimit(1n, 18)).toBe(10n ** 18n);
  });

  it("0 tokens × any decimals = 0n (a no-spend policy is allowed)", () => {
    expect(deriveSpendLimit(0n, 18)).toBe(0n);
    expect(deriveSpendLimit(0n, 6)).toBe(0n);
    expect(deriveSpendLimit(0n, 0)).toBe(0n);
  });

  it("scales linearly with the wholeToken count", () => {
    const one = deriveSpendLimit(1n, 18);
    const hundred = deriveSpendLimit(100n, 18);
    expect(hundred).toBe(one * 100n);
  });

  it("preserves a wholeToken count that exceeds Number.MAX_SAFE_INTEGER", () => {
    // A wholeToken count up to 2^53 is comfortably representable,
    // but the multiplication must not route through `number`.
    const huge = 1_000_000_000_000n;
    const limit = deriveSpendLimit(huge, 18);
    expect(typeof limit).toBe("bigint");
    expect(limit).toBe(huge * 10n ** 18n);
  });

  it("supports the highest decimal count (36) without overflow", () => {
    expect(deriveSpendLimit(1n, 36)).toBe(10n ** 36n);
  });
});

describe("deriveSpendLimit — input validation", () => {
  it("rejects a negative wholeToken value", () => {
    expect(() => deriveSpendLimit(-1n, 18)).toThrowError(SpendLimitError);
  });

  it("rejects a non-integer decimal count", () => {
    expect(() => deriveSpendLimit(1n, 18.5)).toThrowError(SpendLimitError);
  });

  it("rejects a decimal count below 0", () => {
    expect(() => deriveSpendLimit(1n, -1)).toThrowError(SpendLimitError);
  });

  it("rejects a decimal count above 36", () => {
    expect(() => deriveSpendLimit(1n, 37)).toThrowError(SpendLimitError);
  });

  it("accepts the boundary decimal counts 0 and 36", () => {
    expect(deriveSpendLimit(1n, 0)).toBe(1n);
    expect(deriveSpendLimit(1n, 36)).toBe(10n ** 36n);
  });
});

describe("loadAppConfig.spendCap ↔ grant boundary (no double-multiply)", () => {
  // After the conversion landed at the config layer, the production path
  // (loadAppConfig → grantSession) must hand the smallest-unit value
  // straight to the SDK. If anyone re-introduces `deriveSpendLimit` at the
  // grant boundary, the cap doubles by 10^decimals and silently becomes a
  // policy hole.
  const env18: EnvSource = {
    RPC_URL: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    TOKEN_ADDRESS: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    TOKEN_SYMBOL: "npUSD",
    TOKEN_DECIMALS: "18",
    PAY_TO: "0x000000000000000000000000000000000000dEaD",
    SETTLER_PRIVATE_KEY:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    SESSION_SPEND_CAP: "50",
    SETTLEMENT_THRESHOLD: "50000000000000000",
  };
  const env6: EnvSource = { ...env18, TOKEN_DECIMALS: "6" };

  it("50 USDC × 18 decimals from config lands as 50n * 10n**18n", () => {
    expect(loadAppConfig(env18).session.spendCap).toBe(50n * 10n ** 18n);
  });

  it("50 USDC × 6 decimals from config lands as 50_000_000n (no double-multiply at boundary)", () => {
    expect(loadAppConfig(env6).session.spendCap).toBe(50_000_000n);
  });
});
