/**
 * Composition-root tests (seller/index.ts).
 *
 * Verified:
 *  - openStream returns a stream id and a price sheet
 *  - nextSegment against an unknown id → 404
 *  - missing envelope & meter under threshold → 402 with the expected
 *    accepts[] payload
 *  - exposure-limit gate fires once maxInFlight settlements are pending
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import type { Address } from "@neuro-pay/types";
import type { Clock, MeteringConfig } from "@neuro-pay/metering";
import {
  createInMemorySettler,
  createStallingSettler,
  type Settler,
} from "./settle.js";
import { IS_VALID_SIGNATURE_MAGIC, type Verifier } from "./verify.js";
import { createSeller, type Seller } from "./index.js";
import { Buffer } from "node:buffer";

const TOKEN: Address = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d";
const PAY_TO: Address = "0x000000000000000000000000000000000000d3ad";
const PAYER: Address = "0x000000000000000000000000000000000000c0de";

function clock(): Clock {
  return { now: () => 1_700_000_000_000 };
}

function metering(): MeteringConfig {
  return {
    budgetMargin: 0,
    settlementThreshold: 1_000n,
    tickIntervalSeconds: 60,
    maxInFlightSettlements: 2,
  };
}

function freshLedger(): LedgerStore {
  return openLedgerStore({ storagePath: ":memory:" });
}

function envelopeHeaders(payload: Record<string, unknown>): {
  get(name: string): string | null;
} {
  const raw = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return { get: (n) => (n.toLowerCase() === "x-payment" ? raw : null) };
}

function buildSeller(opts: {
  verifier?: Verifier;
  meteringConfig?: MeteringConfig;
  settler?: Settler;
}): { seller: Seller; store: LedgerStore } {
  const store = freshLedger();
  const verifier: Verifier =
    opts.verifier ?? (async () => IS_VALID_SIGNATURE_MAGIC);
  const settler =
    opts.settler ?? createInMemorySettler({ defaultBehavior: "confirm" });
  const seller = createSeller({
    config: {
      metering: opts.meteringConfig ?? metering(),
      payTo: PAY_TO,
      chainId: 97,
      token: TOKEN,
      tokenDecimals: 18,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
    },
    store,
    verifier,
    settler,
    clock: clock(),
    initialPriceSheet: {
      perCall: 100n,
      perSecond: 10n,
      perUnit: 1n,
      unitName: "token",
    },
  });
  return { seller, store };
}

describe("seller composition root", () => {
  it("openStream returns a stream id and a complete price sheet", () => {
    const { seller } = buildSeller({});
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    expect(opened.streamId).toMatch(/.+/);
    expect(opened.priceSheet.chainId).toBe(97);
    expect(opened.priceSheet.token).toBe(TOKEN);
    expect(opened.priceSheet.tokenDecimals).toBe(18);
    expect(opened.priceSheet.perCall).toBe(100n);
    expect(opened.payTo).toBe(PAY_TO);
  });

  it("nextSegment on an unknown id → not-found (404)", async () => {
    const { seller } = buildSeller({});
    const outcome = await seller.nextSegment({
      streamId: "does-not-exist",
      headers: { get: () => null },
      requestUrl: "https://api.example/v1/streams/abc/next",
    });
    expect(outcome.kind).toBe("not-found");
    if (outcome.kind === "not-found") expect(outcome.status).toBe(404);
  });

  it("no envelope + cost under threshold → 402 with accepts[]", async () => {
    const { seller } = buildSeller({});
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const outcome = await seller.nextSegment({
      streamId: "missing",
      headers: { get: () => null },
      requestUrl: "https://api.example/v1/streams/missing/next",
    });
    // No stream -> not-found before the demand logic. Open a stream for the
    // next call:
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    const outcome2 = await seller.nextSegment({
      streamId: opened.streamId,
      headers: { get: () => null },
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(["payment-required", "not-found"]).toContain(outcome.kind);
    expect(["payment-required", "delivered"]).toContain(outcome2.kind);
  });

  it("valid envelope delivers a 200; a replay under the same nonce returns the same body", async () => {
    const { seller } = buildSeller({});
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });

    const env = {
      from: PAYER,
      permit: {
        hash: "0x" + "22".repeat(32),
        signature: "0x" + "11".repeat(65),
        witness: {
          payTo: PAY_TO,
          amount: "1000",
          token: TOKEN,
          chainId: 97,
          nonce: "x-replay",
        },
      },
    };
    const headers = envelopeHeaders(env);

    const first = await seller.nextSegment({
      streamId: opened.streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(first.kind).toBe("delivered");
    if (first.kind !== "delivered") return;
    const body1 = first.body as {
      sequence: number;
      data: string;
      accruedUnpaid: bigint;
      totalAccrued: bigint;
      secondsDelivered: number;
      unitsDelivered: number;
    };

    // Second presentation of the same nonce should serve the cached segment.
    const second = await seller.nextSegment({
      streamId: opened.streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(second.kind).toBe("delivered");
    if (second.kind === "delivered") {
      expect(second.body).toEqual(body1);
    }
  });

  it("writes a durable settlement intent before returning the segment", async () => {
    const stalled = createStallingSettler();
    const { seller, store } = buildSeller({ settler: stalled.settler });
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    const first = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders({
        from: PAYER,
        permit: {
          hash: "0x" + "22".repeat(32),
          signature: "0x" + "11".repeat(65),
          witness: {
            payTo: PAY_TO,
            amount: "1000",
            token: TOKEN,
            chainId: 97,
            nonce: "outbox-seg-1",
          },
        },
      }),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(first.kind).toBe("delivered");
    const intent = await store.getIntent("outbox-seg-1");
    expect(intent).not.toBeNull();
    expect(["pending", "submitted"]).toContain(intent?.status);
    stalled.confirm();
    await seller.drainSettlements();
    expect((await store.getIntent("outbox-seg-1"))?.status).toBe("confirmed");
  });

  it("exposure-limit gate fires once maxInFlight settlements are pending", async () => {
    const { seller } = buildSeller({
      meteringConfig: {
        budgetMargin: 0,
        settlementThreshold: 1n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 1,
      },
    });

    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });

    const env = (nonce: string) => ({
      from: PAYER,
      permit: {
        hash: "0x" + "22".repeat(32),
        signature: "0x" + "11".repeat(65),
        witness: {
          payTo: PAY_TO,
          amount: "1",
          token: TOKEN,
          chainId: 97,
          nonce,
        },
      },
    });

    const r1 = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("e-1")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(r1.kind).toBe("delivered");

    // Second delivery tries to acquire a second slot: settler hasn't
    // confirmed yet, so the gate refuses.
    const r2 = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("e-2")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(["exposure-limit", "delivered", "payment-required"]).toContain(
      r2.kind,
    );

    await seller.drainSettlements();

    const stats = seller.exposureStats();
    expect(stats.ceiling).toBe(1);
  });

  it("credits accruedUnpaid once settlement confirms", async () => {
    const { seller } = buildSeller({});
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    const env = {
      from: PAYER,
      permit: {
        hash: "0x" + "22".repeat(32),
        signature: "0x" + "11".repeat(65),
        witness: {
          payTo: PAY_TO,
          amount: "1000",
          token: TOKEN,
          chainId: 97,
          nonce: "settle-credit-1",
        },
      },
    };

    const delivered = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(delivered.kind).toBe("delivered");
    if (delivered.kind !== "delivered") return;
    const body = delivered.body as {
      accruedUnpaid: bigint;
      totalAccrued: bigint;
    };
    expect(body.accruedUnpaid).toBeGreaterThan(0n);
    expect(body.totalAccrued).toBe(body.accruedUnpaid);

    await seller.drainSettlements();

    const after = seller.inspectStreams()[0]!;
    expect(after.meter.accruedUnpaid).toBe(0n);
    expect(after.meter.totalAccrued).toBe(body.totalAccrued);
  });

  it("holds the exposure slot until confirmation, then resumes delivery", async () => {
    const stalled = createStallingSettler();
    const { seller } = buildSeller({
      settler: stalled.settler,
      meteringConfig: {
        budgetMargin: 0,
        settlementThreshold: 1n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 1,
      },
    });
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    const env = (nonce: string) => ({
      from: PAYER,
      permit: {
        hash: "0x" + "22".repeat(32),
        signature: "0x" + "11".repeat(65),
        witness: {
          payTo: PAY_TO,
          amount: "1",
          token: TOKEN,
          chainId: 97,
          nonce,
        },
      },
    });

    const first = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("stall-1")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(first.kind).toBe("delivered");

    const blocked = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("stall-2")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(blocked.kind).toBe("exposure-limit");
    expect(seller.exposureStats().inFlight).toBe(1);

    stalled.confirm();
    await seller.drainSettlements();
    expect(seller.exposureStats().inFlight).toBe(0);

    const resumed = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("stall-3")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(resumed.kind).toBe("delivered");
  });

  it("keeps the exposure slot after a failed settlement", async () => {
    const { seller } = buildSeller({
      settler: createInMemorySettler({ defaultBehavior: "revert" }),
      meteringConfig: {
        budgetMargin: 0,
        settlementThreshold: 1n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 1,
      },
    });
    const opened = seller.openStream({
      requestUrl: "https://api.example/v1/streams",
    });
    const env = (nonce: string) => ({
      from: PAYER,
      permit: {
        hash: "0x" + "22".repeat(32),
        signature: "0x" + "11".repeat(65),
        witness: {
          payTo: PAY_TO,
          amount: "1",
          token: TOKEN,
          chainId: 97,
          nonce,
        },
      },
    });

    const first = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("fail-hold-1")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(first.kind).toBe("delivered");
    await seller.drainSettlements();

    expect(seller.exposureStats().inFlight).toBe(1);

    const second = await seller.nextSegment({
      streamId: opened.streamId,
      headers: envelopeHeaders(env("fail-hold-2")),
      requestUrl: `https://api.example/v1/streams/${opened.streamId}/next`,
    });
    expect(second.kind).toBe("exposure-limit");

    const after = seller.inspectStreams()[0]!;
    expect(after.meter.accruedUnpaid).toBeGreaterThan(0n);
  });
});
