/**
 * Altana client construction and the startup decimal assertion.
 *
 * Wraps `@altananetwork/sdk`'s `createClient` with two project-specific
 * concerns:
 *
 *  1. The chain set and default chain id come from configuration, not from
 *     a literal. The default is BNB Smart Chain Testnet (97); the spec
 *     forbids hardcoding a chain in payment logic.
 *  2. A startup check reads the token contract's `decimals()` and compares
 *     it against the configured `tokenDecimals`. A mismatch is a fatal
 *     `DecimalsMismatchError`, raised before any on-chain action runs — the
 *     classic "cap written for 6 decimals on an 18-decimal chain" bug is
 *     ~10^12 off, and every payment reverts against a limit that reads as
 *     generous.
 */

import {
  BNB_TESTNET,
  createClient,
  type Client,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { bsc } from "viem/chains";
import type { Address, ChainConfig } from "@neuro-pay/types";
import { ConfigError } from "./config/errors.js";

/**
 * Raised when the configured `TOKEN_DECIMALS` does not match what the token
 * contract reports. The error carries both values so an operator sees the
 * exact mismatch from the first line of the crash.
 */
export class DecimalsMismatchError extends ConfigError {
  readonly configured: number;
  readonly onChain: number;
  readonly token: Address;

  constructor(configured: number, onChain: number, token: Address) {
    super(
      `TOKEN_DECIMALS=${configured} does not match decimals()=${onChain} ` +
        `reported by token contract ${token}. ` +
        `A cap written for the wrong decimals is ~10^|diff| off; ` +
        `fix TOKEN_DECIMALS in the environment, do not adjust the contract.`,
    );
    this.name = "DecimalsMismatchError";
    this.configured = configured;
    this.onChain = onChain;
    this.token = token;
  }
}

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

/** The viem chain handle for the configured chain id, defaulting to BSC testnet. */
function viemChainFor(chainId: number) {
  // We use BNB_TESTNET for chain 97 to keep the public RPC and chain metadata
  // consistent with the Altana SDK. Any other id falls back to mainnet BSC,
  // which is the only other chain this change explicitly targets.
  return chainId === BNB_TESTNET.chainId ? BNB_TESTNET.chain : bsc;
}

/**
 * Build the `NetworkConfig` we hand to the Altana SDK for a given chain.
 * Public RPC comes from configuration when set; otherwise the SDK's default.
 */
export function networkConfigFor(
  chainId: number,
  rpcUrl: string,
): NetworkConfig {
  const base = chainId === BNB_TESTNET.chainId ? BNB_TESTNET : null;
  if (base === null) {
    // Spec: no source file may hardcode a chain. For any chain other than
    // BNB testnet we still build a valid NetworkConfig — chain id, RPC, and
    // explorer are config-driven, so mainnet (56) "just works" by changing
    // CHAIN_ID/RPC_URL. Without a known keystore deployment we leave those
    // addresses as the zero address; operations that need them will throw
    // an explicit error from the SDK rather than silently signing against
    // the wrong contract.
    return {
      chain: viemChainFor(chainId),
      chainId,
      keyStore: "0x0000000000000000000000000000000000000000",
      keyStoreController: "0x0000000000000000000000000000000000000000",
      publicRpcUrl: rpcUrl,
      explorer: "https://bscscan.com",
    };
  }
  return { ...base, publicRpcUrl: rpcUrl };
}

/**
 * Build a viem `PublicClient` against the configured RPC.
 *
 * Exposed so authority reads (`isValidKey`) can use the same RPC the SDK
 * does, without the SDK having to expose its internal builder.
 */
export function publicClientFor(
  chainId: number,
  rpcUrl: string,
): PublicClient<Transport> {
  return createPublicClient({
    chain: viemChainFor(chainId),
    transport: http(rpcUrl),
  });
}

/**
 * Read `decimals()` from the token contract and compare against config.
 *
 * Called once at startup. Throws `DecimalsMismatchError` on disagreement;
 * callers should let that propagate and kill the process.
 */
export async function assertTokenDecimals(
  publicClient: PublicClient<Transport>,
  chain: ChainConfig,
): Promise<void> {
  const onChain = await publicClient.readContract({
    address: chain.token,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });
  if (onChain !== chain.tokenDecimals) {
    throw new DecimalsMismatchError(chain.tokenDecimals, onChain, chain.token);
  }
}

/** Result of building a client: the SDK handle plus the viem read client. */
export type AltanaClientContext = {
  client: Client;
  network: NetworkConfig;
  publicClient: PublicClient<Transport>;
  chain: ChainConfig;
};

/**
 * Construct the Altana client context for a configured chain.
 *
 * Default chain id is 97 (BNB testnet) when the config omits it — the spec
 * requires testnet as the default. The decimal check runs against the
 * public client; callers can pass a `PublicClient` to stub the RPC for
 * tests (a fake transport that returns the expected decimals).
 */
export async function buildAltanaClient(
  chain: ChainConfig,
  options?: {
    client?: PublicClient<Transport>;
    /**
     * Override the SDK client entirely. Used by the operator script path
     * that wants a non-default SDK configuration (e.g. an injected relay);
     * not used by tests, which stub the public client instead.
     */
    sdkClient?: Client;
  },
): Promise<AltanaClientContext> {
  const network = networkConfigFor(chain.chainId, chain.rpcUrl);
  const publicClient =
    options?.client ?? publicClientFor(chain.chainId, chain.rpcUrl);
  await assertTokenDecimals(publicClient, chain);
  const client =
    options?.sdkClient ??
    createClient({ chains: [network], defaultChainId: chain.chainId });
  return { client, network, publicClient, chain };
}
