/**
 * Tests for the failure-classification module.
 *
 * The module's contract: every failure has one of a closed set of
 * categories, the EOA-only-facilitator case is textually
 * distinguishable, and the type guards are sound.
 */
import { describe, expect, it } from "vitest";
import {
  PaymentFailureError,
  isBuyerPaymentFailure,
  isPaymentClientClassification,
  looksLikeEoaOnlyFacilitator,
} from "./errors.js";
import type { BuyerPaymentFailure } from "./errors.js";

describe("PaymentFailureError", () => {
  it("carries the classification as a public field", () => {
    const err = new PaymentFailureError(
      "no-payable-option",
      "merchant did not offer anything",
    );
    expect(err.classification).toBe("no-payable-option");
    expect(err.name).toBe("PaymentFailureError");
    expect(err).toBeInstanceOf(Error);
    expect(err.detail).toEqual({});
  });

  it("preserves structured detail and cause when supplied", () => {
    const cause = new Error("upstream");
    const err = new PaymentFailureError(
      "budget-exhausted",
      "over budget",
      { detail: { demanded: 100n }, cause },
    );
    expect(err.detail).toEqual({ demanded: 100n });
    expect(err.cause).toBe(cause);
  });

  it("leaves cause undefined when none supplied", () => {
    const err = new PaymentFailureError("session-expired", "expired");
    expect(err.cause).toBeUndefined();
  });

  it("each failure category is a PaymentFailureError instance", () => {
    const categories: BuyerPaymentFailure[] = [
      "no-payable-option",
      "wrong-chain-only",
      "unpermitted-token",
      "budget-exhausted",
      "overcharge-beyond-tolerance",
      "session-expired",
      "session-revoked",
      "session-unprovisioned",
      "stream-would-outlive-session",
      "eoa-only-facilitator",
      "verification-failed",
    ];
    for (const classification of categories) {
      const err = new PaymentFailureError(classification, `dummy ${classification}`);
      expect(err.classification).toBe(classification);
    }
  });
});

describe("isBuyerPaymentFailure — type guard", () => {
  it("returns true for every buyer-side classification", () => {
    const samples: BuyerPaymentFailure[] = [
      "no-payable-option",
      "wrong-chain-only",
      "unpermitted-token",
      "budget-exhausted",
      "overcharge-beyond-tolerance",
      "session-expired",
      "session-revoked",
      "session-unprovisioned",
      "stream-would-outlive-session",
      "eoa-only-facilitator",
      "verification-failed",
    ];
    for (const s of samples) {
      expect(isBuyerPaymentFailure(s)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isBuyerPaymentFailure("not-a-real-classification")).toBe(false);
    expect(isBuyerPaymentFailure("")).toBe(false);
  });

  it("isPaymentClientClassification is the same set", () => {
    expect(isPaymentClientClassification("eoa-only-facilitator")).toBe(true);
    expect(isPaymentClientClassification("not-a-class")).toBe(false);
  });

  it("specifically rejects seller-side-only categories", () => {
    // These are seller's classifications, never raised by the client.
    expect(isBuyerPaymentFailure("amount-underpaid" as never)).toBe(false);
    expect(isBuyerPaymentFailure("recipient-mismatch" as never)).toBe(false);
    expect(isBuyerPaymentFailure("settlement-reverted" as never)).toBe(false);
  });
});

describe("looksLikeEoaOnlyFacilitator", () => {
  it("matches the canonical ecrecover-based-error styles", () => {
    expect(looksLikeEoaOnlyFacilitator("ecrecover failed: invalid signature")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("invalid signature length")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("signature length is 65, got 98")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("expected 65-byte signature")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("expected 65 byte signature")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("recovered address is 0x0000...")).toBe(true);
    expect(looksLikeEoaOnlyFacilitator("signer recovered to zero address")).toBe(true);
  });

  it("matches across an Error instance", () => {
    const err = new Error("ecrecover returned 0x0 address");
    expect(looksLikeEoaOnlyFacilitator(err)).toBe(true);
  });

  it("does not match a normal verification failure", () => {
    expect(looksLikeEoaOnlyFacilitator("signature does not match")).toBe(false);
    expect(looksLikeEoaOnlyFacilitator("payment rejected")).toBe(false);
  });

  it("returns false for empty / non-string inputs", () => {
    expect(looksLikeEoaOnlyFacilitator("")).toBe(false);
    expect(looksLikeEoaOnlyFacilitator(undefined)).toBe(false);
    expect(looksLikeEoaOnlyFacilitator(null)).toBe(false);
    expect(looksLikeEoaOnlyFacilitator(42)).toBe(false);
  });
});
