import { describe, expect, it } from "vitest";
import type { NetworkConfig } from "@altananetwork/sdk";
import type { PublicClient, Transport } from "viem";
import { bscTestnet } from "viem/chains";
import type { Address, Hex } from "@neuro-pay/types";
import { checkSessionAuthority, deriveKeyId } from "./authority.js";
import type { PersistedSession } from "./persisted.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const KEYSTORE = "0x3333333333333333333333333333333333333333" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const PUBKEY = ("0x04" + "ab".repeat(64)) as Hex;

const NETWORK: NetworkConfig = {
  chain: bscTestnet,
  chainId: 97,
  keyStore: KEYSTORE,
  keyStoreController: KEYSTORE,
  publicRpcUrl: "https://example.invalid",
  explorer: "https://testnet.bscscan.com",
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

function fakePublicClient(onChainValid: boolean): PublicClient<Transport> {
  return {
    readContract: async () => onChainValid,
  } as unknown as PublicClient<Transport>;
}

describe("checkSessionAuthority", () => {
  it("reports an unexpired, registered session as active", async () => {
    const result = await checkSessionAuthority({
      session: persisted({ expiry: 1_800_000_000 }),
      network: NETWORK,
      publicClient: fakePublicClient(true),
      now: 1_700_000_000,
    });
    expect(result.status).toBe("active");
    expect(result.onChainValid).toBe(true);
  });

  it("reports an unregistered session as revoked", async () => {
    const result = await checkSessionAuthority({
      session: persisted({ expiry: 1_800_000_000 }),
      network: NETWORK,
      publicClient: fakePublicClient(false),
      now: 1_700_000_000,
    });
    expect(result.status).toBe("revoked");
    expect(result.onChainValid).toBe(false);
  });

  it("reports expiry as winning over a still-valid on-chain read", async () => {
    const result = await checkSessionAuthority({
      session: persisted({ expiry: 1_700_000_000 }),
      network: NETWORK,
      publicClient: fakePublicClient(true),
      now: 1_700_000_000,
    });
    expect(result.status).toBe("expired");
    expect(result.onChainValid).toBe(true);
  });

  it("reports expiry even when the on-chain record was never revoked", async () => {
    const result = await checkSessionAuthority({
      session: persisted({ expiry: 1_600_000_000 }),
      network: NETWORK,
      publicClient: fakePublicClient(true),
      now: 1_700_000_000,
    });
    expect(result.status).toBe("expired");
  });

  it("derives the keyId as keccak256 of the public key", () => {
    const keyId = deriveKeyId(PUBKEY);
    expect(keyId).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
