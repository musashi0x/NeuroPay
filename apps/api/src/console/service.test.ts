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
import { createConsoleService } from "./service.js";

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

function harness() {
  const cfg = config();
  const sessions = new SessionStore();
  sessions.save(session());
  const ledger = openLedgerStore({ storagePath: ":memory:" });
  const seller = createSeller({
    config: {
      metering: cfg.metering,
      payTo: cfg.chain.payTo,
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
  });
  const app = createApp({
    console: consoleService,
    seller,
    corsOrigin: "http://localhost:3000",
  });
  return { app, consoleService, seller, sessions, ledger, cfg };
}

describe("console API", () => {
  it("returns the session policy without key material", async () => {
    const { app } = harness();
    const response = await app.request("/v1/session");
    expect(response.status).toBe(200);
    const body = reviveBigints(await response.json()) as {
      walletAddress: string;
      publicKey: string;
      spendCap: { limit: bigint; periodSeconds: number };
      remainingLifetimeSeconds: number;
      allowedCalls: { to: string }[];
    };
    expect(body.walletAddress).toBe(WALLET);
    expect(body.publicKey).toBe(PUBKEY);
    expect(body.spendCap.limit).toBe(FIFTY);
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
        priceSheet: { perCall: bigint };
        secondsUntilNextTick: number;
        accruedUnpaid: bigint;
      }>;
    };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.status).toBe("active");
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
