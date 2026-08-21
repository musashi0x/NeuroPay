import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";

import { createApp } from "../app.js";
import { createConsoleService } from "./service.js";
import { createAutoRevokeWatcher } from "./auto-revoke-watcher.js";
import type { AutoRevokeOnFailureView } from "@neuro-pay/types";

const TOKEN = `t${"o".repeat(40)}`;
const enforced = { kind: "enforced", token: TOKEN } as const;

function makeHarness() {
  const ledger = openLedgerStore({ storagePath: ":memory:" });
  const consoleService = createConsoleService({
    config: {
      chain: {
        chainId: 97,
        rpcUrl: "https://example.invalid",
        token: "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd" as `0x${string}`,
        tokenDecimals: 18,
        tokenSymbol: "npUSD",
        payTo: "0x000000000000000000000000000000000000d3ad" as `0x${string}`,
      },
      secrets: {
        settlerPrivateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
        adminPrivateKey: null,
      },
      session: {
        lifetimeSeconds: 86_400,
        spendCap: 50n * 10n ** 18n,
        spendPeriodSeconds: 86_400,
      },
      metering: {
        budgetMargin: 0.2,
        settlementThreshold: 10n ** 16n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 3,
      },
    },
    sessions: {
      list: () => [],
      read: () => undefined,
      save: () => {},
      remove: () => true,
    } as never,
    ledger,
    now: () => Date.parse("2026-08-17T12:00:00.000Z"),
  });
  const opsService = {
    metrics: async () =>
      ({
        collectedAt: new Date(0).toISOString(),
        ledger: {
          payment: { demanded: 0, signed: 0, verified: 0, rejected: 0 },
          settlement: {
            submitted: 0,
            confirmed: 0,
            failed: 0,
            lost: 0,
            retried: 0,
            recovered: 0,
            inFlight: 0,
            failedUnrecovered: 0,
            latency: { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 },
          },
          stream: { opened: 0, ended: 0, abandoned: 0 },
        },
        schema: { version: 1, latest: 1 },
        exposure: { inFlight: 0, ceiling: 0, saturation: 0 },
        budget: null,
        session: null,
        settler: { address: null, balanceWei: null },
        alerts: [],
      }) as never,
    readiness: async () =>
      ({
        status: "ok" as const,
        checkedAt: new Date(0).toISOString(),
        checks: [],
        alerts: [],
      }) as never,
  };
  const watcher = createAutoRevokeWatcher({
    ledger,
    sessions: {
      list: () => [],
      read: () => undefined,
      save: () => {},
      remove: () => true,
    } as never,
    consoleService,
    ops: opsService as never,
    failedSettlementCritical: 5,
    sweepIntervalMs: 60_000,
  });
  const app = createApp({
    console: consoleService,
    ops: { ops: opsService as never, ledger },
    ledger,
    autoRevoke: watcher,
    consoleAuth: enforced,
  });
  return { app, watcher, ledger };
}

describe("auto-revoke operator routes", () => {
  let ledger: LedgerStore;
  let watcher: ReturnType<typeof createAutoRevokeWatcher>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const h = makeHarness();
    ledger = h.ledger;
    watcher = h.watcher;
    app = h.app;
  });

  afterEach(() => {
    watcher.close();
    ledger.close();
  });

  it("GET returns the disarmed default state on a fresh watcher", async () => {
    const res = await app.request("/v1/session/auto-revoke", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoRevokeOnFailureView;
    expect(body.enabled).toBe(false);
    expect(body.lastFiredAt).toBeNull();
  });

  it("GET 401s without the operator token", async () => {
    const res = await app.request("/v1/session/auto-revoke");
    expect(res.status).toBe(401);
  });

  it("PUT with enabled=true arms the flag and records an audit entry", async () => {
    const res = await app.request("/v1/session/auto-revoke", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoRevokeOnFailureView;
    expect(body.enabled).toBe(true);

    const events = await ledger.auditEvents({
      action: "session.auto-revoke.armed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("operator");
    expect(watcher.status().enabled).toBe(true);
  });

  it("PUT with enabled=false disarms the flag and records an audit entry", async () => {
    watcher.arm();
    const res = await app.request("/v1/session/auto-revoke", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoRevokeOnFailureView;
    expect(body.enabled).toBe(false);

    const events = await ledger.auditEvents({
      action: "session.auto-revoke.disarmed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("operator");
    expect(watcher.status().enabled).toBe(false);
  });

  it("PUT is a no-op when the state is already in the requested value", async () => {
    // Already disarmed by default; PUT with enabled=false again
    // should NOT write a new audit row.
    const res = await app.request("/v1/session/auto-revoke", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const events = await ledger.auditEvents();
    expect(events).toHaveLength(0);
  });

  it("PUT 400s on a malformed body", async () => {
    const res = await app.request("/v1/session/auto-revoke", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT 401s without the operator token", async () => {
    const res = await app.request("/v1/session/auto-revoke", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(401);
  });
});
