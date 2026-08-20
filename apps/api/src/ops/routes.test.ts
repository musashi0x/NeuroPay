/**
 * Coverage for the ops HTTP surface and the Prometheus rendering.
 *
 * Two properties carry most of the weight here:
 *
 * 1. **`/ready` is open and says nothing.** It is the one route on this
 *    router without a token, so what it publishes is what an
 *    unauthenticated caller learns. The test pins the exact shape rather
 *    than a sample, because the failure mode is someone widening it to
 *    "just include the messages, they're only diagnostics".
 * 2. **Everything else 401s.** Metrics, detailed health, and the audit
 *    trail all name internal configuration.
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore } from "@neuro-pay/ledger";
import { EMPTY_LEDGER_METRICS } from "@neuro-pay/ledger";

import type { AuditEvent } from "@neuro-pay/types";

import { createApp } from "../app.js";
import { MIN_TOKEN_LENGTH } from "../auth.js";
import { renderPrometheus } from "./prometheus.js";
import type { MetricsSnapshot, OpsService } from "./service.js";
import type { ReadinessReport } from "./health.js";

const TOKEN = `t${"o".repeat(MIN_TOKEN_LENGTH)}`;
const enforced = { kind: "enforced", token: TOKEN } as const;

function report(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    status: "ok",
    checkedAt: "2026-01-01T00:00:00.000Z",
    checks: [
      {
        name: "rpc",
        status: "ok",
        message: "chain 97 via https://rpc.internal.example",
        durationMs: 12,
      },
      {
        name: "settler-balance",
        status: "degraded",
        message: "settler 0xabc below floor",
        durationMs: 8,
      },
    ],
    alerts: [
      {
        id: "settler-balance-low",
        severity: "warning",
        summary: "The settler account is below its configured balance floor.",
      },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    collectedAt: "2026-01-01T00:00:00.000Z",
    ledger: structuredClone(EMPTY_LEDGER_METRICS),
    schema: { version: 3, latest: 3 },
    exposure: { inFlight: 0, ceiling: 4, saturation: 0 },
    budget: null,
    session: null,
    settler: { address: null, balanceWei: null },
    alerts: [],
    ...overrides,
  };
}

function opsDeps(overrides: Partial<ReadinessReport> = {}) {
  const ledger = openLedgerStore({ storagePath: ":memory:" });
  const ops: OpsService = {
    readiness: async () => report(overrides),
    metrics: async () => snapshot(),
  };
  return { deps: { ops, ledger }, ledger };
}

describe("GET /ready", () => {
  it("needs no token and publishes names and verdicts only", async () => {
    const { deps, ledger } = opsDeps();
    const app = createApp({ ops: deps, consoleAuth: enforced });

    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checkedAt: "2026-01-01T00:00:00.000Z",
      checks: [
        { name: "rpc", status: "ok" },
        { name: "settler-balance", status: "degraded" },
      ],
    });
    // No probe messages, no alert text, no addresses, no RPC host.
    const text = JSON.stringify(body);
    expect(text).not.toContain("rpc.internal.example");
    expect(text).not.toContain("0xabc");
    expect(text).not.toContain("below floor");
    ledger.close();
  });

  it("answers 200 while degraded and 503 only when down", async () => {
    const degraded = opsDeps({ status: "degraded" });
    const degradedApp = createApp({ ops: degraded.deps });
    // A degraded process still serves correct traffic; taking it out of
    // rotation over a warning is worse than leaving it in.
    expect((await degradedApp.request("/ready")).status).toBe(200);
    degraded.ledger.close();

    const down = opsDeps({ status: "down" });
    const downApp = createApp({ ops: down.deps });
    expect((await downApp.request("/ready")).status).toBe(503);
    down.ledger.close();
  });
});

describe("operator ops routes are guarded", () => {
  const paths = ["/v1/health", "/metrics", "/v1/metrics", "/v1/audit"] as const;

  for (const path of paths) {
    it(`401s GET ${path} without a token`, async () => {
      const { deps, ledger } = opsDeps();
      const app = createApp({ ops: deps, consoleAuth: enforced });
      const res = await app.request(path);
      expect(res.status).toBe(401);
      ledger.close();
    });

    it(`401s GET ${path} with the wrong token`, async () => {
      const { deps, ledger } = opsDeps();
      const app = createApp({ ops: deps, consoleAuth: enforced });
      const res = await app.request(path, {
        headers: { Authorization: `Bearer ${"x".repeat(MIN_TOKEN_LENGTH)}` },
      });
      expect(res.status).toBe(401);
      ledger.close();
    });
  }
});

describe("GET /v1/health", () => {
  it("returns the full report to an authenticated operator", async () => {
    const { deps, ledger } = opsDeps();
    const app = createApp({ ops: deps, consoleAuth: enforced });
    const res = await app.request("/v1/health", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessReport;
    expect(body.checks[0]?.message).toContain("chain 97");
    expect(body.alerts[0]?.id).toBe("settler-balance-low");
    ledger.close();
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus exposition with the right content type", async () => {
    const { deps, ledger } = opsDeps();
    const app = createApp({ ops: deps, consoleAuth: enforced });
    const res = await app.request("/metrics", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("# TYPE neuropay_ledger_entries_total counter");
    ledger.close();
  });
});

describe("GET /v1/audit", () => {
  it("returns the trail and honours the action filter", async () => {
    const { deps, ledger } = opsDeps();
    await ledger.appendAudit({
      action: "process.started",
      actor: "system",
      outcome: "succeeded",
    });
    await ledger.appendAudit({
      action: "session.revoke.requested",
      actor: "operator",
      outcome: "succeeded",
      subject: "0xabc",
      requestId: "req-1",
    });

    const app = createApp({ ops: deps, consoleAuth: enforced });
    const all = (await (
      await app.request("/v1/audit", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { events: AuditEvent[] };
    expect(all.events).toHaveLength(2);

    const filtered = (await (
      await app.request("/v1/audit?action=session.revoke.requested", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { events: AuditEvent[] };
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]?.requestId).toBe("req-1");
    ledger.close();
  });

  it("rejects a malformed limit rather than silently ignoring it", async () => {
    const { deps, ledger } = opsDeps();
    const app = createApp({ ops: deps, consoleAuth: enforced });
    const res = await app.request("/v1/audit?limit=nope", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    ledger.close();
  });
});

describe("renderPrometheus", () => {
  it("emits one HELP and TYPE per family with labelled samples", () => {
    const ledger = structuredClone(EMPTY_LEDGER_METRICS);
    ledger.verification.byClassification = { "budget-exhausted": 2 };
    ledger.settlement.confirmed = 3;
    ledger.settlement.latency = {
      count: 3,
      p50Ms: 1500,
      p95Ms: 4000,
      maxMs: 4000,
    };

    const text = renderPrometheus(snapshot({ ledger }));
    expect(text).toContain("# TYPE neuropay_settlements_total counter");
    expect(text).toContain('neuropay_settlements_total{state="confirmed"} 3');
    expect(text).toContain(
      'neuropay_payment_failures_total{classification="budget-exhausted"} 2',
    );
    // Seconds, not milliseconds — the ecosystem's dashboards assume it.
    expect(text).toContain(
      'neuropay_settlement_latency_seconds{quantile="0.5"} 1.5',
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("omits a metric whose value is unknown rather than emitting zero", () => {
    // "We could not read the settler balance" and "the settler is empty"
    // must not render identically.
    const unknown = renderPrometheus(snapshot());
    expect(unknown).not.toContain("neuropay_settler_balance_wei");

    const known = renderPrometheus(
      snapshot({ settler: { address: "0xabc", balanceWei: 0n } }),
    );
    expect(known).toContain("neuropay_settler_balance_wei 0");
  });

  it("omits the latency family entirely with no observations", () => {
    const text = renderPrometheus(snapshot());
    expect(text).not.toContain("neuropay_settlement_latency_seconds{");
    expect(text).toContain("neuropay_settlement_latency_observations 0");
  });

  it("emits one series per session status so no lookup table is needed", () => {
    const text = renderPrometheus(
      snapshot({
        session: {
          walletAddress: "0x0000000000000000000000000000000000000001",
          publicKey: `0x${"11".repeat(48)}`,
          status: "revoked",
          allowedCalls: [],
          spendCap: {
            token: "0x0000000000000000000000000000000000000002",
            tokenDecimals: 18,
            limit: 10n,
            periodSeconds: 3600,
          },
          expiresAt: "2026-01-01T00:00:00.000Z",
          remainingLifetimeSeconds: 0,
          grantTransactionHash: null,
          railProvisioned: true,
        },
      }),
    );
    expect(text).toContain('neuropay_session_status{status="revoked"} 1');
    expect(text).toContain('neuropay_session_status{status="active"} 0');
  });

  it("escapes label values that would break the exposition format", () => {
    const text = renderPrometheus(
      snapshot({
        alerts: [
          { id: 'weird"id', severity: "warning", summary: "line\nbreak" },
        ],
      }),
    );
    expect(text).toContain(
      'neuropay_alert{id="weird\\"id",severity="warning"} 1',
    );
  });
});
