/**
 * Tests for the chain-backed settler.
 *
 * This module used to hardcode `signature: "0x"`, derive the witness hash
 * from the nonce, and pass a witnessTypeString that is not valid EIP-712
 * at all. Permit2 rebuilds the signed digest from exactly those three
 * arguments and compares it to the signature, so every real settlement
 * reverted unconditionally. These tests pin the arguments.
 *
 * The wallet client is a spy: what matters is what would go on chain,
 * not that it lands.
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore } from "@neuro-pay/ledger";
import { hashPermit2Witness, WITNESS_TYPE_STRING } from "@neuro-pay/altana";
import type { Address, Hex } from "@neuro-pay/types";

import { createChainBackedSettler } from "./chain-settler.js";
import { SettlementUnsettleableError, type SettlementInput } from "./settle.js";
import { PAY_TO, SETTLER, TOKEN } from "./__fixtures__/real-envelope.js";

const PERMIT2: Address = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const PAYER: Address = "0x000000000000000000000000000000000000c0de";
const SIGNATURE = ("0x" + "11".repeat(98)) as Hex;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;

type Call = {
  functionName: string;
  args: readonly unknown[];
  address: Address;
};

function build(overrides: { settlerAddress?: Address } = {}) {
  const calls: Call[] = [];
  const settler = createChainBackedSettler({
    walletClient: {
      async writeContract(input) {
        calls.push({
          functionName: input.functionName,
          args: input.args,
          address: input.address,
        });
        return TX_HASH;
      },
    },
    publicClient: {
      async getTransactionReceipt() {
        return { status: "success" as const };
      },
    },
    settlerAddress: overrides.settlerAddress ?? SETTLER,
    permit2Address: PERMIT2,
    chainId: 97,
    ledger: openLedgerStore({ storagePath: ":memory:" }),
  });
  return { settler, calls };
}

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    nonce: "424242",
    streamId: "s-1",
    sessionPublicKey: null,
    chainId: 97,
    token: TOKEN,
    tokenDecimals: 18,
    amount: 1000n,
    payer: PAYER,
    payTo: PAY_TO,
    deadline: 1_704_070_800,
    authorization: {
      signature: SIGNATURE,
      spender: SETTLER,
      witness: { to: PAY_TO, validAfter: "0" },
    },
    ...overrides,
  };
}

describe("chain settler — permitWitnessTransferFrom arguments", () => {
  it("submits the buyer's real signature, not an empty one", async () => {
    const { settler, calls } = build();
    await settler.submitSettle(input());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[5]).toBe(SIGNATURE);
  });

  it("hashes the real witness struct rather than deriving one from the nonce", async () => {
    const { settler, calls } = build();
    await settler.submitSettle(input());
    const expected = hashPermit2Witness({ to: PAY_TO, validAfter: "0" });
    expect(calls[0]!.args[3]).toBe(expected);
    // The old placeholder was the nonce zero-padded to 32 bytes.
    expect(calls[0]!.args[3]).not.toBe(
      ("0x" + "424242".padEnd(64, "0")) as Hex,
    );
  });

  it("passes the real EIP-712 witness type string", async () => {
    const { settler, calls } = build();
    await settler.submitSettle(input());
    expect(calls[0]!.args[4]).toBe(
      "Witness witness)TokenPermissions(address token,uint256 amount)" +
        "Witness(address to,uint256 validAfter)",
    );
    expect(calls[0]!.args[4]).toBe(WITNESS_TYPE_STRING);
  });

  it("sends the funds to the witness recipient, not to the spender", async () => {
    const { settler, calls } = build();
    await settler.submitSettle(input());
    const transferDetails = calls[0]!.args[1] as {
      to: Address;
      requestedAmount: bigint;
    };
    expect(transferDetails.to).toBe(PAY_TO);
    expect(transferDetails.to).not.toBe(SETTLER);
    expect(transferDetails.requestedAmount).toBe(1000n);
  });

  it("passes the signed permit body and the payer as owner", async () => {
    const { settler, calls } = build();
    await settler.submitSettle(input());
    expect(calls[0]!.args[0]).toEqual({
      permitted: { token: TOKEN, amount: 1000n },
      nonce: 424242n,
      deadline: 1_704_070_800n,
    });
    expect(calls[0]!.args[2]).toBe(PAYER);
  });
});

describe("chain settler — refusals that would otherwise burn gas", () => {
  it("refuses an intent with no buyer authorization", async () => {
    const { settler, calls } = build();
    await expect(
      settler.submitSettle(input({ authorization: null })),
    ).rejects.toBeInstanceOf(SettlementUnsettleableError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a permit signed for a different spender", async () => {
    const { settler, calls } = build({
      settlerAddress: "0x000000000000000000000000000000000000bad3",
    });
    await expect(settler.submitSettle(input())).rejects.toBeInstanceOf(
      SettlementUnsettleableError,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an intent with no deadline instead of inventing one", async () => {
    const { settler, calls } = build();
    await expect(
      settler.submitSettle(input({ deadline: null })),
    ).rejects.toBeInstanceOf(SettlementUnsettleableError);
    expect(calls).toHaveLength(0);
  });

  it("accepts a checksummed spender that differs only in case", async () => {
    const { settler, calls } = build({
      settlerAddress: SETTLER.toUpperCase().replace("0X", "0x") as Address,
    });
    await settler.submitSettle(input());
    expect(calls).toHaveLength(1);
  });
});
