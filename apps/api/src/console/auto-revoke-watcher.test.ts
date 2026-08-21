import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import { SessionStore } from "@neuro-pay/altana";
import type {
  AutoRevokeOnFailureView,
  RevokeResult,
  SessionPolicyView,
} from "@neuro-pay/types";
import { createAutoRevokeWatcher } from "./auto-revoke-watcher.js";
import type { ConsoleService } from "./service.js";
import type { MetricsSnapshot, OpsService } from "../ops/service.js";

const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FAILED_THRESHOLD = 5;

/**
 * Build the watcher's inputs with a controllable unrecovered count.
 *
 * `ops.metrics()` returns whatever `setUnrecoveredCount()` last set;
 * the ledger is a real in-memory store so `appendAudit` works (and
 * we can assert on it after a fire). The console service is a stub
 * that records every `revoke` call so the test can assert how many
 * times the kill switch ran.
 */
function harness(opts?: { count?: number; ledger?: LedgerStore }) {
  let unrecovered = opts?.count ?? 0;
  const setUnrecoveredCount = (n: number): void => {
    unrecovered = n;
  };

  const ledger = opts?.ledger ?? openLedgerStore({ storagePath: ":memory:" });
  const ops: OpsService = {
    metrics: async (): Promise<MetricsSnapshot> =>
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
            failedUnrecovered: unrecovered,
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
      }) as unknown as MetricsSnapshot,
    readiness: async () => {
      throw new Error("not used in this test");
    },
  };

  const sessions = new SessionStore({ fileStorePath: ":memory:" });
  sessions.save({
    walletAddress: WALLET,
    publicKey: ("0x04" + "ab".repeat(64)) as `0x${string}`,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    permissions: {
      calls: [],
      spend: [],
    },
    railProvisioned: true,
    grantTransactionHash: null,
    createdAt: 0,
  });

  const revokeCalls: RevokeResult[] = [];
  const consoleService: ConsoleService = {
    getSession: async (): Promise<SessionPolicyView | null> => null,
    listStreams: async () => ({ items: [], nextCursor: null }),
    listPayments: async () => ({ items: [], nextCursor: null }),
    getBudget: async () => null,
    snapshot: async () => ({
      session: null,
      streams: [],
      budget: null,
      payments: [],
    }),
    revoke: async (): Promise<RevokeResult> => {
      const result: RevokeResult = {
        local: { revoked: true },
        onChain: { revoked: true, status: null, transactionHash: null },
      };
      revokeCalls.push(result);
      // Simulate the real console service: remove the session from
      // the store after a successful revoke, so a second fire has no
      // session to act on and is treated as a no-op.
      sessions.remove(WALLET);
      return result;
    },
    retryRevoke: async (): Promise<RevokeResult> => {
      throw new Error("not used in this test");
    },
    retrySettlement: async () => {
      throw new Error("not used in this test");
    },
    subscribe: () => () => {},
    notify: () => {},
    close: () => {},
    registerSseAbort: () => () => {},
  };

  return {
    ledger,
    sessions,
    ops,
    consoleService,
    revokeCalls,
    setUnrecoveredCount,
  };
}

describe("createAutoRevokeWatcher", () => {
  let ledger: LedgerStore;

  beforeEach(() => {
    ledger = openLedgerStore({ storagePath: ":memory:" });
  });

  afterEach(() => {
    ledger.close();
  });

  it("starts disarmed with a null lastFiredAt", () => {
    const h = harness({ ledger });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    const status: AutoRevokeOnFailureView = watcher.status();
    expect(status.enabled).toBe(false);
    expect(status.lastFiredAt).toBeNull();
    watcher.close();
  });

  it("arm flips the flag and disarm flips it back", () => {
    const h = harness({ ledger });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    expect(watcher.status().enabled).toBe(true);
    watcher.disarm();
    expect(watcher.status().enabled).toBe(false);
    watcher.close();
  });

  it("does not fire when count is below the threshold", async () => {
    const h = harness({ ledger, count: 3 });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(0);
    expect(watcher.status().lastFiredAt).toBeNull();
    watcher.close();
  });

  it("does not fire when count crosses but flag is disarmed", async () => {
    const h = harness({ ledger, count: FAILED_THRESHOLD });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(0);
    expect(watcher.status().lastFiredAt).toBeNull();
    watcher.close();
  });

  it("fires the kill switch exactly once on threshold crossing", async () => {
    const h = harness({ ledger, count: FAILED_THRESHOLD - 1 });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    // First tick: count is below threshold; nothing fires.
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(0);
    // Second tick: count crosses; kill switch fires.
    h.setUnrecoveredCount(FAILED_THRESHOLD);
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(1);
    expect(watcher.status().lastFiredAt).not.toBeNull();
    // Third tick: count stays above threshold; latch suppresses.
    h.setUnrecoveredCount(FAILED_THRESHOLD + 3);
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(1);
    watcher.close();
  });

  it("latch releases when the count drops back below the threshold", async () => {
    const h = harness({ ledger, count: FAILED_THRESHOLD - 1 });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    h.setUnrecoveredCount(FAILED_THRESHOLD);
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(1);
    // The real console service removes the session on a successful
    // revoke. Re-establish a session so the next crossing has a
    // wallet to act on — that is the shape "a fresh session was
    // granted after the first revoke".
    h.sessions.save({
      walletAddress: WALLET,
      publicKey: ("0x04" + "ab".repeat(64)) as `0x${string}`,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      permissions: { calls: [], spend: [] },
      railProvisioned: true,
      grantTransactionHash: null,
      createdAt: 0,
    });
    h.setUnrecoveredCount(FAILED_THRESHOLD - 1);
    await watcher.evaluate();
    h.setUnrecoveredCount(FAILED_THRESHOLD);
    await watcher.evaluate();
    // Two crossings = two fires.
    expect(h.revokeCalls).toHaveLength(2);
    watcher.close();
  });

  it("records a fired audit entry with the trigger context", async () => {
    const h = harness({ ledger, count: FAILED_THRESHOLD });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    await watcher.evaluate();
    const events = await ledger.auditEvents({
      action: "session.auto-revoke.fired",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system");
    expect(events[0]?.detail).toContain(`count=${FAILED_THRESHOLD}`);
    expect(events[0]?.detail).toContain(`threshold=${FAILED_THRESHOLD}`);
    expect(events[0]?.detail).toContain(`wallet=${WALLET}`);
    expect(events[0]?.outcome).toBe("succeeded");
    watcher.close();
  });

  it("does not fire when there is no active session", async () => {
    const h = harness({ ledger, count: FAILED_THRESHOLD });
    // Wipe the session the harness saved so activeWallet() returns
    // undefined and the watcher should refuse to fire.
    while (h.sessions.list().length > 0) {
      for (const wallet of h.sessions.list()) h.sessions.remove(wallet);
    }
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      sweepIntervalMs: 60_000,
    });
    watcher.arm();
    await watcher.evaluate();
    expect(h.revokeCalls).toHaveLength(0);
    watcher.close();
  });

  it("close clears the timer and stops the watcher", async () => {
    const h = harness({ ledger, count: 0 });
    const watcher = createAutoRevokeWatcher({
      ledger: h.ledger,
      sessions: h.sessions,
      consoleService: h.consoleService,
      ops: h.ops,
      failedSettlementCritical: FAILED_THRESHOLD,
      // A very short interval so the test can observe the timer
      // firing at least once if close() did not stop it. The test
      // will count revoke calls; close() before the count crosses
      // should leave it at 0.
      sweepIntervalMs: 10,
    });
    watcher.arm();
    watcher.close();
    // Wait a tick so any in-flight interval would have fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.revokeCalls).toHaveLength(0);
    expect(watcher.status().enabled).toBe(false);
  });
});
