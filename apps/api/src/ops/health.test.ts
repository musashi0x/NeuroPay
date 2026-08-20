/**
 * Coverage for readiness probes, alert derivation, and the ops service.
 *
 * The probes are asserted against the *claims* they exist to check, not
 * merely against a call succeeding: a chain id that answers but is the
 * wrong one, a `decimals()` that answers but disagrees with config, a
 * Permit2 address with no code. Each of those is a live misconfiguration
 * that otherwise only surfaces as an unexplained revert after a segment
 * has already been delivered.
 */

import { describe, expect, it, vi } from "vitest";
import { openLedgerStore } from "@neuro-pay/ledger";
import type { Address } from "@neuro-pay/types";

import {
  DEFAULT_ALERT_THRESHOLDS,
  deriveAlerts,
  overallStatus,
  runProbes,
  type Probe,
} from "./health.js";
import {
  ledgerProbe,
  permit2Probe,
  rpcProbe,
  sessionAuthorityProbe,
  settlerBalanceProbe,
  skippedProbe,
  tokenDecimalsProbe,
  type ProbeClient,
} from "./probes.js";
import { createOpsService } from "./service.js";
import { EMPTY_LEDGER_METRICS } from "@neuro-pay/ledger";

const TOKEN = "0x0000000000000000000000000000000000000abc" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const SETTLER = "0x00000000000000000000000000000000000005e7" as Address;

function client(overrides: Partial<ProbeClient> = {}): ProbeClient {
  return {
    getChainId: async () => 97,
    getCode: async () => "0x60",
    getBalance: async () => 10n ** 18n,
    readContract: async () => 18,
    ...overrides,
  };
}

async function verdict(probe: Probe) {
  const [result] = await runProbes([probe]);
  return result!;
}

describe("rpcProbe", () => {
  it("is ok when the RPC reports the configured chain", async () => {
    expect((await verdict(rpcProbe(client(), 97))).status).toBe("ok");
  });

  it("is down on a chain-id mismatch", async () => {
    const result = await verdict(
      rpcProbe(client({ getChainId: async () => 56 }), 97),
    );
    expect(result.status).toBe("down");
    expect(result.message).toContain("chain 56");
  });

  it("is down when the RPC throws", async () => {
    const result = await verdict(
      rpcProbe(
        client({
          getChainId: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
        97,
      ),
    );
    expect(result.status).toBe("down");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("is down when the RPC hangs past the deadline", async () => {
    const hanging: Probe = {
      name: "rpc",
      run: () => new Promise(() => {}),
    };
    const started = Date.now();
    const [result] = await runProbes([hanging], 20);
    expect(result?.status).toBe("down");
    expect(result?.message).toContain("timed out");
    // The point of the deadline is that the report comes back at all.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("tokenDecimalsProbe", () => {
  it("is ok when decimals match config", async () => {
    expect(
      (await verdict(tokenDecimalsProbe(client(), TOKEN, 18))).status,
    ).toBe("ok");
  });

  it("is down when the token disagrees with config", async () => {
    const result = await verdict(
      tokenDecimalsProbe(client({ readContract: async () => 6 }), TOKEN, 18),
    );
    expect(result.status).toBe("down");
    expect(result.message).toContain("reports 6 decimals");
  });
});

describe("permit2Probe", () => {
  it("is down when nothing is deployed at the address", async () => {
    const result = await verdict(
      permit2Probe(client({ getCode: async () => "0x" }), PERMIT2),
    );
    expect(result.status).toBe("down");
  });

  it("is ok when code is present", async () => {
    expect((await verdict(permit2Probe(client(), PERMIT2))).status).toBe("ok");
  });
});

describe("settlerBalanceProbe", () => {
  const floor = DEFAULT_ALERT_THRESHOLDS.settlerBalanceFloorWei;

  it("is ok above the floor", async () => {
    expect(
      (await verdict(settlerBalanceProbe(client(), SETTLER, floor))).status,
    ).toBe("ok");
  });

  it("is degraded, not down, just under the floor", async () => {
    // A settler under its floor still settles. Reporting `down` would
    // have an orchestrator pull a working instance out of rotation.
    const result = await verdict(
      settlerBalanceProbe(
        client({ getBalance: async () => floor - 1n }),
        SETTLER,
        floor,
      ),
    );
    expect(result.status).toBe("degraded");
  });

  it("is down when the account is effectively empty", async () => {
    const result = await verdict(
      settlerBalanceProbe(
        client({ getBalance: async () => 0n }),
        SETTLER,
        floor,
      ),
    );
    expect(result.status).toBe("down");
  });
});

describe("ledgerProbe", () => {
  it("reads through to a real store", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    const result = await verdict(ledgerProbe(store));
    expect(result.status).toBe("ok");
    expect(result.message).toContain("schema v");
    store.close();
  });

  it("is down when the read fails", async () => {
    const store = openLedgerStore({ storagePath: ":memory:" });
    store.close();
    // A closed store is the readable stand-in for a deleted or
    // permission-changed file: the handle exists, the read does not work.
    expect((await verdict(ledgerProbe(store))).status).toBe("down");
  });
});

describe("sessionAuthorityProbe", () => {
  it("skips when no session is provisioned", async () => {
    const result = await verdict(sessionAuthorityProbe(async () => null));
    expect(result.status).toBe("skipped");
  });

  it("is down for an expired or revoked session", async () => {
    expect(
      (await verdict(sessionAuthorityProbe(async () => "expired"))).status,
    ).toBe("down");
    expect(
      (await verdict(sessionAuthorityProbe(async () => "revoked"))).status,
    ).toBe("down");
  });

  it("is degraded when the authority read could not decide", async () => {
    expect(
      (await verdict(sessionAuthorityProbe(async () => "unknown"))).status,
    ).toBe("degraded");
  });
});

describe("overallStatus", () => {
  it("takes the worst verdict and ignores skipped", async () => {
    const checks = await runProbes([
      skippedProbe("rpc", "not configured"),
      ledgerProbe(openLedgerStore({ storagePath: ":memory:" })),
    ]);
    expect(overallStatus(checks)).toBe("ok");

    const withDegraded = await runProbes([
      skippedProbe("rpc", "not configured"),
      settlerBalanceProbe(client({ getBalance: async () => 1n }), SETTLER, 10n),
    ]);
    expect(overallStatus(withDegraded)).toBe("degraded");

    const withDown = await runProbes([
      permit2Probe(client({ getCode: async () => "0x" }), PERMIT2),
      skippedProbe("rpc", "not configured"),
    ]);
    expect(overallStatus(withDown)).toBe("down");
  });
});

function alertInputs(
  overrides: Partial<Parameters<typeof deriveAlerts>[0]> = {},
) {
  return {
    metrics: structuredClone(EMPTY_LEDGER_METRICS),
    exposure: { inFlight: 0, ceiling: 5 },
    budget: null,
    session: null,
    settlerBalanceWei: null,
    ...overrides,
  };
}

describe("deriveAlerts", () => {
  it("is silent on a healthy system", () => {
    expect(deriveAlerts(alertInputs())).toEqual([]);
  });

  it("warns on the first unrecovered failed settlement and escalates", () => {
    const metrics = structuredClone(EMPTY_LEDGER_METRICS);
    metrics.settlement.failedUnrecovered = 1;
    expect(deriveAlerts(alertInputs({ metrics }))).toEqual([
      expect.objectContaining({
        id: "failed-settlement-accumulation",
        severity: "warning",
      }),
    ]);

    metrics.settlement.failedUnrecovered =
      DEFAULT_ALERT_THRESHOLDS.failedSettlementCritical;
    expect(deriveAlerts(alertInputs({ metrics }))).toEqual([
      expect.objectContaining({
        id: "failed-settlement-accumulation",
        severity: "critical",
      }),
    ]);
  });

  it("distinguishes a low settler balance from a drained one", () => {
    const floor = DEFAULT_ALERT_THRESHOLDS.settlerBalanceFloorWei;
    expect(
      deriveAlerts(alertInputs({ settlerBalanceWei: floor - 1n })).map(
        (a) => a.id,
      ),
    ).toEqual(["settler-balance-low"]);
    expect(
      deriveAlerts(alertInputs({ settlerBalanceWei: 0n })).map((a) => a.id),
    ).toEqual(["settler-drained"]);
  });

  it("says nothing about the settler when its balance is unknown", () => {
    // Unknown and empty must not render the same. A read that failed is
    // a probe problem, not a funding problem.
    expect(deriveAlerts(alertInputs({ settlerBalanceWei: null }))).toEqual([]);
  });

  it("escalates exposure saturation from near-full to full", () => {
    expect(
      deriveAlerts(alertInputs({ exposure: { inFlight: 4, ceiling: 5 } })).map(
        (a) => a.id,
      ),
    ).toEqual(["exposure-saturation-near"]);
    expect(
      deriveAlerts(alertInputs({ exposure: { inFlight: 5, ceiling: 5 } })).map(
        (a) => a.severity,
      ),
    ).toEqual(["critical"]);
  });

  it("fires on an exhausted budget and on session lifecycle", () => {
    const budget = {
      token: TOKEN,
      tokenDecimals: 18,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T01:00:00.000Z",
      periodSeconds: 3600,
      spent: 10n,
      localLimit: 10n,
      localRemaining: 0n,
      onChainCap: 20n,
      onChainRemaining: 10n,
      exhausted: true,
    };
    expect(deriveAlerts(alertInputs({ budget })).map((a) => a.id)).toEqual([
      "budget-exhausted",
    ]);

    const session = {
      walletAddress: SETTLER,
      publicKey: `0x${"11".repeat(48)}` as const,
      status: "active" as const,
      allowedCalls: [],
      spendCap: {
        token: TOKEN,
        tokenDecimals: 18,
        limit: 10n,
        periodSeconds: 3600,
      },
      expiresAt: "2026-01-01T00:10:00.000Z",
      remainingLifetimeSeconds: 600,
      grantTransactionHash: null,
      railProvisioned: true,
    };
    expect(deriveAlerts(alertInputs({ session })).map((a) => a.id)).toEqual([
      "session-expiring",
    ]);
    expect(
      deriveAlerts(
        alertInputs({ session: { ...session, status: "revoked" as const } }),
      ).map((a) => a.severity),
    ).toEqual(["critical"]);
  });

  it("honours overridden thresholds", () => {
    const metrics = structuredClone(EMPTY_LEDGER_METRICS);
    metrics.settlement.failedUnrecovered = 2;
    expect(
      deriveAlerts({
        ...alertInputs({ metrics }),
        thresholds: { failedSettlementWarn: 3 },
      }),
    ).toEqual([]);
  });
});

describe("createOpsService", () => {
  it("reports readiness and alerts from one set of facts", async () => {
    const ledger = openLedgerStore({ storagePath: ":memory:" });
    const ops = createOpsService({
      ledger,
      probes: [skippedProbe("rpc", "not configured"), ledgerProbe(ledger)],
      exposureStats: () => ({ inFlight: 5, ceiling: 5 }),
      getBudget: async () => null,
      getSession: async () => null,
      settler: { address: SETTLER, readBalanceWei: async () => 0n },
    });

    const report = await ops.readiness();
    expect(report.status).toBe("ok");
    expect(report.checks.map((c) => c.name)).toEqual(["rpc", "ledger"]);
    expect(report.alerts.map((a) => a.id)).toEqual([
      "settler-drained",
      "exposure-saturated",
    ]);

    const metrics = await ops.metrics();
    // The two endpoints derive alerts from the same rules over the same
    // inputs, so they cannot disagree about what is firing.
    expect(metrics.alerts.map((a) => a.id)).toEqual(
      report.alerts.map((a) => a.id),
    );
    expect(metrics.exposure.saturation).toBe(1);
    expect(metrics.settler.balanceWei).toBe(0n);
    ledger.close();
  });

  it("survives a settler balance read that throws", async () => {
    const ledger = openLedgerStore({ storagePath: ":memory:" });
    const ops = createOpsService({
      ledger,
      probes: [],
      exposureStats: () => ({ inFlight: 0, ceiling: 1 }),
      getBudget: async () => null,
      getSession: async () => null,
      settler: {
        address: SETTLER,
        readBalanceWei: async () => {
          throw new Error("rpc down");
        },
      },
    });

    const metrics = await ops.metrics();
    expect(metrics.settler.balanceWei).toBeNull();
    // A failed read is not a drained account.
    expect(metrics.alerts).toEqual([]);
    ledger.close();
  });

  it("does not let a failing console read break the report", async () => {
    const ledger = openLedgerStore({ storagePath: ":memory:" });
    const ops = createOpsService({
      ledger,
      probes: [],
      exposureStats: () => ({ inFlight: 0, ceiling: 1 }),
      getBudget: async () => {
        throw new Error("session store unreadable");
      },
      getSession: vi.fn(async () => null),
    });

    const report = await ops.readiness();
    expect(report.status).toBe("ok");
    ledger.close();
  });
});
