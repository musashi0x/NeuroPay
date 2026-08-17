import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import {
  accrueCalls,
  accrueSeconds,
  createMeterState,
  settle,
} from "../src/accrual.js";
import { evaluatePolicy } from "../src/policy.js";
import type { MeteringConfig, PriceSheet } from "@neuro-pay/types";

/**
 * Spec scenarios covered:
 *
 * - "Threshold-or-tick settlement policy":
 *     threshold fires before the tick,
 *     tick fires on a slow stream,
 *     idle stream demands nothing,
 *     accrual resets on settlement (via settle() in accrual.test.ts).
 * - "Policy is deterministic and clock-injectable":
 *     same inputs → same demand (covered by every test below).
 */

const SHEET: PriceSheet = {
  id: "t",
  version: 1,
  chainId: 97,
  token: "0x0000000000000000000000000000000000000000",
  tokenDecimals: 18,
  perCall: 100n,
  perSecond: 10n,
  perUnit: 0n,
  unitName: "token",
  issuedAt: "2026-08-17T00:00:00.000Z",
};

const CONFIG: MeteringConfig = {
  budgetMargin: 0.2,
  settlementThreshold: 1_000n,
  tickIntervalSeconds: 60,
  maxInFlightSettlements: 3,
};

/** A clock whose `now` returns the value it was constructed with. */
const clockAt = (ms: number): Clock => ({ now: () => ms });

describe("threshold-or-tick policy", () => {
  it("demands when accrued reaches the threshold", () => {
    // Scenario: threshold fires before the tick.
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 10); // 1000

    const decision = evaluatePolicy(accrued, CONFIG, clockAt(0));

    expect(decision).toEqual({ demand: 1000n, reason: "threshold" });
  });

  it("demands above the threshold", () => {
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 11); // 1100 ≥ 1000

    const decision = evaluatePolicy(accrued, CONFIG, clockAt(0));

    expect(decision).toEqual({ demand: 1100n, reason: "threshold" });
  });

  it("fires the tick when below threshold but past the tick interval", () => {
    // Scenario: tick fires on a slow stream — accrued < threshold but
    // tickIntervalSeconds × 1000 has passed since lastPaidAt.
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 5); // 500 < 1000
    // Simulate a prior settlement 61 s in the past.
    const withLastPaid = {
      ...accrued,
      lastPaidAtMs: 0,
    };

    const decision = evaluatePolicy(withLastPaid, CONFIG, clockAt(61_000));

    expect(decision).toEqual({ demand: 500n, reason: "tick" });
  });

  it("does not demand below the threshold inside the tick window", () => {
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 5); // 500 < 1000
    const withLastPaid = { ...accrued, lastPaidAtMs: 0 };

    const decision = evaluatePolicy(withLastPaid, CONFIG, clockAt(30_000));

    expect(decision).toEqual({ demand: 0n, reason: "below-threshold" });
  });

  it("does not demand on an idle stream", () => {
    // Scenario: an idle stream demands nothing.
    const state = createMeterState();
    const withLastPaid = { ...state, lastPaidAtMs: 0 };

    const decision = evaluatePolicy(withLastPaid, CONFIG, clockAt(120_000));

    expect(decision).toEqual({ demand: 0n, reason: "idle" });
  });

  it("does not demand on a fresh meter inside the tick window", () => {
    // lastPaidAtMs === null → no tick baseline yet; only the threshold fires.
    // A fresh meter has zero accrual, which the policy classifies as an
    // idle stream — "idle" precedes "below-threshold" in the decision tree
    // because idle is the cheaper check (zero-amount always) and the spec
    // distinguishes them: idle = "nothing to settle", below-threshold =
    // "something accrued but not yet at the threshold".
    const state = createMeterState();

    const decision = evaluatePolicy(state, CONFIG, clockAt(0));

    expect(decision).toEqual({ demand: 0n, reason: "idle" });
  });

  it("accrual resets on settlement: post-settle, policy demands nothing", () => {
    // Scenario: accrual resets on settlement — after settle() the new
    // accruedUnpaid is 0, so the policy demands nothing until the next
    // accrual crosses the threshold.
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 10); // 1000
    const settled = settle(accrued, 1000n, clockAt(0));

    const decision = evaluatePolicy(settled, CONFIG, clockAt(120_000));

    expect(decision).toEqual({ demand: 0n, reason: "idle" });
  });

  it("tick clock restarts after settlement", () => {
    // Scenario: accrued resets on settlement, tick clock restarts. After
    // settling at t=0, a tick should not fire at t=30 s (inside the new
    // window) but should fire at t=61 s.
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 5); // 500
    const settled = settle(accrued, 500n, clockAt(0)); // sets lastPaidAtMs=0

    // Re-accrue below threshold after settle.
    const reAccrued = accrueCalls(settled, SHEET, 3); // 300

    expect(
      evaluatePolicy(reAccrued, CONFIG, clockAt(30_000)),
    ).toEqual({ demand: 0n, reason: "below-threshold" });
    expect(
      evaluatePolicy(reAccrued, CONFIG, clockAt(61_000)),
    ).toEqual({ demand: 300n, reason: "tick" });
  });

  it("combines per-second with the threshold: 100 units/sec × 11 s = 1100", () => {
    // The 4.5-second example: 10 × 4500 ms = 45, which is below threshold
    // (1000). Bump it up to show the threshold firing on a per-second total.
    const start = createMeterState();
    const accrued = accrueSeconds(start, { ...SHEET, perSecond: 100n }, 11_000);

    const decision = evaluatePolicy(accrued, CONFIG, clockAt(0));

    expect(decision).toEqual({ demand: 1100n, reason: "threshold" });
  });
});

describe("policy determinism and clock injection", () => {
  it("same inputs produce the same demand", () => {
    // Scenario: same inputs produce the same demand.
    const start = createMeterState();
    const accrued = accrueCalls(start, SHEET, 10);

    const a = evaluatePolicy(accrued, CONFIG, clockAt(0));
    const b = evaluatePolicy(accrued, CONFIG, clockAt(0));

    expect(a).toEqual(b);
  });

  it("does not call Date.now()", () => {
    // Scenario: tests run without a network. We assert this by checking the
    // evaluation depends only on the injected clock.
    const realNow = Date.now;
    let called = false;
    Date.now = () => {
      called = true;
      return 0;
    };
    try {
      const start = createMeterState();
      const accrued = accrueCalls(start, SHEET, 10);
      evaluatePolicy(accrued, CONFIG, clockAt(0));
      expect(called).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects negative thresholds", () => {
    const start = createMeterState();
    expect(() =>
      evaluatePolicy(start, { ...CONFIG, settlementThreshold: -1n }, clockAt(0)),
    ).toThrow(RangeError);
  });
});
