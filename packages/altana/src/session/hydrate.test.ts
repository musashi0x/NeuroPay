import { describe, expect, it } from "vitest";
import type { Signer } from "@altananetwork/sdk";
import type { Address, Hex } from "@neuro-pay/types";
import { sessionFromPersisted } from "./hydrate.js";
import type { PersistedSession } from "./persisted.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const PUBKEY = ("0x04" + "ab".repeat(64)) as Hex;

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
      calls: [
        {
          signature: "transferFrom(address,address,uint256,uint256)",
          to: PERMIT2,
        },
      ],
      spend: [{ limit: 10n ** 18n, period: "day", token: TOKEN }],
    },
    expiry: 1_800_000_000,
    grantTransactionHash: null,
    railProvisioned: true,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe("sessionFromPersisted", () => {
  it("reattaches the signer onto the persisted public half", () => {
    const session = sessionFromPersisted(persisted(), signer);
    expect(session.walletAddress).toBe(WALLET);
    expect(session.signer).toBe(signer);
    expect(session.publicKey).toBe(PUBKEY);
    expect(session.expiry).toBe(1_800_000_000);
    expect(session.permissions.calls).toEqual([
      {
        signature: "transferFrom(address,address,uint256,uint256)",
        to: PERMIT2,
      },
    ]);
    expect(session.permissions.spend).toEqual([
      { limit: 10n ** 18n, period: "day", token: TOKEN },
    ]);
  });

  it("omits undefined `to` from a signature-only call permission", () => {
    const session = sessionFromPersisted(
      persisted({
        permissions: {
          calls: [{ signature: "transfer(address,uint256)" }],
          spend: [{ limit: 1n, period: "hour" }],
        },
      }),
      signer,
    );
    expect(session.permissions.calls).toEqual([
      { signature: "transfer(address,uint256)" },
    ]);
    expect(session.permissions.spend).toEqual([{ limit: 1n, period: "hour" }]);
  });
});
