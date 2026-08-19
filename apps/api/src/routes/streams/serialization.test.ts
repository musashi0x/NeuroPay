/**
 * Regression: the stream routes must survive `JSON.stringify`.
 *
 * Both wire shapes on these routes carry `bigint` — the pinned
 * `PriceSheet` (`perCall`, `perSecond`, `perUnit`) on open, and the
 * segment's `accruedUnpaid` / `totalAccrued` on delivery. `c.json()`
 * throws `TypeError: Do not know how to serialize a BigInt` on either,
 * which turns a healthy response into a 500.
 *
 * The seller's own tests call `openStream` / `nextSegment` directly and
 * never cross the JSON boundary, so nothing caught this until a client
 * actually issued the request. These tests hold that boundary.
 */

import { describe, expect, it } from "vitest";
import type { SegmentResponse, StreamOpenResponse } from "@neuro-pay/types";
import { openStreamRoute } from "./open.js";
import { nextSegmentRoute, renderOutcome } from "./next.js";
import type { SellerOutcome } from "../../seller/index.js";

const TOKEN = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" as const;
const PAY_TO = "0x00000000000000000000000000000000000000A1" as const;

const openResponse: StreamOpenResponse = {
  streamId: "stream-1",
  priceSheet: {
    id: "sheet-1",
    version: 1,
    chainId: 97,
    token: TOKEN,
    tokenDecimals: 18,
    perCall: 1n,
    perSecond: 2n,
    perUnit: 10_000_000_000_000n,
    unitName: "unit",
    issuedAt: "2026-01-01T00:00:00.000Z",
  },
  chainId: 97,
  token: TOKEN,
  tokenDecimals: 18,
  payTo: PAY_TO,
  openedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T01:00:00.000Z",
  maxSecondsPerSegment: 60,
  maxUnitsPerSegment: 1000,
};

const segment: SegmentResponse = {
  streamId: "stream-1",
  sequence: 1,
  data: "",
  secondsDelivered: 60,
  unitsDelivered: 1000,
  accruedUnpaid: 10_000_000_000_000_000n,
  totalAccrued: 10_000_000_000_000_000n,
  streamEnded: false,
  endReason: null,
};

describe("POST /v1/streams", () => {
  it("serializes the pinned price sheet's bigint amounts as strings", async () => {
    const app = openStreamRoute({ seller: { openStream: () => openResponse } });

    const response = await app.request("/v1/streams", { method: "POST" });
    const body = (await response.json()) as {
      priceSheet: { perCall: string; perSecond: string; perUnit: string };
    };

    expect(response.status).toBe(200);
    expect(body.priceSheet.perCall).toBe("1");
    expect(body.priceSheet.perSecond).toBe("2");
    expect(body.priceSheet.perUnit).toBe("10000000000000");
  });
});

describe("GET /v1/streams/:id/next", () => {
  it("serializes a delivered segment's bigint amounts as strings", async () => {
    const app = nextSegmentRoute({
      seller: {
        nextSegment: async (): Promise<SellerOutcome> => ({
          kind: "delivered",
          status: 200,
          body: segment,
        }),
      },
    });

    const response = await app.request("/v1/streams/stream-1/next");
    const body = (await response.json()) as {
      accruedUnpaid: string;
      totalAccrued: string;
      unitsDelivered: number;
    };

    expect(response.status).toBe(200);
    expect(body.accruedUnpaid).toBe("10000000000000000");
    expect(body.totalAccrued).toBe("10000000000000000");
    // Non-amount fields keep their JSON type.
    expect(body.unitsDelivered).toBe(1000);
  });

  it("serializes an exposure refusal without throwing on bigint", async () => {
    const outcome: SellerOutcome = {
      kind: "exposure-limit",
      status: 503,
      refusal: {
        kind: "refusal",
        reason: "exposure-limit-reached",
        detail: "3 settlements in flight",
        inFlight: 3,
        ceiling: 3,
        exposureCeiling: 150_000_000_000_000_000n,
      },
    };

    expect(() => renderOutcome(fakeContext(), outcome)).not.toThrow();
  });
});

/**
 * The narrow slice of Hono's `Context` that `renderOutcome` uses. Kept
 * local so the exposure case can be exercised without building an app.
 */
function fakeContext(): Parameters<typeof renderOutcome>[0] {
  return {
    json: (value: unknown, status: number) =>
      new Response(JSON.stringify(value), { status }),
  } as Parameters<typeof renderOutcome>[0];
}
