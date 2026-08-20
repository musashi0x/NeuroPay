import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HealthResponse } from "@neuro-pay/types";
import { requestId, httpLogger, getLog } from "./middleware.js";
import { resolveCorsOrigin } from "./cors-origin.js";
import {
  consoleAuth,
  resolveConsoleAuth,
  type ConsoleAuthMode,
} from "./auth.js";
import {
  createRateLimiter,
  rateLimit,
  type RateLimiter,
} from "./rate-limit.js";
import { consoleRoutes, type ConsoleRouteDeps } from "./console/routes.js";
import { openStreamRoute, type OpenStreamDeps } from "./routes/streams/open.js";
import {
  nextSegmentRoute,
  type NextSegmentDeps,
} from "./routes/streams/next.js";

export type AppDeps = {
  console?: ConsoleRouteDeps["console"];
  seller?: OpenStreamDeps["seller"] & NextSegmentDeps["seller"];
  corsOrigin?: string;
  /** Injected by tests; the runtime resolves it from the environment. */
  consoleAuth?: ConsoleAuthMode;
  /** Injected by tests so limits can be exercised without wall-clock waits. */
  limiters?: { openStream?: RateLimiter; nextSegment?: RateLimiter };
  /** Set when a reverse proxy terminates connections in front of the API. */
  trustProxyHeader?: boolean;
};

/**
 * Default abuse bounds for the buyer-facing routes.
 *
 * Opening a stream is rarer and costlier than fetching a segment, so it
 * gets the tighter bucket. Segment fetches are the hot path of a
 * working stream and must not be throttled into uselessness by a limit
 * meant to stop stream spam.
 */
export const DEFAULT_OPEN_STREAM_LIMIT = { capacity: 30, refillMs: 60_000 };
export const DEFAULT_NEXT_SEGMENT_LIMIT = { capacity: 600, refillMs: 60_000 };

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const corsOrigin = resolveCorsOrigin(
    deps.corsOrigin ?? process.env.CORS_ORIGIN,
  );

  app.use("*", requestId());
  app.use("*", httpLogger());
  app.use(
    "*",
    cors({
      origin: corsOrigin,
      allowMethods: ["GET", "HEAD", "OPTIONS", "POST"],
      // `Authorization` is listed because the console now sends a bearer
      // token; without it the browser's preflight rejects every console
      // request before it is sent.
      allowHeaders: ["Content-Type", "X-Request-Id", "Authorization"],
    }),
  );

  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    };

    return c.json(body);
  });

  if (deps.seller) {
    // Buyer-facing. Deliberately unauthenticated: a buyer proves itself
    // by paying, not by holding an operator secret. Bounded by rate
    // instead, since anyone who can reach the port can call these.
    const openLimiter =
      deps.limiters?.openStream ?? createRateLimiter(DEFAULT_OPEN_STREAM_LIMIT);
    const segmentLimiter =
      deps.limiters?.nextSegment ??
      createRateLimiter(DEFAULT_NEXT_SEGMENT_LIMIT);
    const proxyOpts =
      deps.trustProxyHeader === true ? { trustProxyHeader: true } : {};

    app.use("/v1/streams", async (c, next) =>
      c.req.method === "POST"
        ? rateLimit(openLimiter, { label: "stream creation", ...proxyOpts })(
            c,
            next,
          )
        : next(),
    );
    app.use(
      "/v1/streams/:id/next",
      rateLimit(segmentLimiter, { label: "segment requests", ...proxyOpts }),
    );

    app.route("/", openStreamRoute({ seller: deps.seller }));
    app.route("/", nextSegmentRoute({ seller: deps.seller }));
  }

  if (deps.console) {
    // Operator-facing. Guarded by a bearer token, mounted on the console
    // router rather than a path prefix because `GET /v1/streams`
    // (operator) and `POST /v1/streams` (buyer) share a path.
    const authed = new Hono();
    const mode = deps.consoleAuth ?? resolveConsoleAuth();
    authed.use("*", consoleAuth(mode));
    authed.route("/", consoleRoutes({ console: deps.console }));
    app.route("/", authed);
  }

  app.onError((err, c) => {
    const log = getLog(c);
    log.error(
      {
        err: { name: err.name, message: err.message, stack: err.stack },
        method: c.req.method,
        path: c.req.path,
      },
      "unhandled error",
    );

    return c.json(
      {
        error: {
          message: "Internal Server Error",
          requestId: c.get("requestId"),
        },
      },
      500,
    );
  });

  app.notFound((c) => {
    return c.json(
      {
        error: {
          message: "Not Found",
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  });

  return app;
}

export const app = createApp();
