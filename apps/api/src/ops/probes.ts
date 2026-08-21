/**
 * Chain- and store-backed readiness probes.
 *
 * Each factory returns a `Probe` closed over the one dependency it
 * checks. Keeping them separate — rather than one `checkEverything()` —
 * is what lets a deployment with no `RPC_URL` skip three probes and
 * still report honestly on the three it can run.
 *
 * Every probe checks a *claim configuration makes*, not merely that a
 * call returned. "The RPC answered" is not readiness; "the RPC answered
 * and it is the chain the token addresses and the Permit2 deployment
 * were written for" is. The difference is a whole class of
 * misconfiguration that otherwise surfaces as an unexplained revert
 * after a segment has already been delivered.
 */

import type { Address, Hex } from "@neuro-pay/types";
import type { LedgerStore } from "@neuro-pay/ledger";

import type { Probe, ProbeVerdict } from "./health.js";

/** The narrow slice of a viem `PublicClient` these probes use. */
export type ProbeClient = {
  getChainId: () => Promise<number>;
  getCode: (input: { address: Address }) => Promise<Hex | undefined>;
  getBalance: (input: { address: Address }) => Promise<bigint>;
  readContract: (input: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
  }) => Promise<unknown>;
};

const ERC20_IDENTITY_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** A probe that reports `skipped` — the dependency is not wired here. */
export function skippedProbe(name: Probe["name"], reason: string): Probe {
  return {
    name,
    run: async () => ({ status: "skipped", message: reason }),
  };
}

/**
 * The configured RPC answers, and answers for the configured chain.
 *
 * A chain-id mismatch is `down` rather than `degraded`: every address in
 * the configuration — token, Permit2, the session's keystore — is
 * chain-scoped, so pointing at the wrong chain does not degrade
 * anything, it makes all of it wrong.
 */
export function rpcProbe(client: ProbeClient, expectedChainId: number): Probe {
  return {
    name: "rpc",
    run: async (): Promise<ProbeVerdict> => {
      const chainId = await client.getChainId();
      if (chainId !== expectedChainId) {
        return {
          status: "down",
          message: `RPC reports chain ${chainId}, configured for ${expectedChainId}`,
        };
      }
      return { status: "ok", message: `chain ${chainId}` };
    },
  };
}

/**
 * The token at the configured address is a contract whose `symbol()`
 * and `decimals()` both match configuration.
 *
 * Startup already asserts this once in `buildAltanaClient`. Re-checking
 * here is not redundant: the process can outlive the assertion by days,
 * and an RPC that has been failed over to a different network answers
 * from a different contract at the same address. Decimals-only is how a
 * near-inert third-party token default survived every boot.
 */
export function tokenIdentityProbe(
  client: ProbeClient,
  token: Address,
  expected: { decimals: number; symbol: string },
): Probe {
  return {
    name: "token-identity",
    run: async (): Promise<ProbeVerdict> => {
      const code = await client.getCode({ address: token });
      if (code === undefined || code === "0x") {
        return {
          status: "down",
          message: `no contract code at token address ${token}`,
        };
      }

      const rawDecimals = await client.readContract({
        address: token,
        abi: ERC20_IDENTITY_ABI,
        functionName: "decimals",
      });
      const decimals = Number(rawDecimals);
      if (!Number.isInteger(decimals)) {
        return {
          status: "down",
          message: `token ${token} returned a non-integer decimals() (${String(rawDecimals)})`,
        };
      }
      if (decimals !== expected.decimals) {
        return {
          status: "down",
          message: `token ${token} reports ${decimals} decimals, configured for ${expected.decimals}`,
        };
      }

      const rawSymbol = await client.readContract({
        address: token,
        abi: ERC20_IDENTITY_ABI,
        functionName: "symbol",
      });
      if (typeof rawSymbol !== "string" || rawSymbol !== expected.symbol) {
        return {
          status: "down",
          message: `token ${token} reports symbol ${String(rawSymbol)}, configured for ${expected.symbol}`,
        };
      }

      return {
        status: "ok",
        message: `${rawSymbol} · ${decimals} decimals`,
      };
    },
  };
}

/** Permit2 has code at the canonical address on this chain. */
export function permit2Probe(client: ProbeClient, permit2: Address): Probe {
  return {
    name: "permit2",
    run: async (): Promise<ProbeVerdict> => {
      const code = await client.getCode({ address: permit2 });
      if (code === undefined || code === "0x") {
        return {
          status: "down",
          message: `no contract code at Permit2 address ${permit2}`,
        };
      }
      return { status: "ok", message: `deployed at ${permit2}` };
    },
  };
}

/**
 * The settler EOA can still pay for gas.
 *
 * `degraded` below the floor and `down` at a tenth of it. The seller
 * keeps working while degraded — it settles fine until the balance
 * actually runs out — so this is exactly the case where taking the
 * instance out of rotation would be worse than leaving it in.
 */
export function settlerBalanceProbe(
  client: ProbeClient,
  settler: Address,
  floorWei: bigint,
): Probe {
  return {
    name: "settler-balance",
    run: async (): Promise<ProbeVerdict> => {
      const balance = await client.getBalance({ address: settler });
      if (balance < floorWei / 10n) {
        return {
          status: "down",
          message: `settler ${settler} is out of gas (${balance} wei)`,
        };
      }
      if (balance < floorWei) {
        return {
          status: "degraded",
          message: `settler ${settler} below floor: ${balance} wei < ${floorWei} wei`,
        };
      }
      return { status: "ok", message: `${balance} wei` };
    },
  };
}

/**
 * The ledger file is open, readable, and at a schema this build knows.
 *
 * The read is a real query rather than a handle check, because "the
 * connection object exists" and "the file is readable" diverge exactly
 * when it matters: a deleted, truncated, or permission-changed file
 * still has a live handle.
 */
export function ledgerProbe(
  store: Pick<LedgerStore, "size" | "schemaInfo">,
): Probe {
  return {
    name: "ledger",
    run: async (): Promise<ProbeVerdict> => {
      const size = await store.size();
      const schema = store.schemaInfo();
      if (schema.version !== schema.latest) {
        return {
          status: "degraded",
          message: `ledger schema at version ${schema.version}, build supports ${schema.latest}`,
        };
      }
      return {
        status: "ok",
        message: `${size} entries, schema v${schema.version}`,
      };
    },
  };
}

/**
 * The session is live on chain.
 *
 * `expired` and `revoked` are `down`: a process in either state can
 * accept a request, meter it, demand payment, and refuse to sign every
 * time. That is worse than being out of rotation. `unknown` — the
 * authority read itself failed — is `degraded`, since the session may
 * well be fine and the seller keeps working either way.
 */
export function sessionAuthorityProbe(
  readStatus: () => Promise<string | null>,
): Probe {
  return {
    name: "session-authority",
    run: async (): Promise<ProbeVerdict> => {
      const status = await readStatus();
      if (status === null) {
        return { status: "skipped", message: "no session provisioned" };
      }
      switch (status) {
        case "active":
          return { status: "ok", message: "active" };
        case "expired":
        case "revoked":
          return { status: "down", message: status };
        default:
          return { status: "degraded", message: status };
      }
    },
  };
}
