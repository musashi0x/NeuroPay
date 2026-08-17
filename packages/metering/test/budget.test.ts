import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import {
  computeLocalLimit,
  initializeBudget,
  preSignCheck,
  readBudgetState,
  recordPayment,
  rollBudgetWindow,
} from "../src/budget.js";
import type { Address } from "@neuro-pay/types";

/**
 * Spec scenarios covered:
 *
 * - "Buyer-side budget mirror gates signing":
 *     budget is below the on-chain cap (50 × 0.2 = 40),
 *     over-budget payment is refused before signing,
 *     budget window rolls.
 */

const TOKEN: Address = "0x0000000000000000000000000000000000000000";

/** A clock whose `now` returns the value it was constructed with. */
const clockAt = (ms: number): Clock => ({ now: () => ms });

describe("computeLocalLimit", () => {
  it("computes 40 units from a 50-unit cap at 20% margin", () => {
    // Scenario: budget is below the on-chain cap — 50 × (1 - 0.2) = 40.
    expect(computeLocalLimit(50n, 0.2)).toBe(40n);
  });

  it("computes the cap with no margin (local budget equals the cap)", () => {
    expect(computeLocalLimit(50n, 0)).toBe(50n);
  });

  it("floors the limit so it never exceeds cap × (1 - margin)", () => {
    // 99 × 0.8 = 79.2 → floored to 79. The local budget is strictly
    // ≤ the configured fraction, never above.
    expect(computeLocalLimit(99n, 0.2)).toBe(79n);
  });

  it("rejects margin outside [0, 1)", () => {
    expect(() => computeLocalLimit(50n, -0.1)).toThrow(RangeError);
    expect(() => computeLocalLimit(50n, 1)).toThrow(RangeError);
    expect(() => computeLocalLimit(50n, 1.5)).toThrow(RangeError);
  });

  it("rejects negative spendCap", () => {
    expect(() => computeLocalLimit(-1n, 0.2)).toThrow(RangeError);
  });
});

describe("initializeBudget", () => {
  it("anchors the window at the period boundary containing now", () => {
    // Period is 1 day (86_400 s). At t=1700000000000, the window starts at the
    // most recent midnight UTC and ends at the next one.
    const config = {
      spendCap: 50n,
      spendPeriodSeconds: 86_400,
      budgetMargin: 0.2,
      token: TOKEN,
      tokenDecimals: 18,
    };
    const state = initializeBudget(config, clockAt(1_700_000_000_000));

    expect(state.spent).toBe(0n);
    expect(state.localLimit).toBe(40n);
    expect(state.onChainCap).toBe(50n);
    expect(state.localRemaining).toBe(40n);
    expect(state.onChainRemaining).toBe(50n);
    expect(state.exhausted).toBe(false);
    expect(state.periodSeconds).toBe(86_400);
    // Window end is exactly one period after window start.
    expect(Date.parse(state.windowEnd) - Date.parse(state.windowStart)).toBe(
      86_400_000,
    );
  });

  it("refuses a non-positive period", () => {
    const config = {
      spendCap: 50n,
      spendPeriodSeconds: 0,
      budgetMargin: 0.2,
      token: TOKEN,
      tokenDecimals: 18,
    };
    expect(() => initializeBudget(config, clockAt(0))).toThrow(RangeError);
  });
});

describe("preSignCheck", () => {
  it("allows a payment that fits within the local budget", () => {
    // 10 of 40 used: a 10-unit payment fits, a 30-unit payment fits, a
    // 31-unit payment refuses on the local budget.
    const config = {
      spendCap: 50n,
      spendPeriodSeconds: 86_400,
      budgetMargin: 0.2,
      token: TOKEN,
      tokenDecimals: 18,
    };
    const state = {
      ...initializeBudget(config, clockAt(1_700_000_000_000)),
      spent: 10n,
      localRemaining: 30n,
      onChainRemaining: 40n,
    };

    expect(preSignCheck({ state, amount: 30n })).toEqual({ ok: true });
  });

  it("refuses a payment that would push spend past the local budget", () => {
    // Scenario: over-budget payment is refused before signing.
    // Spent=10, localLimit=40. A 31-unit payment would push to 41 > 40.
    const config = {
      spendCap: 50n,
      spendPeriodSeconds: 86_400,
      budgetMargin: 0.2,
      token: TOKEN,
      tokenDecimals: 18,
    };
    const state = {
      ...initializeBudget(config, clockAt(1_700_000_000_000)),
      spent: 10n,
      localRemaining: 30n,
      onChainRemaining: 40n,
    };

    const result = preSignCheck({ state, amount: 31n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("over-local-budget");
    }
  });

  it("classifies the on-chain-cap refusal separately from the local one", () => {
    // Construct a state where localLimit > onChainCap (a misconfigured
    // session — the local margin was negative or the cap was lowered).
    // Spent=49, localLimit=1000, onChainCap=50. A 2-unit payment passes
    // the local check but trips the on-chain backstop.
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 49n,
      localLimit: 1_000n,
      localRemaining: 951n,
      onChainCap: 50n,
      onChainRemaining: 1n,
      exhausted: false,
    };

    const result = preSignCheck({ state, amount: 2n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("over-on-chain-cap");
    }
  });

  it("rejects a negative amount", () => {
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 0n,
      localLimit: 40n,
      localRemaining: 40n,
      onChainCap: 50n,
      onChainRemaining: 50n,
      exhausted: false,
    };

    expect(() => preSignCheck({ state, amount: -1n })).toThrow(RangeError);
  });
});

describe("recordPayment", () => {
  it("increments spent and recomputes remaining figures", () => {
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 10n,
      localLimit: 40n,
      localRemaining: 30n,
      onChainCap: 50n,
      onChainRemaining: 40n,
      exhausted: false,
    };

    const after = recordPayment(state, 5n);
    expect(after.spent).toBe(15n);
    expect(after.localRemaining).toBe(25n);
    expect(after.onChainRemaining).toBe(35n);
    expect(after.exhausted).toBe(false);
  });

  it("clamps remaining to zero and marks exhausted at the limit", () => {
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 39n,
      localLimit: 40n,
      localRemaining: 1n,
      onChainCap: 50n,
      onChainRemaining: 11n,
      exhausted: false,
    };

    const after = recordPayment(state, 2n); // 41 > localLimit, but record clamps.
    expect(after.spent).toBe(41n);
    expect(after.localRemaining).toBe(0n);
    expect(after.exhausted).toBe(true);
  });
});

describe("budget window rolls", () => {
  it("keeps the same window when now is still inside it", () => {
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 25n,
      localLimit: 40n,
      localRemaining: 15n,
      onChainCap: 50n,
      onChainRemaining: 25n,
      exhausted: false,
    };

    const rolled = rollBudgetWindow(
      state,
      Date.parse("2026-01-01T12:00:00.000Z"),
    );
    expect(rolled.spent).toBe(25n);
    expect(rolled.windowStart).toBe(state.windowStart);
    expect(rolled.windowEnd).toBe(state.windowEnd);
  });

  it("resets spent when the window elapses", () => {
    // Scenario: budget window rolls.
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 40n, // would refuse in the current window
      localLimit: 40n,
      localRemaining: 0n,
      onChainCap: 50n,
      onChainRemaining: 10n,
      exhausted: true,
    };

    // Advance into the next day's window.
    const rolled = rollBudgetWindow(
      state,
      Date.parse("2026-01-02T12:00:00.000Z"),
    );

    expect(rolled.spent).toBe(0n);
    expect(rolled.localRemaining).toBe(40n);
    expect(rolled.onChainRemaining).toBe(50n);
    expect(rolled.exhausted).toBe(false);
    expect(rolled.windowStart).toBe("2026-01-02T00:00:00.000Z");
    expect(rolled.windowEnd).toBe("2026-01-03T00:00:00.000Z");
  });

  it("lets payments resume inside the fresh window after the roll", () => {
    // End-to-end: spend 40 (refuses the next), cross the boundary, the
    // first payment of the new window is allowed.
    const config = {
      spendCap: 50n,
      spendPeriodSeconds: 86_400,
      budgetMargin: 0.2,
      token: TOKEN,
      tokenDecimals: 18,
    };
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const initial = initializeBudget(config, clockAt(t0));

    // Burn the whole local budget.
    let state = initial;
    state = recordPayment(state, 40n);
    expect(state.exhausted).toBe(true);

    // The next payment refuses before the roll.
    expect(preSignCheck({ state, amount: 1n }).ok).toBe(false);

    // Cross the window boundary, read fresh state, and try again.
    const t1 = Date.parse("2026-01-02T00:00:00.500Z");
    const rolled = readBudgetState(config, clockAt(t1), state);

    expect(rolled.spent).toBe(0n);
    expect(rolled.localRemaining).toBe(40n);
    expect(preSignCheck({ state: rolled, amount: 20n })).toEqual({ ok: true });
  });

  it("is idempotent at the exact roll instant", () => {
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 10n,
      localLimit: 40n,
      localRemaining: 30n,
      onChainCap: 50n,
      onChainRemaining: 40n,
      exhausted: false,
    };

    const a = rollBudgetWindow(state, Date.parse("2026-01-02T00:00:00.000Z"));
    const b = rollBudgetWindow(a, Date.parse("2026-01-02T00:00:00.000Z"));
    expect(a).toEqual(b);
  });

  it("aligns the window to the period boundary, not to the last roll", () => {
    // Jump ahead by 2.5 periods and confirm the new window aligns to the
    // chain's window (floor(now / periodMs) * periodMs), not to the previous
    // window's end.
    const state = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-02T00:00:00.000Z",
      periodSeconds: 86_400,
      spent: 10n,
      localLimit: 40n,
      localRemaining: 30n,
      onChainCap: 50n,
      onChainRemaining: 40n,
      exhausted: false,
    };

    // 2.5 days from the original window start.
    const now = Date.parse("2026-01-03T12:00:00.000Z");
    const rolled = rollBudgetWindow(state, now);
    expect(rolled.windowStart).toBe("2026-01-03T00:00:00.000Z");
    expect(rolled.windowEnd).toBe("2026-01-04T00:00:00.000Z");
  });
});
