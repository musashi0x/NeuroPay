/**
 * Anvil cheat codes, typed.
 *
 * These are the reason a fork beats a public testnet for integration
 * work. On chain 97 you wait for blocks, beg a faucet for gas, and can
 * only act as accounts whose keys you hold — and a test that revokes a
 * session can be run exactly once, ever. Here, balances are assignable,
 * any address is impersonatable, blocks mine on demand, and `snapshot` /
 * `revert` make a destructive test repeatable.
 *
 * Impersonation is the load-bearing one. The granted session belongs to
 * a smart account this repo does not hold the admin key for; without
 * `anvil_impersonateAccount` there is no way to exercise revoke at all
 * without either the real key or a fresh grant.
 */

import { encodeAbiParameters, keccak256, pad as padHex } from "viem";

import type { Address, Hex } from "@neuro-pay/types";

type RpcParam = string | number | boolean | null;

/** Minimal JSON-RPC caller. Takes a URL so it needs no viem client. */
async function rpc<T>(
  rpcUrl: string,
  method: string,
  params: RpcParam[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string; code: number };
  };
  if (body.error) {
    throw new Error(`${method} failed: ${body.error.message}`);
  }
  return body.result as T;
}

/** Quantities go on the wire as minimal hex, never as decimal or padded. */
function toQuantity(value: bigint | number): Hex {
  return `0x${BigInt(value).toString(16)}`;
}

export type Cheats = {
  /** Set an account's native balance outright. */
  setBalance: (address: Address, wei: bigint) => Promise<void>;
  /** Send transactions as `address` without holding its key. */
  impersonate: (address: Address) => Promise<void>;
  stopImpersonating: (address: Address) => Promise<void>;
  /** Overwrite an address's code — used to stub a contract's behaviour. */
  setCode: (address: Address, bytecode: Hex) => Promise<void>;
  /** Overwrite one storage slot. */
  setStorageAt: (address: Address, slot: Hex, value: Hex) => Promise<void>;
  /** Mine `count` blocks immediately. */
  mine: (count?: number) => Promise<void>;
  /** Move the next block's timestamp forward by `seconds` and mine it. */
  advanceTime: (seconds: number) => Promise<void>;
  /** Capture chain state. Pair with `revert`. */
  snapshot: () => Promise<Hex>;
  /**
   * Restore a snapshot. Anvil consumes the id, so a test that reverts
   * twice must snapshot again in between.
   */
  revert: (id: Hex) => Promise<boolean>;
  /** Current block number. */
  blockNumber: () => Promise<bigint>;
  /**
   * Give `holder` a token balance by writing the ERC-20's storage.
   *
   * The alternative is begging a faucet, which is not a thing a test can
   * do. Returns the storage slot index that worked, so a caller that
   * deals repeatedly can skip the search.
   */
  dealToken: (
    token: Address,
    holder: Address,
    amount: bigint,
    knownSlot?: number,
  ) => Promise<number>;
};

/** `balanceOf(address)` selector. */
const BALANCE_OF = "0x70a08231";

/**
 * Storage slot of `balances[holder]` for a Solidity `mapping(address => uint256)`
 * declared at slot `index`: `keccak256(abi.encode(holder, index))`.
 */
function balanceSlot(holder: Address, index: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(index)],
    ),
  ) as Hex;
}

export function createCheats(rpcUrl: string): Cheats {
  return {
    setBalance: async (address, wei) => {
      await rpc(rpcUrl, "anvil_setBalance", [address, toQuantity(wei)]);
    },
    impersonate: async (address) => {
      await rpc(rpcUrl, "anvil_impersonateAccount", [address]);
    },
    stopImpersonating: async (address) => {
      await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [address]);
    },
    setCode: async (address, bytecode) => {
      await rpc(rpcUrl, "anvil_setCode", [address, bytecode]);
    },
    setStorageAt: async (address, slot, value) => {
      await rpc(rpcUrl, "anvil_setStorageAt", [address, slot, value]);
    },
    mine: async (count = 1) => {
      await rpc(rpcUrl, "anvil_mine", [toQuantity(count)]);
    },
    advanceTime: async (seconds) => {
      // Two calls on purpose: `increaseTime` only affects the *next*
      // block, so without mining one the clock has not actually moved
      // for anything that reads `block.timestamp`.
      await rpc(rpcUrl, "evm_increaseTime", [seconds]);
      await rpc(rpcUrl, "anvil_mine", [toQuantity(1)]);
    },
    snapshot: () => rpc<Hex>(rpcUrl, "evm_snapshot", []),
    revert: (id) => rpc<boolean>(rpcUrl, "evm_revert", [id]),
    blockNumber: async () =>
      BigInt(await rpc<Hex>(rpcUrl, "eth_blockNumber", [])),

    dealToken: async (token, holder, amount, knownSlot) => {
      const readBalance = async (): Promise<bigint> => {
        const data = (BALANCE_OF +
          padHex(holder, { size: 32 }).slice(2)) as Hex;
        const result = await rpc<Hex>(rpcUrl, "eth_call", [
          // `eth_call` params are objects, not scalars; the narrow
          // `RpcParam` type does not describe them.
          { to: token, data } as unknown as string,
          "latest",
        ]);
        return BigInt(result);
      };

      const value = padHex(`0x${amount.toString(16)}`, { size: 32 }) as Hex;
      // Which slot holds the balances mapping is a property of how the
      // token was compiled, and there is no way to read it from the ABI.
      // So: write a candidate slot, ask `balanceOf`, and keep the one
      // the contract agrees with. Searching beats hard-coding a slot per
      // token, and a wrong guess is harmless — it writes to an unused
      // slot on a throwaway fork.
      const candidates =
        knownSlot === undefined
          ? Array.from({ length: 32 }, (_, i) => i)
          : [knownSlot];
      for (const index of candidates) {
        const slot = balanceSlot(holder, index);
        const previous = await rpc<Hex>(rpcUrl, "eth_getStorageAt", [
          token,
          slot,
          "latest",
        ]);
        await rpc(rpcUrl, "anvil_setStorageAt", [token, slot, value]);
        if ((await readBalance()) === amount) return index;
        // Put it back so the search leaves no debris in slots that
        // belong to some other mapping.
        await rpc(rpcUrl, "anvil_setStorageAt", [token, slot, previous]);
      }
      throw new Error(
        `could not locate the balances mapping for ${token}: tried slots ` +
          `0-${candidates.length - 1}. The token may use a non-standard ` +
          `layout (a proxy, or a struct-valued mapping).`,
      );
    },
  };
}

/**
 * Run `work` against a snapshot, restoring chain state afterwards.
 *
 * The wrapper exists so a destructive test — revoke being the obvious
 * one — does not leave the chain in a state the next test reads. Restore
 * runs in `finally`, because a test that fails halfway through a
 * mutation is exactly when the next one most needs a clean chain.
 */
export async function withSnapshot<T>(
  cheats: Cheats,
  work: () => Promise<T>,
): Promise<T> {
  const id = await cheats.snapshot();
  try {
    return await work();
  } finally {
    await cheats.revert(id);
  }
}
