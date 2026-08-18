/**
 * Tests for 402 generation (5.4).
 *
 * Verified:
 *  - `accepts[]` is exactly one entry
 *  - carries chain, rail, token, amount, payTo
 *  - non-null resource
 *  - `maxTimeoutSeconds <= 480`
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@neuro-pay/types";
import {
  assertRequirementsInputs,
  buildPaymentRequired,
  buildSegmentResource,
  defaultNetworkFor,
  descriptionForPriceSheet,
  stringifyPaymentRequired,
} from "./requirements.js";
import type { PriceSheet } from "@neuro-pay/types";

const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const RESOURCE = "https://api.example/v1/streams/abc/next";

function baseInput() {
  return {
    amount: 12345n,
    chainId: 97,
    resource: RESOURCE,
    token: TOKEN,
    tokenDecimals: 18,
    payTo: PAY_TO,
    description: "token usage on stream",
  };
}

describe("requirements - 402 generation shape", () => {
  it("accepts[] has exactly one entry with chain, rail, token, amount, payTo", () => {
    const body = buildPaymentRequired(baseInput());
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    const r = body.accepts[0]!;
    expect(r.chainId).toBe(97);
    expect(r.rail).toBe("permit2");
    expect(r.asset).toBe(TOKEN);
    expect(r.payTo).toBe(PAY_TO);
    expect(r.maxAmountRequired).toBe(12345n);
    expect(r.scheme).toBe("exact");
  });

  it("every accepts[] entry carries a non-null resource", () => {
    const body = buildPaymentRequired(baseInput());
    for (const r of body.accepts) {
      expect(r.resource).toBeTruthy();
      expect(r.resource).toMatch(/^https?:\/\//);
    }
  });

  it("maxTimeoutSeconds is at most 480", () => {
    const body = buildPaymentRequired(baseInput());
    for (const r of body.accepts) {
      expect(r.maxTimeoutSeconds).toBeGreaterThan(0);
      expect(r.maxTimeoutSeconds).toBeLessThanOrEqual(480);
    }
  });

  it("network defaults to bsc-testnet on chain 97 and bsc on chain 56", () => {
    const body97 = buildPaymentRequired({ ...baseInput(), chainId: 97 });
    const body56 = buildPaymentRequired({ ...baseInput(), chainId: 56 });
    expect(body97.accepts[0]!.network).toBe("bsc-testnet");
    expect(body56.accepts[0]!.network).toBe("bsc");
  });

  it("buildSegmentResource returns the requestUrl verbatim", () => {
    expect(
      buildSegmentResource({ requestUrl: RESOURCE, streamId: "abc" }),
    ).toBe(RESOURCE);
  });

  it("descriptionForPriceSheet reads the unit name", () => {
    const sheet = {
      id: "p1",
      version: 1,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      perCall: 0n,
      perSecond: 0n,
      perUnit: 0n,
      unitName: "watt",
      issuedAt: new Date().toISOString(),
    } satisfies PriceSheet;
    expect(descriptionForPriceSheet(sheet)).toBe("watt usage on stream");
  });

  it("assertRequirementsInputs rejects a malformed resource", () => {
    expect(() =>
      assertRequirementsInputs({ ...baseInput(), resource: "not-a-url" }),
    ).toThrow(TypeError);
  });

  it("assertRequirementsInputs rejects a non-address payTo", () => {
    expect(() =>
      assertRequirementsInputs({ ...baseInput(), payTo: "nope" as Address }),
    ).toThrow(TypeError);
  });

  it("stringifyPaymentRequired stringifies bigint amounts", () => {
    const body = buildPaymentRequired(baseInput());
    const wire = stringifyPaymentRequired(body);
    expect(wire.accepts[0]!.maxAmountRequired).toBe("12345");
    expect(typeof wire.accepts[0]!.maxAmountRequired).toBe("string");
  });

  it("defaultNetworkFor maps unknown chains to chain-{id}", () => {
    expect(defaultNetworkFor(1)).toBe("chain-1");
    expect(defaultNetworkFor(97)).toBe("bsc-testnet");
  });
});
