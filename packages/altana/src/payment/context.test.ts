/**
 * Tests for the payment client context builder.
 *
 * The contract: a single builder call produces the canonical
 * PaymentClientContext shape, defaults are applied where the caller
 * doesn't supply them, and the resulting context is what the other
 * modules (select, policy, sign) consume.
 */
import { describe, expect, it } from "vitest";
import { buildPaymentContext } from "./context.js";
import {
  HEALTHY_BUDGET,
  PERMITTED_TOKEN,
  WALLET_ADDRESS,
  makeSession,
} from "./__fixtures__/index.js";

describe("buildPaymentContext", () => {
  it("builds a context with all fields supplied", () => {
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      tolerance: 0.05,
      railProvisioned: true,
      expiresAt: 1_700_000_000,
    });

    expect(ctx.session).toBeDefined();
    expect(ctx.walletAddress).toBe(WALLET_ADDRESS);
    expect(ctx.chainId).toBe(56);
    expect(ctx.permittedTokens).toBeInstanceOf(Set);
    expect(ctx.permittedTokens.has(PERMITTED_TOKEN)).toBe(true);
    expect(ctx.budget).toBe(HEALTHY_BUDGET);
    expect(ctx.tolerance).toBe(0.05);
    expect(ctx.railProvisioned).toBe(true);
    expect(ctx.expiresAt).toBe(1_700_000_000);
  });

  it("defaults tolerance to 0 when not supplied", () => {
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      railProvisioned: true,
      expiresAt: 1_700_000_000,
    });
    expect(ctx.tolerance).toBe(0);
  });

  it("defaults now to undefined so the policy uses wall clock", () => {
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      railProvisioned: true,
      expiresAt: 1_700_000_000,
    });
    expect(ctx.now).toBeUndefined();
  });

  it("respects injected now for testability", () => {
    const fixedNow = () => 1_600_000_000;
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      railProvisioned: true,
      expiresAt: 1_700_000_000,
      now: fixedNow,
    });
    expect(ctx.now).toBe(fixedNow);
    expect(ctx.now?.()).toBe(1_600_000_000);
  });

  it("converts permittedTokens array to a Set (deduplicates)", () => {
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN, PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      railProvisioned: true,
      expiresAt: 1_700_000_000,
    });
    // ReadonlySet — can't add, but can read.
    expect(ctx.permittedTokens.size).toBe(1);
    expect(ctx.permittedTokens.has(PERMITTED_TOKEN)).toBe(true);
  });

  it("records railProvisioned=false verbatim", () => {
    const ctx = buildPaymentContext({
      session: makeSession(),
      walletAddress: WALLET_ADDRESS,
      chainId: 56,
      permittedTokens: [PERMITTED_TOKEN],
      budget: HEALTHY_BUDGET,
      railProvisioned: false,
      expiresAt: 1_700_000_000,
    });
    expect(ctx.railProvisioned).toBe(false);
  });
});
