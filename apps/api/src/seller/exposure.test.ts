/**
 * Tests for credit-exposure accounting (5.9).
 *
 * Verified:
 *  - tryAcquire stops accepting once `maxInFlight` slots are filled
 *  - release frees a slot so a fresh tryAcquire succeeds
 *  - the ceiling figure equals `settlementThreshold × maxInFlight`
 */

import { describe, expect, it } from "vitest";
import {
  buildExposureRefusal,
  createExposureCounter,
  exposureCeiling,
} from "./exposure.js";

describe("exposure - slot accounting", () => {
  it("opens up to maxInFlight slots then refuses", () => {
    const counter = createExposureCounter({
      maxInFlight: 3,
      settlementThreshold: 100n,
    });
    expect(counter.tryAcquire()).toBe(true);
    expect(counter.tryAcquire()).toBe(true);
    expect(counter.tryAcquire()).toBe(true);
    expect(counter.tryAcquire()).toBe(false);
    expect(counter.isAtLimit()).toBe(true);
    expect(counter.inFlightCount()).toBe(3);
  });

  it("release() frees a slot so a new tryAcquire succeeds", () => {
    const counter = createExposureCounter({
      maxInFlight: 2,
      settlementThreshold: 100n,
    });
    counter.tryAcquire();
    counter.tryAcquire();
    expect(counter.tryAcquire()).toBe(false);
    counter.release();
    expect(counter.tryAcquire()).toBe(true);
    expect(counter.inFlightCount()).toBe(2);
  });

  it("release() below zero is a no-op", () => {
    const counter = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    counter.release();
    counter.release();
    expect(counter.inFlightCount()).toBe(0);
  });

  it("exposureCeiling is threshold × maxInFlight", () => {
    expect(
      exposureCeiling({ maxInFlight: 5, settlementThreshold: 1000n }),
    ).toBe(5000n);
  });

  it("buildExposureRefusal surfaces the current inFlight and ceiling", () => {
    const counter = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    counter.tryAcquire();
    const refusal = buildExposureRefusal(counter, {
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    expect(refusal.kind).toBe("refusal");
    expect(refusal.reason).toBe("exposure-limit-reached");
    expect(refusal.inFlight).toBe(1);
    expect(refusal.ceiling).toBe(1);
    expect(refusal.exposureCeiling).toBe(100n);
  });
});
