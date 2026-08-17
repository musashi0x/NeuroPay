import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { logger } from "./logger.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    log: typeof logger;
  }
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Stable per-request id.
 * - Inherits `x-request-id` from the upstream (gateway, load balancer, client).
 * - Otherwise generates a v4 UUID.
 * - Echoes the id back on the response so callers can correlate.
 * - Exposes it on `c.get("requestId")` and `c.get("log")` (a child logger
 *   pre-bound with the request id, so every log line for this request
 *   carries it automatically).
 */
export const requestId = (): MiddlewareHandler => {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId = incoming && incoming.length > 0 ? incoming : randomUUID();
    const log = logger.child({ requestId });

    c.set("requestId", requestId);
    c.set("log", log);
    c.header(REQUEST_ID_HEADER, requestId);

    await next();
  };
};

/**
 * Logs one structured line per request after it completes.
 * Uses the per-request child logger so `requestId` is included automatically.
 */
export const httpLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = performance.now();
    const log = c.get("log") ?? logger;

    await next();

    const durationMs = Number((performance.now() - start).toFixed(2));
    const status = c.res.status;
    const message = c.req.path;

    if (status >= 500) {
      log.error(
        { method: c.req.method, path: message, status, durationMs },
        "request failed",
      );
    } else if (status >= 400) {
      log.warn(
        { method: c.req.method, path: message, status, durationMs },
        "client error",
      );
    } else {
      log.info(
        { method: c.req.method, path: message, status, durationMs },
        "request completed",
      );
    }
  };
};

/** Helper: pull the request-scoped logger from a Hono context. */
export const getLog = (c: Context): typeof logger => c.get("log") ?? logger;
