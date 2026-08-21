/**
 * Operations HTTP surface.
 *
 *   GET /ready       — unauthenticated readiness, names and verdicts only
 *   GET /v1/health   — operator readiness with probe detail and alerts
 *   GET /metrics     — Prometheus exposition
 *   GET /v1/audit    — the administrative audit trail
 *
 * ## Why `/ready` is split from `/v1/health`
 *
 * A readiness endpoint has to be reachable by whatever decides to send
 * traffic to this process — a load balancer, a container orchestrator, a
 * uptime check — and those callers usually cannot hold a bearer token.
 * But the useful version of the report names the configured RPC host,
 * the token contract, the settler address, and why each probe is
 * unhappy, and none of that belongs on an open port.
 *
 * So the same probes render twice. `/ready` publishes the shape of the
 * answer — which dependencies exist and whether each is healthy — which
 * is what a scheduler needs and is already inferable from the service
 * being up at all. `/v1/health` publishes the diagnosis, behind the
 * operator token.
 */

import { Hono } from "hono";
import type { AuditAction } from "@neuro-pay/types";

import { toJsonSafe } from "../json.js";
import type { LedgerStore } from "@neuro-pay/ledger";
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from "./prometheus.js";
import type { OpsService } from "./service.js";

export type ReadinessRouteDeps = {
  ops: Pick<OpsService, "readiness">;
  /**
   * Optional hook the readiness route uses to surface whether the
   * auto-revoke-on-failure safety net is armed. When absent, the
   * `autoRevokeArmed` field is omitted (older deployments that
   * don't wire the watcher do not gain a new field).
   */
  isAutoRevokeArmed?: () => boolean;
};

export type OpsRouteDeps = {
  ops: OpsService;
  ledger: Pick<LedgerStore, "auditEvents">;
  isAutoRevokeArmed?: () => boolean;
};

/**
 * HTTP status for a readiness verdict.
 *
 * `degraded` answers 200 deliberately. A degraded process still serves
 * correct traffic — a settler under its balance floor settles fine until
 * it does not — and answering 503 would have an orchestrator pull a
 * working instance out of rotation over a warning. `down` is the case
 * where sending traffic here produces failures, so it takes the 503.
 */
function statusCode(status: "ok" | "degraded" | "down"): 200 | 503 {
  return status === "down" ? 503 : 200;
}

export function readinessRoute(deps: ReadinessRouteDeps): Hono {
  const app = new Hono();

  app.get("/ready", async (c) => {
    const report = await deps.ops.readiness();
    // The redacted `/ready` shape still surfaces whether the
    // auto-revoke safety net is armed, because "armed but never
    // fired" is the state an operator wants to confirm after
    // arming. The boolean travels without a probe message or
    // address — it is configuration, not diagnosis.
    const body: Record<string, unknown> = {
      status: report.status,
      checkedAt: report.checkedAt,
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
      })),
    };
    if (deps.isAutoRevokeArmed) {
      body.autoRevokeArmed = deps.isAutoRevokeArmed();
    }
    return c.json(body, statusCode(report.status));
  });

  return app;
}

export function opsRoutes(deps: OpsRouteDeps): Hono {
  const app = new Hono();

  app.get("/v1/health", async (c) => {
    const report = await deps.ops.readiness();
    const body: Record<string, unknown> = { ...report };
    if (deps.isAutoRevokeArmed) {
      body.autoRevokeArmed = deps.isAutoRevokeArmed();
    }
    return c.json(toJsonSafe(body), statusCode(report.status));
  });

  app.get("/metrics", async (c) => {
    const snapshot = await deps.ops.metrics();
    return c.text(renderPrometheus(snapshot), 200, {
      "Content-Type": PROMETHEUS_CONTENT_TYPE,
    });
  });

  // JSON twin of `/metrics`, for the console and for anyone who would
  // rather not parse the exposition format to answer one question.
  app.get("/v1/metrics", async (c) => {
    return c.json(toJsonSafe(await deps.ops.metrics()), 200);
  });

  app.get("/v1/audit", async (c) => {
    const action = c.req.query("action");
    const limitRaw = c.req.query("limit");
    const limit =
      limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return c.json(
        { error: { message: "limit must be a positive integer" } },
        400,
      );
    }
    const events = await deps.ledger.auditEvents({
      ...(action ? { action: action as AuditAction } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(toJsonSafe({ events }), 200);
  });

  return app;
}
