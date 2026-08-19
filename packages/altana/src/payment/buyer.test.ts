import { describe, expect, it } from "vitest";
import type { Signer } from "@altananetwork/sdk";
import type { Address, Hex } from "@neuro-pay/types";
import { createBuyerPaymentContext } from "./buyer.js";
import type { PersistedSession } from "../session/persisted.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const PUBKEY = ("0x04" + "cd".repeat(64)) as Hex;

const signer: Signer = {
  type: "privateKey",
  address: WALLET,
  publicKey: PUBKEY,
  signDigest: async () => "0x",
};

function persisted(
  overrides: Partial<PersistedSession> = {},
): PersistedSession {
  return {
    walletAddress: WALLET,
    publicKey: PUBKEY,
    permissions: {
      calls: [{ signature: "transferFrom(address,address,uint256,uint256)" }],
      spend: [{ limit: 100n, period: "day", token: TOKEN }],
    },
    expiry: 1_800_000_000,
    grantTransactionHash: null,
    railProvisioned: true,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe("createBuyerPaymentContext", () => {
  it("hydrates a PaymentClientContext ready for fetchWithX402", () => {
    const ctx = createBuyerPaymentContext({
      persisted: persisted(),
      signer,
      chainId: 97,
      tokenDecimals: 18,
      budgetMargin: 0.2,
      clock: { now: () => 1_700_000_000_000 },
    });
    expect(ctx.session.signer).toBe(signer);
    expect(ctx.walletAddress).toBe(WALLET);
    expect(ctx.chainId).toBe(97);
    expect(ctx.permittedTokens.has(TOKEN)).toBe(true);
    expect(ctx.railProvisioned).toBe(true);
    expect(ctx.expiresAt).toBe(1_800_000_000);
    expect(ctx.budget.token).toBe(TOKEN);
    expect(ctx.budget.onChainCap).toBe(100n);
    expect(ctx.budget.localLimit).toBe(80n);
  });

  it("throws when the persisted session has no spend permission", () => {
    expect(() =>
      createBuyerPaymentContext({
        persisted: persisted({
          permissions: { calls: [{ signature: "x" }], spend: [] },
        }),
        signer,
        chainId: 97,
        tokenDecimals: 18,
        budgetMargin: 0,
      }),
    ).toThrow(/no spend permission/);
  });
});
