/**
 * API ↔ web wire contract: HTTP JSON + the shared reviver produce the
 * original bigints, and a decimal-looking nonce stays a string.
 */

import { describe, expect, it } from "vitest";
import { reviveBigints } from "@neuro-pay/types";
import { createApp } from "./app.js";
import { createConsoleService } from "./console/service.js";
import { openLedgerStore, recordPaymentSigned } from "@neuro-pay/ledger";
import { SessionStore } from "@neuro-pay/altana";
import type { Address, AppConfig, Hex } from "@neuro-pay/types";
import type { PersistedSession } from "@neuro-pay/altana";
import { createSeller } from "./seller/index.js";
import { createInMemorySettler } from "./seller/settle.js";
import { IS_VALID_SIGNATURE_MAGIC } from "./seller/verify.js";

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

function session(): PersistedSession {
  return {
    walletAddress: WALLET,
    publicKey: PUBKEY,
    permissions: {
      calls: [],
      spend: [{ limit: FIFTY, period: "day", token: TOKEN }],
    },
    expiry: Math.floor(NOW / 1000) + 3_600,
    grantTransactionHash: ("0x" + "22".repeat(32)) as Hex,
    railProvisioned: true,
    createdAt: Math.floor(NOW / 1000) - 60,
  };
}

describe("web/API wire compatibility", () => {
  it("revives console amounts as bigint and leaves nonce a string", async () => {
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
    });
    const app = createApp({ console: consoleService, seller });

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
      nonce: "98765432101234567890",
    });

    const sessionRes = await app.request("/v1/session");
    const sessionBody = reviveBigints(await sessionRes.json()) as {
      spendCap: { limit: bigint; tokenSymbol: string };
    };
    expect(sessionBody.spendCap.limit).toBe(FIFTY);
    expect(sessionBody.spendCap.tokenSymbol).toBe("npUSD");

    const payRes = await app.request("/v1/payments");
    const payBody = reviveBigints(await payRes.json()) as {
      payments: Array<{ amount: bigint; nonce: string }>;
      nextCursor: string | null;
    };
    expect(payBody.payments[0]?.amount).toBe(10n ** 16n);
    expect(payBody.payments[0]?.nonce).toBe("98765432101234567890");
    expect(typeof payBody.payments[0]?.nonce).toBe("string");
    expect(payBody.nextCursor).toBeNull();
  });
});
