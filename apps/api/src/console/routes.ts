/**
 * Operator console HTTP surface.
 *
 *   GET  /v1/session   — session policy
 *   GET  /v1/streams   — stream snapshots
 *   GET  /v1/payments  — ledger history
 *   GET  /v1/budget    — window spend vs both limits
 *   POST /v1/session/revoke — two-stage kill switch
 *   GET  /v1/events    — SSE snapshots so the console need not reload
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { toJsonSafe } from "../json.js";
import { ConsoleNotFoundError, type ConsoleService } from "./service.js";

export type ConsoleRouteDeps = {
  console: ConsoleService;
};

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
    try {
      const result = await deps.console.revoke();
      return c.json(toJsonSafe(result), 200);
    } catch (err) {
      if (err instanceof ConsoleNotFoundError) {
        return c.json({ error: { message: err.message } }, 404);
      }
      throw err;
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
