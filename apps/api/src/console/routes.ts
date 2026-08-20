/**
 * Operator console HTTP surface.
 *
 *   GET  /v1/session   — session policy
 *   GET  /v1/streams   — stream snapshots
 *   GET  /v1/payments  — ledger history
 *   GET  /v1/budget    — window spend vs both limits
 *   POST /v1/session/revoke — two-stage kill switch
 *   POST /v1/session/revoke/retry — resubmit a failed on-chain revoke
 *   POST /v1/settlements/:nonce/retry — resubmit a failed settlement
 *   GET  /v1/events    — SSE snapshots so the console need not reload
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { toJsonSafe } from "../json.js";
import { getLog } from "../middleware.js";
import {
  ConsoleNotFoundError,
  type ConsoleService,
  type OperatorContext,
} from "./service.js";

export type ConsoleRouteDeps = {
  console: ConsoleService;
};

/**
 * Attribute an action to the caller.
 *
 * `operator` rather than a user identity because the console
 * authenticates with one shared bearer token — claiming to know *which*
 * person acted would be a fiction. The request id is the real link: it
 * ties the audit record to the access log line that has the source
 * address and timing.
 */
function operatorContext(c: {
  get: (key: "requestId") => string | undefined;
}): OperatorContext {
  return { actor: "operator", requestId: c.get("requestId") ?? null };
}

export function consoleRoutes(deps: ConsoleRouteDeps): Hono {
  const app = new Hono();

  app.get("/v1/session", async (c) => {
    const session = await deps.console.getSession();
    if (!session) {
      return c.json({ error: { message: "No active session" } }, 404);
    }
    return c.json(toJsonSafe(session), 200);
  });

  app.get("/v1/streams", async (c) => {
    const streams = await deps.console.listStreams();
    return c.json(toJsonSafe({ streams }), 200);
  });

  app.get("/v1/payments", async (c) => {
    const payments = await deps.console.listPayments();
    return c.json(toJsonSafe({ payments }), 200);
  });

  app.get("/v1/budget", async (c) => {
    const budget = await deps.console.getBudget();
    if (!budget) {
      return c.json({ error: { message: "No active session" } }, 404);
    }
    return c.json(toJsonSafe(budget), 200);
  });

  app.post("/v1/session/revoke", async (c) => {
    // Revocation is the kill switch. The ledger already records the
    // outcome as `session.revoked`; this line records the *request* —
    // when it arrived and under which request id — so an operator can
    // tie a revoked session back to the call that ended it.
    getLog(c).warn(
      { action: "revoke", path: c.req.path },
      "operator invoked session revocation",
    );
    try {
      const result = await deps.console.revoke(operatorContext(c));
      return c.json(toJsonSafe(result), 200);
    } catch (err) {
      if (err instanceof ConsoleNotFoundError) {
        return c.json({ error: { message: err.message } }, 404);
      }
      throw err;
    }
  });

  app.post("/v1/session/revoke/retry", async (c) => {
    // Revocation is the kill switch. The ledger already records the
    // outcome as `session.revoked`; this line records the *request* —
    // when it arrived and under which request id — so an operator can
    // tie a revoked session back to the call that ended it.
    getLog(c).warn(
      { action: "revoke-retry", path: c.req.path },
      "operator invoked session revocation",
    );
    try {
      const result = await deps.console.retryRevoke(operatorContext(c));
      return c.json(toJsonSafe(result), 200);
    } catch (err) {
      if (err instanceof ConsoleNotFoundError) {
        return c.json({ error: { message: err.message } }, 404);
      }
      throw err;
    }
  });

  app.post("/v1/settlements/:nonce/retry", async (c) => {
    const nonce = c.req.param("nonce");
    getLog(c).warn(
      { action: "settlement-retry", nonce },
      "operator requested a settlement retry",
    );
    try {
      const result = await deps.console.retrySettlement(
        nonce,
        operatorContext(c),
      );
      return c.json(toJsonSafe(result), 200);
    } catch (err) {
      if (err instanceof ConsoleNotFoundError) {
        return c.json({ error: { message: err.message } }, 404);
      }
      // A retry that reaches the chain and reverts is the operator's
      // answer, not a server fault: they asked whether this settlement
      // can go through now, and it cannot. 409 says "the resource is not
      // in a state where this works" without claiming the API broke.
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            requestId: c.get("requestId"),
          },
        },
        409,
      );
    }
  });

  app.get("/v1/events", (c) => {
    return streamSSE(c, async (stream) => {
      const snapshot = await deps.console.snapshot();
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(toJsonSafe(snapshot)),
      });

      let closed = false;
      const unsubscribe = deps.console.subscribe((event) => {
        if (closed) return;
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(toJsonSafe(event.snapshot)),
        });
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.writeSSE({ event: "ping", data: "" });
      }, 15_000);

      await new Promise<void>((resolve) => {
        const abort = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          unbindAbort();
          resolve();
        };
        const unbindAbort = deps.console.registerSseAbort(abort);
        stream.onAbort(abort);
      });
    });
  });

  return app;
}
