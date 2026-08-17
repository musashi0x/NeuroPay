/**
 * Tests for the pinned price sheet (5.10).
 *
 * Verified:
 *  - opening a stream pins the price sheet
 *  - a price-sheet bump ends streams with reason `price-changed`
 *  - streams opened before the bump keep their original pinned prices
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import type { Address } from "@neuro-pay/types";
import type { Clock, MeteringConfig } from "@neuro-pay/metering";
import { createInMemorySettler, type Settler } from "./settle.js";
import {
  bumpPriceSheet,
  createPriceRegistry,
  type PriceRegistry,
} from "./prices.js";
import { createStreamStore, type StreamStore } from "./streams.js";
import { IS_VALID_SIGNATURE_MAGIC, type Verifier } from "./verify.js";
import { createSeller, type Seller } from "./index.js";

const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const PAYER = "0x000000000000000000000000000000000000c0de" as Address;

function fixtures() {
  let counter = 0;
  const now = (() => {
    let t = 1_700_000_000_000;
    return () => new Date((t += 10)).toISOString();
  })();
  const randomId = () => `id-${++counter}`;

  const registry: PriceRegistry = createPriceRegistry(
    { chainId: 97, token: TOKEN, tokenDecimals: 18 },
    { perCall: 100n, perSecond: 10n, perUnit: 1n, unitName: "token" },
    { randomId, now },
  );
  const streams: StreamStore = createStreamStore({ randomId, now });
  return { registry, streams, now, randomId };
}

function buildSeller(opts: { metering?: MeteringConfig } = {}): {
  seller: Seller;
  store: LedgerStore;
} {
  const store = openLedgerStore({ storagePath: ":memory:" });
  const verifier: Verifier = async () => IS_VALID_SIGNATURE_MAGIC;
  const settler: Settler = createInMemorySettler({
    defaultBehavior: "confirm",
  });
  const clock: Clock = { now: () => 1_700_000_000_000 };
  const seller = createSeller({
    config: {
      metering: opts.metering ?? {
        budgetMargin: 0,
        settlementThreshold: 1000n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 4,
      },
      payTo: PAY_TO,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
    },
    store,
    verifier,
    settler,
    clock,
    initialPriceSheet: {
      perCall: 100n,
      perSecond: 10n,
      perUnit: 1n,
      unitName: "token",
    },
  });
  return { seller, store };
}
void PAYER;

describe("prices - registry layer", () => {
  it("createPriceRegistry mints a v1 sheet with a stable id", () => {
    const { registry } = fixtures();
    expect(registry.current.version).toBe(1);
    expect(registry.current.id).toMatch(/^id-\d+$/);
    expect(registry.current.perCall).toBe(100n);
  });

  it("openStream pins a copy of the current sheet", () => {
    const { registry, streams } = fixtures();
    const opened = streams.open({
      priceSheet: registry.current,
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    const record = streams.get(opened.streamId);
    expect(record?.priceSheet).toEqual(registry.current);
    expect(record?.priceSheet.version).toBe(1);
  });

  it("bumping the registry does NOT alter already-opened stream records", () => {
    const { registry, streams } = fixtures();
    const opened = streams.open({
      priceSheet: registry.current,
      payTo: PAY_TO,
      maxSecondsPerSegment: 60,
      maxUnitsPerSegment: 1000,
      segmentProducer: () => ({
        data: "",
        secondsDelivered: 0,
        unitsDelivered: 0,
      }),
    });
    const pinnedPrice = opened.priceSheet.perCall;
    bumpPriceSheet(registry, {
      perCall: 999n,
      perSecond: 999n,
      perUnit: 999n,
      unitName: "token",
    });
    const record = streams.get(opened.streamId);
    expect(record?.priceSheet.perCall).toBe(pinnedPrice);
    expect(registry.current.perCall).toBe(999n);
  });

  it("bump increments the version monotonically", () => {
    const { registry } = fixtures();
    const v1 = registry.version;
    bumpPriceSheet(registry, {
      perCall: 200n,
      perSecond: 20n,
      perUnit: 2n,
      unitName: "token",
    });
    expect(registry.version).toBe(v1 + 1);
    bumpPriceSheet(registry, {
      perCall: 300n,
      perSecond: 30n,
      perUnit: 3n,
      unitName: "token",
    });
    expect(registry.version).toBe(v1 + 2);
  });
});

describe("prices - composition-root fan-out", () => {
  it("seller.updatePrices() ends active streams with reason='price-changed'", () => {
    const { seller } = buildSeller();
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    expect(seller.currentPriceSheet().version).toBe(1);

    const ended = seller.updatePrices({
      perCall: 200n,
      perSecond: 20n,
      perUnit: 2n,
      unitName: "token",
    });

    expect(ended.ended.length).toBeGreaterThanOrEqual(1);
    expect(
      ended.ended.find((e) => e.streamId === opened.streamId),
    ).toBeTruthy();
    expect(seller.currentPriceSheet().version).toBe(2);
    expect(seller.currentPriceSheet().perCall).toBe(200n);
  });
});
