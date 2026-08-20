/**
 * Tests for the buyer-route abuse controls.
 *
 * Two bounds that are easy to conflate and must both hold: a rate limit
 * (how fast) and a concurrency ceiling (how many at once). A fast opener
 * trips the first; a slow, patient one only ever trips the second.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { clientKey, createRateLimiter } from "./rate-limit.js";

function sellerStub(overrides: { openStream?: () => unknown } = {}) {
  return {
    openStream:
      overrides.openStream ??
      (() => ({
        streamId: "s-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        priceSheet: {
          id: "p-1",
          version: 1,
          chainId: 97,
          token: "0x0000000000000000000000000000000000000001",
          tokenDecimals: 18,
          perCall: 0n,
          perSecond: 0n,
          perUnit: 0n,
          unitName: "unit",
          pinnedAt: new Date().toISOString(),
        },
      })),
    nextSegment: async () => ({
      kind: "not-found" as const,
      status: 404 as const,
      reason: "stub",
    }),
  };
}

describe("token bucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const now = 0;
    const limiter = createRateLimiter({
      capacity: 3,
      refillMs: 1000,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("refills continuously rather than on a window boundary", () => {
    // A fixed window lets a caller spend a full allowance just before
    // the boundary and another just after, doubling the intended rate.
    let now = 0;
    const limiter = createRateLimiter({
      capacity: 2,
      refillMs: 1000,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);

    now += 500; // half the refill window -> exactly one token back
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("keeps callers independent", () => {
    const now = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillMs: 1000,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
  });

  it("reports when a refused caller may retry", () => {
    let now = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillMs: 1000,
      now: () => now,
    });
    limiter.take("a");
    expect(limiter.retryAfterMs("a")).toBeGreaterThan(0);
    now += 1000;
    expect(limiter.retryAfterMs("a")).toBe(0);
  });

  it("drops fully refilled buckets so idle callers cost nothing", () => {
    let now = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillMs: 1000,
      now: () => now,
    });
    limiter.take("a");
    expect(limiter.size()).toBe(1);
    expect(limiter.sweep()).toBe(0); // still draining
    now += 5000;
    expect(limiter.sweep()).toBe(1);
    expect(limiter.size()).toBe(0);
  });
});

describe("clientKey", () => {
  const headers = (v: string | null) => ({ get: () => v });

  it("ignores X-Forwarded-For unless a proxy is trusted", () => {
    // A client can set this header itself. Trusting it unconditionally
    // would let any caller mint a fresh identity per request and make
    // the limiter decorative.
    expect(clientKey(headers("1.2.3.4"), "10.0.0.1")).toBe("10.0.0.1");
  });

  it("uses the first forwarded hop when a proxy is trusted", () => {
    expect(
      clientKey(headers("1.2.3.4, 5.6.7.8"), "10.0.0.1", {
        trustProxyHeader: true,
      }),
    ).toBe("1.2.3.4");
  });

  it("falls back to a constant when the address is unknown", () => {
    expect(clientKey(headers(null), undefined)).toBe("unknown");
  });
});

describe("stream creation is rate limited", () => {
  it("429s past the bucket, with Retry-After", async () => {
    const now = 0;
    const limiter = createRateLimiter({
      capacity: 2,
      refillMs: 60_000,
      now: () => now,
    });
    const app = createApp({
      seller: sellerStub() as never,
      limiters: { openStream: limiter },
    });

    expect((await app.request("/v1/streams", { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request("/v1/streams", { method: "POST" })).status).toBe(
      200,
    );
    const refused = await app.request("/v1/streams", { method: "POST" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("does not consume the stream-creation bucket on segment requests", async () => {
    // The two limits are separate on purpose: a working stream's hot
    // path must not be throttled by a limit meant to stop stream spam.
    const now = 0;
    const openLimiter = createRateLimiter({
      capacity: 1,
      refillMs: 60_000,
      now: () => now,
    });
    const app = createApp({
      seller: sellerStub() as never,
      limiters: { openStream: openLimiter },
    });

    for (let i = 0; i < 5; i += 1) {
      await app.request("/v1/streams/s-1/next");
    }
    expect((await app.request("/v1/streams", { method: "POST" })).status).toBe(
      200,
    );
  });

  it("does not rate limit /health", async () => {
    const now = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillMs: 60_000,
      now: () => now,
    });
    const app = createApp({
      seller: sellerStub() as never,
      limiters: { openStream: limiter, nextSegment: limiter },
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request("/health")).status).toBe(200);
    }
  });
});

describe("segment requests are rate limited", () => {
  it("429s past the bucket", async () => {
    const now = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillMs: 60_000,
      now: () => now,
    });
    const app = createApp({
      seller: sellerStub() as never,
      limiters: { nextSegment: limiter },
    });
    expect((await app.request("/v1/streams/s-1/next")).status).toBe(404);
    expect((await app.request("/v1/streams/s-1/next")).status).toBe(429);
  });
});
