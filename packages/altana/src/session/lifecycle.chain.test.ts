/**
 * Chain-facing configuration guards, against a real EVM.
 *
 * ## The boundary this file discovered
 *
 * The original intent was to run the whole session lifecycle here —
 * provision a wallet, grant a session, read authority, revoke — on a
 * throwaway fork, so that revoke in particular stopped being a
 * once-per-grant experiment nobody dared run.
 *
 * That is not possible, and the reason is architectural rather than
 * incidental. `grantSession` and `revokeSession` do not send
 * transactions through the configured RPC at all: the SDK submits them
 * to **Altana's hosted relay** at `testnet-relay.altana.network`, which
 * signs and broadcasts to the real network. Pointing `rpcUrl` at a fork
 * changes where *reads* go and has no effect on where the relay writes.
 * A grant attempted against a fork fails inside the relay's
 * `wallet_prepareCalls`, because the account it is being asked to
 * prepare for does not exist on the chain the relay can see.
 *
 * So the split is:
 *
 * - **Forkable** — everything that is an `eth_call` or a transaction we
 *   send ourselves: Permit2's deployment, the token's `decimals()`, the
 *   keystore's `isValidKey` authority read, and
 *   `permitWitnessTransferFrom` (see
 *   `apps/api/src/seller/settlement.chain.test.ts`, which does prove the
 *   settlement path end to end).
 * - **Relay-bound, and therefore only ever verifiable on the real
 *   network** — `provisionWallet`, `grantSession`, `provisionRail`, and
 *   `revokeSession`.
 *
 * The relay-bound half stays in the P1 chain-97 list rather than being
 * quietly marked done here. Recording *why* is the point of this
 * comment: the next person to try moving revoke onto a fork should find
 * this instead of rediscovering it.
 *
 * ## What this file does assert
 *
 * The configuration guards that fail loudly at startup, against the real
 * contracts rather than a stub: Permit2 present at the canonical
 * address, and the token's on-chain decimals agreeing with config — the
 * mismatch that is otherwise a factor of 10^12 nobody notices until
 * every payment reverts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chainAvailable,
  createCheats,
  announceChainSkip,
  startLocalChain,
  type Cheats,
  type LocalChain,
} from "@neuro-pay/evm-testnet";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PERMIT2_ADDRESS } from "@altananetwork/sdk";
import type { Address, ChainConfig, Hex } from "@neuro-pay/types";

import { buildAltanaClient, type AltanaClientContext } from "../client.js";
import { assertPermit2Deployed } from "../rail.js";
import { checkSessionAuthority } from "./authority.js";
import type { PersistedSession } from "./persisted.js";

/** BNB testnet USDT. Real contract on the forked network. */
const TOKEN = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" as Address;
const PAY_TO = "0x000000000000000000000000000000000000dEaD" as Address;

/** Gas float for the throwaway account. Free here; a faucet elsewhere. */
const FUNDING_WEI = 100n * 10n ** 18n;

announceChainSkip("chain configuration suite");

describe.skipIf(!chainAvailable())("chain-facing configuration guards", () => {
  let chain: LocalChain;
  let cheats: Cheats;
  let ctx: AltanaClientContext;
  let probeAddress: Address;

  function chainConfig(rpcUrl: string): ChainConfig {
    return {
      chainId: 97,
      rpcUrl,
      token: TOKEN,
      tokenDecimals: 18,
      payTo: PAY_TO,
    };
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    cheats = createCheats(chain.rpcUrl);

    // A funded throwaway account, to prove the cheat path works on this
    // fork before anything depends on it.
    probeAddress = privateKeyToAccount(generatePrivateKey()).address as Address;
    await cheats.setBalance(probeAddress, FUNDING_WEI);

    // Building the client asserts `decimals()` against the real token,
    // so a successful construction is itself the token-decimals check.
    ctx = await buildAltanaClient(chainConfig(chain.rpcUrl));
  });

  afterAll(async () => {
    await chain?.stop();
  });

  it("forks the configured chain", async () => {
    expect(chain.chainId).toBe(97);
    const balance = await ctx.publicClient.getBalance({
      address: probeAddress,
    });
    expect(balance).toBe(FUNDING_WEI);
  });

  it("finds Permit2 deployed at the canonical address", async () => {
    // Never throws on a correct fork; the point is that it would on a
    // blank chain, which is the misconfiguration this guard exists for.
    await expect(
      assertPermit2Deployed(ctx.publicClient, 97),
    ).resolves.toBeUndefined();

    const code = await ctx.publicClient.getCode({ address: PERMIT2_ADDRESS });
    expect(code).toBeDefined();
    expect((code ?? "0x").length).toBeGreaterThan(2);
  });

  it("reads the token's real decimals rather than a configured literal", async () => {
    const decimals = await ctx.publicClient.readContract({
      address: TOKEN,
      abi: [
        {
          name: "decimals",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint8" }],
        },
      ] as const,
      functionName: "decimals",
    });
    expect(decimals).toBe(18);
  });

  it("rejects a config whose decimals disagree with the contract", async () => {
    // The failure this guards is quiet and expensive: a cap written for
    // 6 decimals is 10^12 too small against an 18-decimal token, and
    // every payment reverts against a limit that reads as generous.
    await expect(
      buildAltanaClient({ ...chainConfig(chain.rpcUrl), tokenDecimals: 6 }),
    ).rejects.toThrow(/decimals/i);
  });

  it("reads authority for an unknown session as revoked", async () => {
    // The keystore's `isValidKey` is a view call, so this half of the
    // session lifecycle *is* forkable. A key that was never granted and
    // one that was revoked are indistinguishable on chain, and both mean
    // "never sign" — which is the answer that matters.
    const unknown: PersistedSession = {
      walletAddress: privateKeyToAccount(generatePrivateKey())
        .address as Address,
      publicKey: `0x${"11".repeat(48)}` as Hex,
      permissions: { calls: [], spend: [] },
      expiry: Math.floor(Date.now() / 1000) + 3_600,
      grantTransactionHash: null,
      railProvisioned: true,
      createdAt: Math.floor(Date.now() / 1000),
    };

    const authority = await checkSessionAuthority({
      session: unknown,
      network: ctx.network,
      publicClient: ctx.publicClient,
    });
    expect(authority.onChainValid).toBe(false);
    expect(authority.status).toBe("revoked");
  });

  it("reports a session past its expiry as expired regardless of the chain read", async () => {
    // `expired` must win over the on-chain answer: a session key that
    // aged out was never revoked, so the keystore may still read valid.
    const expired: PersistedSession = {
      walletAddress: privateKeyToAccount(generatePrivateKey())
        .address as Address,
      publicKey: `0x${"22".repeat(48)}` as Hex,
      permissions: { calls: [], spend: [] },
      expiry: Math.floor(Date.now() / 1000) - 1,
      grantTransactionHash: null,
      railProvisioned: true,
      createdAt: Math.floor(Date.now() / 1000) - 3_600,
    };

    const authority = await checkSessionAuthority({
      session: expired,
      network: ctx.network,
      publicClient: ctx.publicClient,
    });
    expect(authority.status).toBe("expired");
  });
});
