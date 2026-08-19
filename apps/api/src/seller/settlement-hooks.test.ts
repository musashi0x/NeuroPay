/**
 * Tests for settlement accounting hooks (P0 TODO 5–7).
 *
 * Confirmed settlements credit the stream meter (capped at accruedUnpaid)
 * and release the exposure slot. Failed / lost settlements leave the
 * slot held as unrecovered exposure.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@neuro-pay/types";
import type { Clock } from "@neuro-pay/metering";
import { createExposureCounter } from "./exposure.js";
import { createStreamStore } from "./streams.js";
import {
  onSettlementConfirmed,
  onSettlementFailed,
  onSettlementLost,
} from "./settlement-hooks.js";

const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const clock: Clock = { now: () => 1_700_000_000_000 };

function sheet() {
  return {
    id: "sheet-1",
    version: 1,
    chainId: 97,
    token: TOKEN,
    tokenDecimals: 18,
    perCall: 100n,
    perSecond: 10n,
    perUnit: 1n,
    unitName: "token",
    issuedAt: new Date(clock.now()).toISOString(),
  };
}

describe("onSettlementConfirmed", () => {
  it("credits the meter by the settled amount and releases exposure", () => {
    const streams = createStreamStore();
    const opened = streams.open({
      priceSheet: sheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    // 1 call + 10s + 10u = 100 + 100 + 10 = 210
    streams.recordDelivery(
      opened.streamId,
      { secondsDelivered: 10, unitsDelivered: 10 },
      clock,
    );
    const before = streams.get(opened.streamId)!.meter;
    expect(before.accruedUnpaid).toBe(210n);
    expect(before.totalAccrued).toBe(210n);

    const exposure = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    expect(exposure.tryAcquire()).toBe(true);

    onSettlementConfirmed({
      streams,
      exposure,
      clock,
      streamId: opened.streamId,
      nonce: "ok-1",
      amount: 100n,
    });

    const after = streams.get(opened.streamId)!.meter;
    expect(after.accruedUnpaid).toBe(110n);
    expect(after.totalAccrued).toBe(210n);
    expect(exposure.inFlightCount()).toBe(0);
  });

  it("caps the credit at accruedUnpaid so an over-authorized envelope does not throw", () => {
    const streams = createStreamStore();
    const opened = streams.open({
      priceSheet: sheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    streams.recordDelivery(
      opened.streamId,
      { secondsDelivered: 10, unitsDelivered: 10 },
      clock,
    );
    const exposure = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    exposure.tryAcquire();

    onSettlementConfirmed({
      streams,
      exposure,
      clock,
      streamId: opened.streamId,
      nonce: "overpay-1",
      amount: 10_000n,
    });

    const after = streams.get(opened.streamId)!.meter;
    expect(after.accruedUnpaid).toBe(0n);
    expect(after.totalAccrued).toBe(210n);
    expect(exposure.inFlightCount()).toBe(0);
  });

  it("still releases exposure when the stream has already ended", () => {
    const streams = createStreamStore();
    const opened = streams.open({
      priceSheet: sheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    streams.recordDelivery(
      opened.streamId,
      { secondsDelivered: 10, unitsDelivered: 10 },
      clock,
    );
    streams.end(opened.streamId, "completed");
    const exposure = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    exposure.tryAcquire();

    onSettlementConfirmed({
      streams,
      exposure,
      clock,
      streamId: opened.streamId,
      nonce: "ended-1",
      amount: 210n,
    });

    expect(streams.get(opened.streamId)!.meter.accruedUnpaid).toBe(210n);
    expect(exposure.inFlightCount()).toBe(0);
  });
});

describe("onSettlementFailed / onSettlementLost", () => {
  it("does not release the exposure slot on failure", () => {
    const exposure = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    expect(exposure.tryAcquire()).toBe(true);
    onSettlementFailed({
      nonce: "fail-1",
      classification: "settlement-reverted",
      detail: "simulated revert",
    });
    expect(exposure.inFlightCount()).toBe(1);
    expect(exposure.tryAcquire()).toBe(false);
  });

  it("does not release the exposure slot on lost (timeout)", () => {
    const exposure = createExposureCounter({
      maxInFlight: 1,
      settlementThreshold: 100n,
    });
    expect(exposure.tryAcquire()).toBe(true);
    onSettlementLost({ nonce: "lost-1" });
    expect(exposure.inFlightCount()).toBe(1);
  });
});
