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
};

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
