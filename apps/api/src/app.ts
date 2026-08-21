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
import { consoleRoutes } from "./console/routes.js";
import { opsRoutes, readinessRoute, type OpsRouteDeps } from "./ops/routes.js";
import { openApiDocument } from "./openapi.js";
import type { LedgerStore } from "@neuro-pay/ledger";
import type { AutoRevokeWatcher } from "./console/auto-revoke-watcher.js";
import type { ConsoleService } from "./console/service.js";
import { openStreamRoute, type OpenStreamDeps } from "./routes/streams/open.js";
import {
  nextSegmentRoute,
  type NextSegmentDeps,
} from "./routes/streams/next.js";

export type AppDeps = {
  console?: ConsoleService;
  /** Audit-trail sink for the auto-revoke arm/disarm audit entries. */
  ledger?: LedgerStore;
  /** Runtime auto-revoke watcher; required when `console` is set. */
  autoRevoke?: AutoRevokeWatcher;
  /**
   * Readiness, metrics, and the audit trail. Mounted independently of
   * `console` so a process with no payment runtime can still be probed.
   */
  ops?: OpsRouteDeps;
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
      allowMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT"],
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

  app.get("/openapi.json", (c) => c.json(openApiDocument));

  if (deps.ops) {
    // Unauthenticated on purpose — see `ops/routes.ts` for what it does
    // and does not publish.
    app.route(
      "/",
      readinessRoute({
        ops: deps.ops.ops,
        ...(deps.autoRevoke
          ? { isAutoRevokeArmed: () => deps.autoRevoke!.status().enabled }
          : {}),
      }),
    );
  }

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
    // The new auto-revoke routes require both ledger (for audit
    // writes) and autoRevoke (the watcher itself). When a deployment
    // does not pass them, the existing console routes still mount
    // and the new routes are simply absent — `GET` and `PUT
    // /v1/session/auto-revoke` return 404, which matches the
    // additive spec contract.
    if (deps.ledger && deps.autoRevoke) {
      authed.route(
        "/",
        consoleRoutes({
          console: deps.console,
          ledger: deps.ledger,
          autoRevoke: deps.autoRevoke,
        }),
      );
    } else {
      authed.route(
        "/",
        consoleRoutes({ console: deps.console }),
      );
    }
    app.route("/", authed);
  }

  if (deps.ops) {
    // Metrics, detailed health, and the audit trail all name internal
    // configuration, so they sit behind the same operator token the
    // console does.
    const authedOps = new Hono();
    authedOps.use("*", consoleAuth(deps.consoleAuth ?? resolveConsoleAuth()));
    authedOps.route(
      "/",
      opsRoutes({
        ...deps.ops,
        ...(deps.autoRevoke
          ? { isAutoRevokeArmed: () => deps.autoRevoke!.status().enabled }
          : {}),
      }),
    );
    app.route("/", authedOps);
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
