/**
 * Tests for the pre-sign policy.
 *
 * The contract: every refusal fires before any signature is produced, and
 * each refusal carries a distinct classification:
 *  - session-expired (cheapest, runs first)
 *  - session-unprovisioned (rail not provisioned)
 *  - budget-exhausted (over local or on-chain cap)
 *  - overcharge-beyond-tolerance (demanded > expected + tolerance)
 *
 * The order is the spec's order; the cheapest checks run first.
 */
import { describe, expect, it } from "vitest";
import { policyCheck } from "./policy.js";
import { PaymentFailureError } from "./errors.js";
import {
  EXHAUSTED_BUDGET,
  HEALTHY_BUDGET,
  PERMIT2_REQUIREMENT,
  PERMITTED_TOKEN,
  WALLET_ADDRESS,
  makeSession,
} from "./__fixtures__/index.js";

const baseInput = {
  requirement: PERMIT2_REQUIREMENT,
  payment: {
    session: makeSession(),
    walletAddress: WALLET_ADDRESS,
    chainId: 56,
    permittedTokens: new Set([PERMITTED_TOKEN]),
    budget: HEALTHY_BUDGET,
    tolerance: 0,
    railProvisioned: true,
    expiresAt: 1_700_000_000,
  },
  demanded: PERMIT2_REQUIREMENT.maxAmountRequired,
};

describe("policyCheck — happy path", () => {
  it("returns void when every check passes", () => {
    const result = policyCheck({
      ...baseInput,
      payment: { ...baseInput.payment, now: () => 1_600_000_000 },
    });
    expect(result).toBeUndefined();
  });

  it("skips the over-tolerance check when expected is absent", () => {
    // Even with a demanded figure wildly different from a hypothetical
    // expected, the absence of `expected` skips the check.
    const result = policyCheck({
      ...baseInput,
      demanded: 999_999_999n,
      payment: { ...baseInput.payment, now: () => 1_600_000_000 },
    });
    expect(result).toBeUndefined();
  });
});

describe("policyCheck — session expired", () => {
  it("refuses before signing when now >= expiresAt", () => {
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: { ...baseInput.payment, now: () => 1_700_000_000 },
      }),
    ).toThrowError(PaymentFailureError);

    try {
      policyCheck({
        ...baseInput,
        payment: { ...baseInput.payment, now: () => 1_700_000_000 },
      });
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe("session-expired");
    }
  });

  it("refuses when now is past expiresAt", () => {
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: { ...baseInput.payment, now: () => 1_700_000_001 },
      }),
    ).toThrowError(/session expired/);
  });
});

describe("policyCheck — rail unprovisioned", () => {
  it("refuses with session-unprovisioned when railProvisioned is false", () => {
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          railProvisioned: false,
          now: () => 1_600_000_000,
        },
      }),
    ).toThrowError(PaymentFailureError);

    try {
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          railProvisioned: false,
          now: () => 1_600_000_000,
        },
      });
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe(
        "session-unprovisioned",
      );
    }
  });
});

describe("policyCheck — budget exhaustion", () => {
  it("refuses with budget-exhausted when the local budget is gone", () => {
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          budget: EXHAUSTED_BUDGET,
          now: () => 1_600_000_000,
        },
      }),
    ).toThrowError(PaymentFailureError);

    try {
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          budget: EXHAUSTED_BUDGET,
          now: () => 1_600_000_000,
        },
      });
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe("budget-exhausted");
    }
  });

  it("refuses before the signature is produced", () => {
    // The check must NOT throw an SDK signing error and must NOT
    // produce a signed payload. The fact that it throws a
    // `PaymentFailureError` (not anything from the SDK) is the
    // "no signature under any refusal" assertion.
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          budget: EXHAUSTED_BUDGET,
          now: () => 1_600_000_000,
        },
      }),
    ).toThrowError(PaymentFailureError);
  });
});

describe("policyCheck — overcharge-beyond-tolerance", () => {
  it("refuses when the demand exceeds expected by more than tolerance", () => {
    expect(() =>
      policyCheck({
        ...baseInput,
        expected: 1_000_000n,
        tolerance: 0.05,
        demanded: 1_100_000n, // 10% over, > 5% tolerance
        payment: { ...baseInput.payment, now: () => 1_600_000_000 },
      }),
    ).toThrowError(PaymentFailureError);

    try {
      policyCheck({
        ...baseInput,
        expected: 1_000_000n,
        tolerance: 0.05,
        demanded: 1_100_000n,
        payment: { ...baseInput.payment, now: () => 1_600_000_000 },
      });
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe(
        "overcharge-beyond-tolerance",
      );
    }
  });

  it("admits a demand within tolerance", () => {
    const result = policyCheck({
      ...baseInput,
      expected: 1_000_000n,
      tolerance: 0.05,
      demanded: 1_040_000n, // 4% over, <= 5% tolerance
      payment: { ...baseInput.payment, now: () => 1_600_000_000 },
    });
    expect(result).toBeUndefined();
  });

  it("admits an equal demanded and expected", () => {
    const result = policyCheck({
      ...baseInput,
      expected: 1_000_000n,
      tolerance: 0.05,
      demanded: 1_000_000n,
      payment: { ...baseInput.payment, now: () => 1_600_000_000 },
    });
    expect(result).toBeUndefined();
  });
});

describe("policyCheck — ordering", () => {
  it("session-expired runs before budget exhaustion", () => {
    // Both should fire, but session-expired is checked first.
    expect(() =>
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          budget: EXHAUSTED_BUDGET,
          now: () => 1_700_000_000,
        },
      }),
    ).toThrowError(PaymentFailureError);

    try {
      policyCheck({
        ...baseInput,
        payment: {
          ...baseInput.payment,
          budget: EXHAUSTED_BUDGET,
          now: () => 1_700_000_000,
        },
      });
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe("session-expired");
    }
  });
});
