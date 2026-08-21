import { describe, expect, it } from "vitest";
import { openLedgerStore, recordPaymentSigned } from "@neuro-pay/ledger";
import { SessionStore } from "@neuro-pay/altana";
import type { Address, AppConfig, Hex } from "@neuro-pay/types";
import type { PersistedSession } from "@neuro-pay/altana";
import { createSeller } from "../seller/index.js";
import { createInMemorySettler } from "../seller/settle.js";
import { IS_VALID_SIGNATURE_MAGIC } from "../seller/verify.js";
import { createApp } from "../app.js";
import { reviveBigints, toJsonSafe } from "../json.js";
import {
  createConsoleService,
  type CreateConsoleServiceInput,
} from "./service.js";

const TOKEN = "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd" as Address;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const PUBKEY = ("0x04" + "ab".repeat(64)) as Hex;
const FIFTY = 50n * 10n ** 18n;

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function config(): AppConfig {
  return {
    chain: {
      chainId: 97,
      rpcUrl: "https://example.invalid",
      token: TOKEN,
      tokenDecimals: 18,
      tokenSymbol: "npUSD",
      payTo: "0x000000000000000000000000000000000000d3ad" as Address,
    },
    secrets: {
      settlerPrivateKey: ("0x" + "11".repeat(32)) as Hex,
      adminPrivateKey: null,
    },
    session: {
      lifetimeSeconds: 86_400,
      spendCap: FIFTY,
      spendPeriodSeconds: 86_400,
    },
    metering: {
      budgetMargin: 0.2,
      settlementThreshold: 10n ** 16n,
      tickIntervalSeconds: 60,
      maxInFlightSettlements: 3,
    },
  };
}

function session(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    walletAddress: WALLET,
    publicKey: PUBKEY,
    permissions: {
      calls: [
        {
          signature: "transfer(address,uint256)",
          to: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
        },
      ],
      spend: [{ limit: FIFTY, period: "day", token: TOKEN }],
    },
    expiry: Math.floor(NOW / 1000) + 3_600,
    grantTransactionHash: ("0x" + "22".repeat(32)) as Hex,
    railProvisioned: true,
    createdAt: Math.floor(NOW / 1000) - 60,
    ...overrides,
  };
}

function harness(
  overrides: Partial<
    Pick<CreateConsoleServiceInput, "performRevoke" | "performRetryRevoke">
  > = {},
) {
  const cfg = config();
  const sessions = new SessionStore();
  sessions.save(session());
  const ledger = openLedgerStore({ storagePath: ":memory:" });
  const seller = createSeller({
    config: {
      metering: cfg.metering,
      payTo: cfg.chain.payTo,
      settlerAddress: cfg.chain.payTo,
      chainId: cfg.chain.chainId,
      token: cfg.chain.token,
      tokenDecimals: cfg.chain.tokenDecimals,
    },
    store: ledger,
    verifier: async () => IS_VALID_SIGNATURE_MAGIC,
    settler: createInMemorySettler({ defaultBehavior: "confirm" }),
    now: () => new Date(NOW).toISOString(),
    initialPriceSheet: {
      perCall: 100n,
      perSecond: 10n,
      perUnit: 1n,
      unitName: "token",
    },
  });
  const consoleService = createConsoleService({
    config: cfg,
    sessions,
    ledger,
    seller,
    now: () => NOW,
    ...overrides,
  });
  // The auto-revoke watcher is wired through runtime.ts in production;
  // tests of the console API don't exercise the watcher, so a stub
  // with the same shape is enough to satisfy the deps check.
  const autoRevoke = {
    arm: () => {},
    disarm: () => {},
    status: () => ({ enabled: false, lastFiredAt: null }),
    evaluate: async () => {},
    close: () => {},
  };
  const app = createApp({
    console: consoleService,
    seller,
    ledger,
    autoRevoke,
    corsOrigin: "http://localhost:3000",
  });
  return { app, consoleService, seller, sessions, ledger, autoRevoke, cfg };
}

describe("console API", () => {
  it("returns the session policy without key material", async () => {
    const { app } = harness();
    const response = await app.request("/v1/session");
    expect(response.status).toBe(200);
    const body = reviveBigints(await response.json()) as {
      walletAddress: string;
      publicKey: string;
      spendCap: { limit: bigint; periodSeconds: number; tokenSymbol: string };
      remainingLifetimeSeconds: number;
      allowedCalls: { to: string }[];
    };
    expect(body.walletAddress).toBe(WALLET);
    expect(body.publicKey).toBe(PUBKEY);
    expect(body.spendCap.limit).toBe(FIFTY);
    expect(body.spendCap.tokenSymbol).toBe("npUSD");
    expect(body.spendCap.periodSeconds).toBe(86_400);
    expect(body.remainingLifetimeSeconds).toBe(3_600);
    expect(body.allowedCalls[0]?.to).toMatch(/^0x/);
    const raw = JSON.stringify(toJsonSafe(body));
    expect(raw).not.toMatch(/privateKey/i);
    expect(raw).not.toMatch(/settlerPrivateKey/);
    expect(raw).not.toMatch(/adminPrivateKey/);
  });

  it("lists an opened stream with pinned prices and tick remaining", async () => {
    const { app, seller } = harness();
    seller.openStream({ requestUrl: "http://localhost:4000/v1/streams" });
    const response = await app.request("/v1/streams");
    expect(response.status).toBe(200);
    const body = reviveBigints(await response.json()) as {
      streams: Array<{
        status: string;
        tokenSymbol: string;
        priceSheet: { perCall: bigint };
        secondsUntilNextTick: number;
        accruedUnpaid: bigint;
      }>;
      nextCursor: string | null;
    };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.status).toBe("active");
    expect(body.streams[0]?.tokenSymbol).toBe("npUSD");
    expect(body.streams[0]?.priceSheet.perCall).toBe(100n);
    expect(body.streams[0]?.secondsUntilNextTick).toBe(60);
    expect(body.streams[0]?.accruedUnpaid).toBe(0n);
  });

  it("returns payment history from the ledger", async () => {
    const { app, ledger } = harness();
    await recordPaymentSigned({
      store: ledger,
      ctx: {
        streamId: "stream-1",
        sessionPublicKey: PUBKEY,
        chainId: 97,
        token: TOKEN,
        tokenDecimals: 18,
      },
      amount: 10n ** 16n,
      nonce: "1",
    });
    const response = await app.request("/v1/payments");
    const body = reviveBigints(await response.json()) as {
      payments: Array<{ event: string; amount: bigint; nonce: string }>;
    };
    expect(body.payments.some((p) => p.event === "payment.signed")).toBe(true);
    expect(body.payments[0]?.amount).toBe(10n ** 16n);
    expect(body.payments[0]?.nonce).toBe("1");
  });

  it("paginates payments newest-first", async () => {
    const { app, ledger } = harness();
    for (const nonce of ["1", "2", "3"]) {
      await recordPaymentSigned({
        store: ledger,
        ctx: {
          streamId: "stream-1",
          sessionPublicKey: PUBKEY,
          chainId: 97,
          token: TOKEN,
          tokenDecimals: 18,
        },
        amount: 10n ** 16n,
        nonce,
      });
    }
    const first = reviveBigints(
      await (await app.request("/v1/payments?limit=2")).json(),
    ) as {
      payments: Array<{ nonce: string }>;
      nextCursor: string | null;
    };
    expect(first.payments).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = reviveBigints(
      await (
        await app.request(`/v1/payments?limit=2&cursor=${first.nextCursor}`)
      ).json(),
    ) as {
      payments: Array<{ nonce: string }>;
      nextCursor: string | null;
    };
    const ids = [...first.payments, ...second.payments].map((p) => p.nonce);
    expect(new Set(ids).size).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it("reports shutdown leftovers as abandoned, not ended", async () => {
    const { app, seller } = harness();
    seller.openStream({ requestUrl: "http://localhost:4000/v1/streams" });
    await seller.shutdown();
    const body = reviveBigints(
      await (await app.request("/v1/streams?status=abandoned")).json(),
    ) as { streams: Array<{ status: string; endReason: string | null }> };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.status).toBe("abandoned");
    expect(body.streams[0]?.endReason).toBe("abandoned");
  });

  it("binds the console to the lexicographically first wallet", async () => {
    const { app, sessions } = harness();
    const later = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    sessions.save(
      session({
        walletAddress: later,
        publicKey: ("0x04" + "cd".repeat(64)) as Hex,
      }),
    );
    const body = (await (await app.request("/v1/session")).json()) as {
      walletAddress: string;
    };
    expect(body.walletAddress).toBe(WALLET);
    expect(WALLET < later).toBe(true);
  });

  it("reports local budget and on-chain cap separately", async () => {
    const { app } = harness();
    const response = await app.request("/v1/budget");
    expect(response.status).toBe(200);
    const body = reviveBigints(await response.json()) as {
      localLimit: bigint;
      onChainCap: bigint;
      localRemaining: bigint;
      onChainRemaining: bigint;
      exhausted: boolean;
    };
    expect(body.onChainCap).toBe(FIFTY);
    expect(body.localLimit).toBe(40n * 10n ** 18n);
    expect(body.localRemaining).toBe(body.localLimit);
    expect(body.onChainRemaining).toBe(body.onChainCap);
    expect(body.exhausted).toBe(false);
  });

  it("revokes locally first and reports both stages", async () => {
    const { app, seller, sessions } = harness();
    seller.openStream({ requestUrl: "http://localhost:4000/v1/streams" });
    const response = await app.request("/v1/session/revoke", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      local: { revoked: boolean };
      onChain: { revoked: boolean; status: string | null };
    };
    expect(body.local.revoked).toBe(true);
    expect(body.onChain.revoked).toBe(false);
    expect(sessions.list()).toHaveLength(0);
    const streams = (await (await app.request("/v1/streams")).json()) as {
      streams: Array<{ status: string; endReason: string }>;
    };
    expect(streams.streams[0]?.status).toBe("ended");
    expect(streams.streams[0]?.endReason).toBe("session-revoked");
  });

  it("reports on-chain revoke success from a wired performRevoke", async () => {
    const { app, sessions } = harness({
      performRevoke: async (persisted) => ({
        local: { revoked: sessions.remove(persisted.walletAddress) },
        onChain: {
          revoked: true,
          status: "CONFIRMED",
          transactionHash: ("0x" + "44".repeat(32)) as Hex,
        },
      }),
    });
    const response = await app.request("/v1/session/revoke", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      local: { revoked: boolean };
      onChain: { revoked: boolean; status: string | null };
    };
    expect(body.local.revoked).toBe(true);
    expect(body.onChain.revoked).toBe(true);
    expect(body.onChain.status).toBe("CONFIRMED");
    expect(sessions.list()).toHaveLength(0);
  });

  it("reports on-chain revoke failure distinctly from local success", async () => {
    const { app, sessions } = harness({
      performRevoke: async (persisted) => ({
        local: { revoked: sessions.remove(persisted.walletAddress) },
        onChain: { revoked: false, status: "FAILED", transactionHash: null },
      }),
    });
    const response = await app.request("/v1/session/revoke", {
      method: "POST",
    });
    const body = (await response.json()) as {
      local: { revoked: boolean };
      onChain: { revoked: boolean; status: string | null };
    };
    expect(body.local.revoked).toBe(true);
    expect(body.onChain.revoked).toBe(false);
    expect(body.onChain.status).toBe("FAILED");
    expect(sessions.list()).toHaveLength(0);
  });

  it("retries a failed on-chain revoke against the cached snapshot and clears it on success", async () => {
    let attempts = 0;
    const { app, sessions } = harness({
      performRevoke: async (persisted) => ({
        local: { revoked: sessions.remove(persisted.walletAddress) },
        onChain: { revoked: false, status: "FAILED", transactionHash: null },
      }),
      performRetryRevoke: async () => {
        attempts += 1;
        return {
          local: { revoked: true },
          onChain: {
            revoked: true,
            status: "CONFIRMED",
            transactionHash: ("0x" + "55".repeat(32)) as Hex,
          },
        };
      },
    });

    await app.request("/v1/session/revoke", { method: "POST" });
    const retryResponse = await app.request("/v1/session/revoke/retry", {
      method: "POST",
    });
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      onChain: { revoked: boolean; status: string | null };
    };
    expect(attempts).toBe(1);
    expect(retryBody.onChain.revoked).toBe(true);
    expect(retryBody.onChain.status).toBe("CONFIRMED");
    expect(sessions.list()).toHaveLength(0);

    // Retrying again with nothing pending 404s rather than re-submitting.
    const secondRetry = await app.request("/v1/session/revoke/retry", {
      method: "POST",
    });
    expect(secondRetry.status).toBe(404);
    expect(attempts).toBe(1);
  });

  it("404s a retry when there is nothing pending", async () => {
    const { app } = harness();
    const response = await app.request("/v1/session/revoke/retry", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("pushes a live snapshot without a reload", async () => {
    const { consoleService, seller } = harness();
    const seen: string[] = [];
    const stop = consoleService.subscribe((event) => {
      seen.push(event.snapshot.streams[0]?.streamId ?? "");
    });
    seller.openStream({ requestUrl: "http://localhost:4000/v1/streams" });
    consoleService.notify();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeTruthy();
  });

  it("close() aborts registered SSE connections and drops subscribers", () => {
    const { consoleService } = harness();
    let aborted = false;
    const stop = consoleService.subscribe(() => {
      /* live listener */
    });
    consoleService.registerSseAbort(() => {
      aborted = true;
    });
    consoleService.close();
    expect(aborted).toBe(true);
    stop();
  });

  it("never defaults CORS to * and never returns secrets", async () => {
    const { app } = harness();
    const response = await app.request("/v1/session", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");

    const wildcard = createApp({ corsOrigin: "*" });
    const preflight = await wildcard.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );

    const rejected = await wildcard.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(rejected.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(rejected.headers.get("access-control-allow-origin")).not.toBe(
      "http://evil.example",
    );
  });
});

describe("administrative audit trail", () => {
  it("records a revoke request with its actor and request id", async () => {
    const { app, ledger } = harness();
    const response = await app.request("/v1/session/revoke", {
      method: "POST",
      headers: { "X-Request-Id": "req-audit-1" },
    });
    expect(response.status).toBe(200);

    const events = await ledger.auditEvents({
      action: "session.revoke.requested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "operator",
      outcome: "succeeded",
      subject: WALLET,
      requestId: "req-audit-1",
    });
    ledger.close();
  });

  it("records a revoke that found no session as a failed request", async () => {
    // The attempt is the fact worth keeping: "someone tried to kill a
    // session that was already gone" is exactly what an incident
    // reconstruction needs, and it leaves no ledger entry of its own.
    const { app, ledger, sessions } = harness();
    sessions.remove(WALLET);

    const response = await app.request("/v1/session/revoke", {
      method: "POST",
    });
    expect(response.status).toBe(404);

    const events = await ledger.auditEvents({
      action: "session.revoke.requested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("failed");
    ledger.close();
  });

  it("records an on-chain revoke retry", async () => {
    const { app, ledger } = harness({
      performRevoke: async () => ({
        local: { revoked: true },
        onChain: { revoked: false, status: "FAILED", transactionHash: null },
      }),
      performRetryRevoke: async () => ({
        local: { revoked: true },
        onChain: {
          revoked: true,
          status: "CONFIRMED",
          transactionHash: ("0x" + "33".repeat(32)) as Hex,
        },
      }),
    });

    await app.request("/v1/session/revoke", { method: "POST" });
    const retry = await app.request("/v1/session/revoke/retry", {
      method: "POST",
    });
    expect(retry.status).toBe(200);

    const events = await ledger.auditEvents({
      action: "session.revoke.retry.requested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("succeeded");
    ledger.close();
  });

  it("records a price change and what it ended", async () => {
    const { seller, ledger } = harness();
    seller.openStream({ requestUrl: "https://seller.example/v1/streams" });
    seller.updatePrices({
      perCall: 200n,
      perSecond: 20n,
      perUnit: 2n,
      unitName: "token",
    });

    const events = await ledger.auditEvents({ action: "prices.updated" });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toContain("perCall=200");
    expect(events[0]?.detail).toContain("endedStreams=1");
    ledger.close();
  });

  it("records a settlement retry that failed, and answers 409", async () => {
    const { app, ledger } = harness();
    const response = await app.request("/v1/settlements/no-such-nonce/retry", {
      method: "POST",
    });
    // The nonce is unknown to the queue, which is the operator's answer
    // rather than a server fault.
    expect(response.status).toBe(409);

    const events = await ledger.auditEvents({
      action: "settlement.retry.requested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "failed",
      subject: "no-such-nonce",
    });
    ledger.close();
  });
});
