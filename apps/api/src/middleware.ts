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
 *   pre-bound with the request id).
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
 * Skips noisy success logs for probes by default; configure as needed.
 */
export const httpLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = performance.now();
    const log = (c.get("log") ?? logger) as typeof logger;

    await next();

    const durationMs = Number((performance.now() - start).toFixed(2));
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;

    const fields = {
      method,
      path,
      status,
      durationMs,
      ...(c.get("requestId") ? { requestId: c.get("requestId") } : {}),
    };

    if (status >= 500) {
      log.error(fields, "request failed");
    } else if (status >= 400) {
      log.warn(fields, "client error");
    } else {
      log.info(fields, "request completed");
    }
  };
};

/** Helper: pull the request-scoped logger from a Hono context. */
export const getLog = (c: Context): typeof logger =>
  (c.get("log") as typeof logger | undefined) ?? logger;
