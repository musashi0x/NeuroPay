/**
 * `Permit2.permitWitnessTransferFrom`, against real Permit2.
 *
 * ## Why this file is the important one
 *
 * The P0 wire-format work fixed a settler that fabricated all three of
 * the arguments Permit2 checks: an empty signature, a witness hash
 * invented from the nonce, and a malformed type string. Permit2
 * recomputes the signed digest from exactly those arguments and compares
 * it to the signature, so every one of those defects produced an
 * unconditional revert — and none of them could be caught by a unit test,
 * because a unit test asserts what we *pass*, not what Permit2 *accepts*.
 *
 * That is the gap this closes. The assertion here is not "the settler
 * built the calldata we expected"; it is "the real Permit2 contract
 * accepted it and the tokens moved". Nothing short of a real EVM can
 * make that claim.
 *
 * ## The payer is an EOA, deliberately
 *
 * Permit2 validates a signature two ways: `ecrecover` for an EOA, and
 * ERC-1271 `isValidSignature` for a contract. The settler's calldata is
 * byte-identical either way — the permit struct, the witness hash, the
 * type string, and the signature do not depend on who signed.
 *
 * Using an EOA payer buys independence. A smart-account payer would need
 * a live granted session on the forked network, which means this suite
 * would pass or fail based on whether someone had recently run the
 * provisioning script and whether that grant had aged out. Anvil's dev
 * accounts are always there. The delta left unproven is narrow and
 * explicit: the smart account's ERC-1271 branch inside Permit2, which
 * `verification.chain.test.ts` covers when a session is configured.
 *
 * ## Why the payer has to be dealt tokens
 *
 * The real wallet on BNB testnet holds **zero** of the payment token —
 * it was funded with gas and never with USDT. A settlement against it
 * would revert on insufficient balance no matter how correct the
 * signature was. `dealToken` writes the balance directly, which is the
 * whole reason a fork beats the public testnet for this.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chainAvailable,
  createCheats,
  describeSkipReason,
  startLocalChain,
  type Cheats,
  type LocalChain,
} from "@neuro-pay/evm-testnet";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import {
  hashPermit2Witness,
  PERMIT2_ADDRESS,
  permit2WitnessDigest,
  WITNESS_TYPE_STRING,
} from "@neuro-pay/altana";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import type { Address, Hex, SmallestUnits } from "@neuro-pay/types";

import { createChainBackedSettler } from "./chain-settler.js";
import { SettlementUnsettleableError, type SettlementInput } from "./settle.js";

/** BNB testnet USDT — a real 18-decimal ERC-20 on the forked network. */
const TOKEN = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" as Address;
const CHAIN_ID = 97;
const GAS_FLOAT = 10n ** 18n;
const DEALT = 1_000n * 10n ** 18n;
const AMOUNT = (5n * 10n ** 17n) as SmallestUnits;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);

const skip = describeSkipReason();
if (skip) {
  console.warn(`[chain] skipping Permit2 settlement suite — ${skip}`);
}

describe.skipIf(!chainAvailable())(
  "Permit2 settlement on a forked chain",
  () => {
    let chain: LocalChain;
    let cheats: Cheats;
    let publicClient: PublicClient;
    let ledger: LedgerStore;

    // Dev account 0 pays, dev account 1 settles. Distinct on purpose:
    // Permit2 binds the signed `spender` to `msg.sender`, and collapsing
    // the two would hide a whole class of spender bug.
    const payer = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const settler = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    // Dev account 2. A real checksummed address that holds none of this
    // token, so the balance delta below measures this settlement alone.
    const payTo = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

    /** Sign a b402 permit with the payer's key and shape it for the settler. */
    async function authorize(input: {
      nonce: bigint;
      deadline: number;
      amount: SmallestUnits;
      spender?: Address;
      to?: Address;
    }): Promise<NonNullable<SettlementInput["authorization"]>> {
      const spender = input.spender ?? (settler.address as Address);
      const witness = {
        to: input.to ?? payTo,
        validAfter: "0",
      };
      // The digest is recomputed from the same helper the seller's
      // verifier uses, so a change to the witness encoding breaks this
      // test rather than silently producing a revert in production.
      const digest = permit2WitnessDigest({
        chainId: CHAIN_ID,
        authorization: {
          permitted: { token: TOKEN, amount: input.amount },
          spender,
          nonce: input.nonce.toString(10),
          deadline: input.deadline,
          witness,
        },
      });
      const signature = await payer.sign({ hash: digest });
      return { signature: signature as Hex, spender, witness };
    }

    function settlementInput(
      overrides: Partial<SettlementInput> = {},
    ): SettlementInput {
      return {
        streamId: "stream-chain-1",
        nonce: "1",
        amount: AMOUNT,
        payer: payer.address as Address,
        payTo,
        token: TOKEN,
        tokenDecimals: 18,
        deadline: Math.floor(Date.now() / 1000) + 3_600,
        sessionPublicKey: null,
        ...overrides,
      } as SettlementInput;
    }

    function settlerFor(): ReturnType<typeof createChainBackedSettler> {
      const walletClient = createWalletClient({
        account: settler,
        chain: { ...bscTestnet, id: CHAIN_ID },
        transport: http(chain.rpcUrl),
      });
      return createChainBackedSettler({
        walletClient,
        publicClient,
        settlerAddress: settler.address as Address,
        permit2Address: PERMIT2_ADDRESS as Address,
        chainId: CHAIN_ID,
        ledger,
        lostTxTimeoutMs: 30_000,
        pollIntervalMs: 200,
      });
    }

    beforeAll(async () => {
      chain = await startLocalChain();
      cheats = createCheats(chain.rpcUrl);
      ledger = openLedgerStore({ storagePath: ":memory:" });

      publicClient = createPublicClient({
        chain: { ...bscTestnet, id: CHAIN_ID },
        transport: http(chain.rpcUrl),
      }) as PublicClient;

      await cheats.setBalance(payer.address as Address, GAS_FLOAT);
      await cheats.setBalance(settler.address as Address, GAS_FLOAT);

      // Anvil's dev accounts are famous keys, and on BNB testnet somebody
      // has already EIP-7702-delegated them — `eth_getCode` on the fork
      // returns a 23-byte `0xef0100…` designator. Permit2 branches on
      // `owner.code.length`: with code present it skips `ecrecover` and
      // calls ERC-1271 on the delegate, which fails. Clearing the code is
      // what makes these addresses the plain EOAs the suite assumes, and
      // it is the kind of inherited state that makes forking a real
      // network different from a blank chain.
      await cheats.setCode(payer.address as Address, "0x");
      await cheats.setCode(settler.address as Address, "0x");
      await cheats.setCode(payTo, "0x");

      await cheats.dealToken(TOKEN, payer.address as Address, DEALT);

      // The payer approves Permit2 for real, as a transaction. On the live
      // network the provisioning script does this once; here it is part of
      // the fixture so the suite depends on nothing having been run before.
      const payerWallet = createWalletClient({
        account: payer,
        chain: { ...bscTestnet, id: CHAIN_ID },
        transport: http(chain.rpcUrl),
      });
      const approveHash = await payerWallet.writeContract({
        address: TOKEN,
        abi: ERC20,
        functionName: "approve",
        args: [PERMIT2_ADDRESS as Address, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }, 180_000);

    afterAll(async () => {
      ledger?.close();
      await chain?.stop();
    });

    it("deals the payer a balance the live wallet does not have", async () => {
      const balance = await publicClient.readContract({
        address: TOKEN,
        abi: ERC20,
        functionName: "balanceOf",
        args: [payer.address as Address],
      });
      expect(balance).toBe(DEALT);
    });

    it("approved Permit2 to move the payer's tokens", async () => {
      const allowance = await publicClient.readContract({
        address: TOKEN,
        abi: ERC20,
        functionName: "allowance",
        args: [payer.address as Address, PERMIT2_ADDRESS as Address],
      });
      expect(allowance).toBeGreaterThan(0n);
    });

    it("settles a real signed permit and moves the tokens to payTo", async () => {
      // The claim: Permit2 recomputed the digest from the settler's own
      // arguments, matched it against the buyer's signature, and executed.
      const before = await publicClient.readContract({
        address: TOKEN,
        abi: ERC20,
        functionName: "balanceOf",
        args: [payTo],
      });

      const deadline = Math.floor(Date.now() / 1000) + 3_600;
      const authorization = await authorize({
        nonce: 1n,
        deadline,
        amount: AMOUNT,
      });

      const settlerHandle = settlerFor();
      const submitted = await settlerHandle.submitSettle(
        settlementInput({ nonce: "1", deadline, authorization }),
      );
      expect(submitted.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: submitted.transactionHash,
      });
      expect(receipt.status).toBe("success");

      const after = await publicClient.readContract({
        address: TOKEN,
        abi: ERC20,
        functionName: "balanceOf",
        args: [payTo],
      });
      expect(after - before).toBe(AMOUNT);
    }, 120_000);

    it("rejects a replayed nonce at the contract, not just locally", async () => {
      // Permit2 marks a nonce spent. Idempotency in the seller is a
      // separate mechanism; this asserts the chain enforces it too, which
      // is what makes a lost-then-resubmitted settlement safe.
      const deadline = Math.floor(Date.now() / 1000) + 3_600;
      const authorization = await authorize({
        nonce: 1n,
        deadline,
        amount: AMOUNT,
      });
      await expect(
        settlerFor().submitSettle(
          settlementInput({ nonce: "1", deadline, authorization }),
        ),
      ).rejects.toThrow();
    }, 120_000);

    it("reverts when the signature was made for a different spender", async () => {
      // The exact P0 defect: the buyer used to bind `payTo` as the
      // spender, and Permit2 checks the signed spender against msg.sender.
      const deadline = Math.floor(Date.now() / 1000) + 3_600;
      const authorization = await authorize({
        nonce: 2n,
        deadline,
        amount: AMOUNT,
        spender: payTo,
      });
      // The settler refuses before spending gas on a doomed transaction.
      await expect(
        settlerFor().submitSettle(
          settlementInput({ nonce: "2", deadline, authorization }),
        ),
      ).rejects.toThrow(SettlementUnsettleableError);
    });

    it("reverts when the witness the settler hashes is not the one signed", async () => {
      // Signed with `to: payTo`, submitted with a tampered witness. The
      // fabricated-witness defect in one line.
      const deadline = Math.floor(Date.now() / 1000) + 3_600;
      const signed = await authorize({ nonce: 3n, deadline, amount: AMOUNT });
      const tampered = {
        ...signed,
        witness: { to: settler.address as Address, validAfter: "0" },
      };
      expect(hashPermit2Witness(tampered.witness)).not.toBe(
        hashPermit2Witness(signed.witness),
      );

      await expect(
        settlerFor().submitSettle(
          settlementInput({
            nonce: "3",
            deadline,
            authorization: tampered,
          }),
        ),
      ).rejects.toThrow();
    }, 120_000);

    it("refuses an intent that carries no authorization at all", async () => {
      await expect(
        settlerFor().submitSettle(settlementInput({ nonce: "4" })),
      ).rejects.toThrow(SettlementUnsettleableError);
    });

    it("uses a witness type string real Permit2 parses", () => {
      // A malformed type string was the third fabricated argument. The
      // settlement test above is the real proof — Permit2 would reject it
      // — but pinning the string makes the failure legible if it changes.
      expect(WITNESS_TYPE_STRING).toBe(
        "Witness witness)TokenPermissions(address token,uint256 amount)" +
          "Witness(address to,uint256 validAfter)",
      );
    });
  },
);
