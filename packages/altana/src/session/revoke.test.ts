import { describe, expect, it } from "vitest";
import type { Client, ExecuteResult, Signer } from "@altananetwork/sdk";
import type { Address, Hex } from "@neuro-pay/types";
import { retryOnChainRevoke, revokeSession } from "./revoke.js";
import { SessionStore } from "./store.js";
import type { PersistedSession } from "./persisted.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const PUBKEY = ("0x04" + "ab".repeat(64)) as Hex;

const adminSigner: Signer = {
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

function fakeClient(
  respond: () => Promise<ExecuteResult> | ExecuteResult,
): Client {
  return {
    chains: [],
    defaultChainId: 97,
    createWallet: async () => {
      throw new Error("not used");
    },
    createPasskeyWallet: async () => {
      throw new Error("not used");
    },
    recoverFromPasskey: async () => {
      throw new Error("not used");
    },
    execute: async () => {
      throw new Error("not used");
    },
    grantSession: async () => {
      throw new Error("not used");
    },
    revokeSession: async () => respond(),
    registerSessionKey: async () => {
      throw new Error("not used");
    },
    balances: async () => {
      throw new Error("not used");
    },
    signOrder: async () => {
      throw new Error("not used");
    },
    signOrderTypedData: async () => {
      throw new Error("not used");
    },
    approveSignatureChecker: async () => {
      throw new Error("not used");
    },
    revokeSignatureChecker: async () => {
      throw new Error("not used");
    },
    approveTokenForPermit2: async () => {
      throw new Error("not used");
    },
    fetchWithX402: async () => {
      throw new Error("not used");
    },
  } as unknown as Client;
}

describe("revokeSession", () => {
  it("removes the session locally first, then confirms on chain", () => {
    return (async () => {
      const store = new SessionStore();
      store.save(persisted());
      const client = fakeClient(() => ({
        callsId: ("0x" + "aa".repeat(32)) as Hex,
        status: "CONFIRMED",
        transactionHash: ("0x" + "33".repeat(32)) as Hex,
      }));

      const result = await revokeSession(store, {
        client,
        wallet: { address: WALLET } as never,
        adminSigner,
      });

      expect(result.localRevoked).toBe(true);
      expect(result.onChainRevoked).toBe(true);
      expect(result.onChainStatus).toBe("CONFIRMED");
      expect(result.onChainTransactionHash).toBe(
        ("0x" + "33".repeat(32)) as Hex,
      );
      expect(result.revoked).toBe(true);
      expect(store.list()).toHaveLength(0);
    })();
  });

  it("reports a PENDING status as on-chain revoked, not yet provably revoked as confirmed", async () => {
    const store = new SessionStore();
    store.save(persisted());
    const client = fakeClient(() => ({
      callsId: ("0x" + "aa".repeat(32)) as Hex,
      status: "PENDING",
    }));

    const result = await revokeSession(store, {
      client,
      wallet: { address: WALLET } as never,
      adminSigner,
    });

    expect(result.onChainStatus).toBe("PENDING");
    expect(result.onChainRevoked).toBe(true);
    expect(result.revoked).toBe(true);
  });

  it("surfaces a FAILED on-chain status as a failure, keeping the local removal", async () => {
    const store = new SessionStore();
    store.save(persisted());
    const client = fakeClient(() => ({
      callsId: ("0x" + "aa".repeat(32)) as Hex,
      status: "FAILED",
    }));

    const result = await revokeSession(store, {
      client,
      wallet: { address: WALLET } as never,
      adminSigner,
    });

    expect(result.localRevoked).toBe(true);
    expect(result.onChainRevoked).toBe(false);
    expect(result.onChainStatus).toBe("FAILED");
    expect(result.revoked).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("treats a thrown on-chain call the same as a failure, without undoing the local removal", async () => {
    const store = new SessionStore();
    store.save(persisted());
    const client = fakeClient(() => {
      throw new Error("relay unreachable");
    });

    const result = await revokeSession(store, {
      client,
      wallet: { address: WALLET } as never,
      adminSigner,
    });

    expect(result.localRevoked).toBe(true);
    expect(result.onChainRevoked).toBe(false);
    expect(result.onChainStatus).toBeNull();
    expect(result.onChainTransactionHash).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("throws when there is no persisted session for the wallet", async () => {
    const store = new SessionStore();
    const client = fakeClient(() => ({
      callsId: ("0x" + "aa".repeat(32)) as Hex,
      status: "CONFIRMED",
    }));

    await expect(
      revokeSession(store, {
        client,
        wallet: { address: WALLET } as never,
        adminSigner,
      }),
    ).rejects.toThrow(/no persisted session/);
  });
});

describe("retryOnChainRevoke", () => {
  it("resubmits the on-chain stage from a cached snapshot after the store record is gone", async () => {
    const store = new SessionStore();
    store.save(persisted());
    let attempt = 0;
    const client = fakeClient(() => {
      attempt += 1;
      const callsId = ("0x" + "aa".repeat(32)) as Hex;
      return attempt === 1
        ? { callsId, status: "FAILED" }
        : { callsId, status: "CONFIRMED" };
    });

    const first = await revokeSession(store, {
      client,
      wallet: { address: WALLET } as never,
      adminSigner,
    });
    expect(first.onChainRevoked).toBe(false);
    expect(store.list()).toHaveLength(0);

    const retry = await retryOnChainRevoke({
      client,
      wallet: { address: WALLET } as never,
      adminSigner,
      session: persisted(),
    });

    expect(retry.onChainRevoked).toBe(true);
    expect(retry.onChainStatus).toBe("CONFIRMED");
    expect(attempt).toBe(2);
  });
});
