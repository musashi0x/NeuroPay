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
import type {
  AuditAction,
  AuditOutcome,
  LedgerEventType,
  StreamStatus,
} from "@neuro-pay/types";
import type { LedgerStore } from "@neuro-pay/ledger";
import { toJsonSafe } from "../json.js";
import { getLog } from "../middleware.js";
import { logger } from "../logger.js";
import {
  ConsoleNotFoundError,
  type ConsoleService,
  type OperatorContext,
} from "./service.js";
import type { AutoRevokeWatcher } from "./auto-revoke-watcher.js";
import type { PaymentListQuery, StreamListQuery } from "./page.js";

const LEDGER_EVENTS = new Set<LedgerEventType>([
  "stream.opened",
  "stream.ended",
  "stream.abandoned",
  "settlement.retry",
  "settlement.recovered",
  "accrual.recorded",
  "payment.demanded",
  "payment.refused",
  "payment.signed",
  "payment.verified",
  "payment.rejected",
  "segment.delivered",
  "settlement.submitted",
  "settlement.confirmed",
  "settlement.failed",
  "payment.settlement.submitted",
  "payment.settlement.confirmed",
  "payment.settlement.failed",
  "payment.settlement.lost",
  "session.granted",
  "session.revoked",
]);

const STREAM_STATUSES = new Set<StreamStatus>(["active", "ended", "abandoned"]);

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function parseStreamQuery(c: {
  req: { query: (k: string) => string | undefined };
}): StreamListQuery {
  const query: StreamListQuery = {};
  const limit = parseLimit(c.req.query("limit"));
  if (limit !== undefined) query.limit = limit;
  const cursor = c.req.query("cursor");
  if (cursor !== undefined) query.cursor = cursor;
  const status = c.req.query("status");
  if (status !== undefined && STREAM_STATUSES.has(status as StreamStatus)) {
    query.status = status as StreamStatus;
  }
  return query;
}

function parsePaymentQuery(c: {
  req: { query: (k: string) => string | undefined };
}): PaymentListQuery {
  const query: PaymentListQuery = {};
  const limit = parseLimit(c.req.query("limit"));
  if (limit !== undefined) query.limit = limit;
  const cursor = c.req.query("cursor");
  if (cursor !== undefined) query.cursor = cursor;
  const event = c.req.query("event");
  if (event !== undefined && LEDGER_EVENTS.has(event as LedgerEventType)) {
    query.event = event as LedgerEventType;
  }
  const streamId = c.req.query("streamId");
  if (streamId !== undefined) query.streamId = streamId;
  return query;
}

export type ConsoleRouteDeps = {
  console: ConsoleService;
  /**
   * Audit-trail sink for the auto-revoke arm/disarm events. Optional
   * so existing test harnesses that do not exercise the auto-revoke
   * routes can mount the rest of the console without wiring one. The
   * auto-revoke routes require it; the existing console routes do
   * not.
   */
  ledger?: LedgerStore;
  /**
   * Runtime auto-revoke watcher. Optional for the same reason as
   * `ledger`. The auto-revoke routes require it; the existing
   * console routes do not.
   */
  autoRevoke?: AutoRevokeWatcher;
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
    const page = await deps.console.listStreams(parseStreamQuery(c));
    return c.json(
      toJsonSafe({ streams: page.items, nextCursor: page.nextCursor }),
      200,
    );
  });

  app.get("/v1/payments", async (c) => {
    const page = await deps.console.listPayments(parsePaymentQuery(c));
    return c.json(
      toJsonSafe({ payments: page.items, nextCursor: page.nextCursor }),
      200,
    );
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

  // ----- Auto-revoke-on-failure routes (operator token) ------------------

  app.get("/v1/session/auto-revoke", (c) => {
    if (!deps.autoRevoke) {
      return c.json(
        { error: { message: "auto-revoke watcher is not wired" } },
        404,
      );
    }
    return c.json(toJsonSafe(deps.autoRevoke.status()), 200);
  });

  app.put("/v1/session/auto-revoke", async (c) => {
    if (!deps.autoRevoke || !deps.ledger) {
      return c.json(
        { error: { message: "auto-revoke watcher is not wired" } },
        404,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!isSetAutoRevokeRequest(body)) {
      return c.json(
        { error: { message: "body must be { enabled: boolean }" } },
        400,
      );
    }
    const before = deps.autoRevoke.status();
    if (body.enabled && !before.enabled) {
      deps.autoRevoke.arm();
      await recordAutoRevokeEvent(deps.ledger, "session.auto-revoke.armed", c);
    } else if (!body.enabled && before.enabled) {
      deps.autoRevoke.disarm();
      await recordAutoRevokeEvent(deps.ledger, "session.auto-revoke.disarmed", c);
    }
    return c.json(toJsonSafe(deps.autoRevoke.status()), 200);
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

/**
 * Narrow an arbitrary JSON body to { enabled: boolean }.
 *
 * Used by PUT /v1/session/auto-revoke to reject malformed bodies
 * with 400 before flipping the runtime flag. Anything other than a
 * plain object with a boolean `enabled` field is a 400.
 */
function isSetAutoRevokeRequest(value: unknown): value is { enabled: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "enabled" in value &&
    typeof (value as { enabled: unknown }).enabled === "boolean"
  );
}

/**
 * Append a single arm/disarm audit row.
 *
 * Same swallow-the-audit policy as the console service: a failed
 * write logs a warning but does not break the route, because the
 * route's purpose is to flip a runtime flag and the trail is a
 * bookkeeping nicety.
 */
async function recordAutoRevokeEvent(
  ledger: LedgerStore,
  action: AuditAction,
  c: { get: (key: "requestId") => string | undefined },
): Promise<void> {
  const outcome: AuditOutcome = "succeeded";
  try {
    await ledger.appendAudit({
      action,
      actor: "operator",
      outcome,
      subject: null,
      requestId: c.get("requestId") ?? null,
      detail: "",
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), action },
      "auto-revoke audit write failed",
    );
  }
}
