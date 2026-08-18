/**
 * Tests for streams (5.1, 5.2, 5.3).
 *
 * Verified:
 *  - openStream allocates a stream id and pins a price sheet
 *  - deliverNextSegment delivers bounded work (units or seconds bound)
 *  - requesting a segment for an unknown / ended stream yields a structured error
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@neuro-pay/types";
import type { Clock } from "@neuro-pay/metering";
import {
  createStreamStore,
  deliverNextSegment,
  openStream,
} from "./streams.js";

const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;

function baseSheet() {
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
    issuedAt: new Date().toISOString(),
  };
}

describe("streams - openStream", () => {
  it("allocates a stream id and pins the price sheet", () => {
    const now: Clock["now"] = () => 1_700_000_000_000;
    const { record, response } = openStream({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
      now: () => new Date(now()).toISOString(),
      randomId: () => "stream-1",
    });
    expect(record.id).toBe("stream-1");
    expect(response.streamId).toBe("stream-1");
    expect(response.priceSheet.id).toBe("sheet-1");
    expect(record.payTo).toBe(PAY_TO);
  });

  it("creates an active record visible through createStreamStore", () => {
    const store = createStreamStore();
    const opened = store.open({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    expect(store.isActive(opened.streamId)).toBe(true);
    const record = store.get(opened.streamId);
    expect(record?.endReason).toBeNull();
  });
});

describe("streams - deliverNextSegment (bounded work)", () => {
  it("returns unknown-stream for an id never opened", () => {
    const store = createStreamStore();
    const clock: Clock = { now: () => Date.now() };
    const res = deliverNextSegment(
      {
        store,
        streamId: "does-not-exist",
        availableSeconds: 60,
        availableUnits: 1000,
      },
      clock,
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("unknown-stream");
  });

  it("delivers a segment bounded by units when units run out before seconds", () => {
    const store = createStreamStore();
    const opened = store.open({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 50,
      segmentProducer: ({ maxUnits }) => ({
        data: "x",
        secondsDelivered: 5,
        unitsDelivered: maxUnits,
      }),
    });
    const res = deliverNextSegment(
      {
        store,
        streamId: opened.streamId,
        availableSeconds: 60,
        availableUnits: 1000,
      },
      { now: () => Date.now() },
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.response.unitsDelivered).toBe(50);
    expect(res.response.sequence).toBe(1);
  });

  it("clamps a producer's over-delivery to the configured budget", () => {
    const store = createStreamStore();
    const opened = store.open({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
      // Bug-shaped producer: claims more than it was asked for.
      segmentProducer: () => ({
        data: "x",
        secondsDelivered: 999,
        unitsDelivered: 999,
      }),
    });
    const res = deliverNextSegment(
      {
        store,
        streamId: opened.streamId,
        availableSeconds: 60,
        availableUnits: 1000,
      },
      { now: () => Date.now() },
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.response.secondsDelivered).toBe(10);
    expect(res.response.unitsDelivered).toBe(10);
  });

  it("returns 'ended' when the stream has been ended", () => {
    const store = createStreamStore();
    const opened = store.open({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    store.end(opened.streamId, "session-expired");
    const res = deliverNextSegment(
      {
        store,
        streamId: opened.streamId,
        availableSeconds: 60,
        availableUnits: 1000,
      },
      { now: () => Date.now() },
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("ended");
  });

  it("end() is idempotent — a second call returns the same record unchanged", () => {
    const store = createStreamStore();
    const opened = store.open({
      priceSheet: baseSheet(),
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    const a = store.end(opened.streamId, "price-changed");
    const b = store.end(opened.streamId, "session-expired");
    expect(a?.endReason).toBe("price-changed");
    expect(b?.endReason).toBe("price-changed");
  });
});
