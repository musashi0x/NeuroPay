/**
 * Abuse controls for the buyer-facing seller routes.
 *
 * The seller routes cannot require a token — a buyer authenticates by
 * paying — so they are reachable by anyone who can reach the port. Two
 * distinct abuses follow, and they need different bounds:
 *
 *  1. **Request flooding.** Stream creation is cheap for the caller and
 *     not free for us: each one allocates a record and a price-sheet
 *     pin. A token bucket caps the rate.
 *  2. **Resource accumulation.** A caller that opens streams and then
 *     walks away leaves records behind. The idle sweep eventually
 *     collects them, but "eventually" is a whole sweep interval, and a
 *     fast opener outruns it. A concurrency ceiling caps the standing
 *     total regardless of rate.
 *
 * Neither is a substitute for the other: a slow opener never trips the
 * bucket but can still accumulate, and a burst can exceed the rate
 * without ever holding many streams at once.
 *
 * ## Scope
 *
 * In-memory and per-process. That is honest for a single-process
 * deployment and stated rather than implied: behind more than one
 * replica these limits are per-replica, and a real deployment wants a
 * shared store or an edge limiter. The alternative — pretending a
 * distributed limit exists — is worse than a documented local one.
 */

import type { MiddlewareHandler } from "hono";
import { getLog } from "./middleware.js";

/**
 * How a caller is identified.
 *
 * The socket address, optionally overridden by a trusted proxy header.
 * `X-Forwarded-For` is only consulted when the operator has said a proxy
 * is in front, because a client can set that header itself: trusting it
 * unconditionally would let any caller mint a fresh identity per request
 * and make the limiter decorative.
 */
export type ClientKeyOptions = {
  /** Set when a reverse proxy terminates connections in front of the API. */
  trustProxyHeader?: boolean;
};

export function clientKey(
  headers: { get(name: string): string | null },
  remoteAddress: string | undefined,
  options: ClientKeyOptions = {},
): string {
  if (options.trustProxyHeader === true) {
    const forwarded = headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return remoteAddress ?? "unknown";
}

export type TokenBucketOptions = {
  /** Sustained requests per interval once the burst is spent. */
  capacity: number;
  /** How long the bucket takes to refill completely, in milliseconds. */
  refillMs: number;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export type RateLimiter = {
  /** Consume one token. `false` means the caller is over its limit. */
  take(key: string): boolean;
  /** Milliseconds until `key` has a token again. Zero when it has one now. */
  retryAfterMs(key: string): number;
  /** Drop buckets that have fully refilled, so idle callers cost nothing. */
  sweep(): number;
  /** Live bucket count. Tests and the health surface read it. */
  size(): number;
};

type Bucket = { tokens: number; updatedAt: number };

/**
 * A token bucket per caller.
 *
 * Buckets refill continuously rather than on a fixed window boundary, so
 * a caller cannot spend a full allowance immediately before a boundary
 * and another immediately after.
 */
export function createRateLimiter(options: TokenBucketOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const perMs = options.capacity / options.refillMs;
  const buckets = new Map<string, Bucket>();

  function refill(key: string): Bucket {
    const t = now();
    const existing = buckets.get(key);
    if (existing === undefined) {
      const fresh: Bucket = { tokens: options.capacity, updatedAt: t };
      buckets.set(key, fresh);
      return fresh;
    }
    const elapsed = Math.max(0, t - existing.updatedAt);
    existing.tokens = Math.min(
      options.capacity,
      existing.tokens + elapsed * perMs,
    );
    existing.updatedAt = t;
    return existing;
  }

  return {
    take(key) {
      const bucket = refill(key);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    retryAfterMs(key) {
      const bucket = refill(key);
      if (bucket.tokens >= 1) return 0;
      return Math.ceil((1 - bucket.tokens) / perMs);
    },
    sweep() {
      let dropped = 0;
      for (const [key, bucket] of buckets) {
        const elapsed = now() - bucket.updatedAt;
        if (bucket.tokens + elapsed * perMs >= options.capacity) {
          buckets.delete(key);
          dropped += 1;
        }
      }
      return dropped;
    },
    size: () => buckets.size,
  };
}

/**
 * Reject a caller that is over its rate.
 *
 * Answers 429 with `Retry-After` in whole seconds, which is what the
 * header's grammar allows and what a well-behaved client backs off on.
 */
export function rateLimit(
  limiter: RateLimiter,
  options: ClientKeyOptions & { label: string } = { label: "request" },
): MiddlewareHandler {
  return async (c, next) => {
    const key = clientKey(
      { get: (n) => c.req.header(n) ?? null },
      c.env?.incoming?.socket?.remoteAddress as string | undefined,
      options,
    );
    if (limiter.take(key)) {
      await next();
      return;
    }

    const retryMs = limiter.retryAfterMs(key);
    getLog(c).warn(
      { method: c.req.method, path: c.req.path, retryMs, limit: options.label },
      "request rejected: rate limit exceeded",
    );
    c.header("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))));
    return c.json(
      {
        error: {
          message: "Too Many Requests",
          detail: `Rate limit exceeded for ${options.label}. Retry in ${Math.ceil(retryMs / 1000)}s.`,
          requestId: c.get("requestId"),
        },
      },
      429,
    );
  };
}
