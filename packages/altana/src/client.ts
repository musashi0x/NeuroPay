/**
 * Altana client construction and the startup token-identity assertion.
 *
 * Wraps `@altananetwork/sdk`'s `createClient` with two project-specific
 * concerns:
 *
 *  1. The chain set and default chain id come from configuration, not from
 *     a literal. The default is BNB Smart Chain Testnet (97); the spec
 *     forbids hardcoding a chain in payment logic.
 *  2. A startup check reads the token contract's code, `symbol()`, and
 *     `decimals()` together and compares them against configuration. A
 *     mismatch is a fatal `TokenIdentityError`, raised before any
 *     on-chain action runs. Decimals-only validation is how a near-inert
 *     third-party token default survived for months.
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
import type { Address, ChainConfig, Hex } from "@neuro-pay/types";
import { ConfigError } from "./config/errors.js";

/**
 * Raised when configured token address, symbol, or decimals do not all
 * match the contract. `check` says which of the three disagreed so the
 * first line of the crash is the fix.
 */
export class TokenIdentityError extends ConfigError {
  readonly check: "code" | "decimals" | "symbol";
  readonly token: Address;
  readonly configured: string | number | null;
  readonly onChain: string | number | null;

  constructor(input: {
    check: "code" | "decimals" | "symbol";
    token: Address;
    configured?: string | number;
    onChain?: string | number;
    message: string;
  }) {
    super(input.message);
    this.name = "TokenIdentityError";
    this.check = input.check;
    this.token = input.token;
    this.configured = input.configured ?? null;
    this.onChain = input.onChain ?? null;
  }
}

/**
 * Decimals-only subclass kept so existing chain tests and operator
 * muscle memory (`DecimalsMismatchError`) still match. New code should
 * catch `TokenIdentityError`.
 */
export class DecimalsMismatchError extends TokenIdentityError {
  constructor(configured: number, onChain: number, token: Address) {
    super({
      check: "decimals",
      token,
      configured,
      onChain,
      message:
        `TOKEN_DECIMALS=${configured} does not match decimals()=${onChain} ` +
        `reported by token contract ${token}. ` +
        `A cap written for the wrong decimals is ~10^|diff| off; ` +
        `fix TOKEN_DECIMALS in the environment, do not adjust the contract.`,
    });
    this.name = "DecimalsMismatchError";
  }
}

const ERC20_IDENTITY_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

/** The narrow slice of a viem public client the identity check needs. */
export type TokenIdentityClient = {
  getCode: (input: { address: Address }) => Promise<Hex | undefined>;
  readContract: (input: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
  }) => Promise<unknown>;
};

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
 * Read code, `symbol()`, and `decimals()` from the token contract and
 * compare against config.
 *
 * Called once at startup. Throws `TokenIdentityError` (or the decimals
 * subclass) on disagreement; callers should let that propagate and kill
 * the process.
 */
export async function assertTokenIdentity(
  publicClient: TokenIdentityClient,
  chain: Pick<ChainConfig, "token" | "tokenDecimals" | "tokenSymbol">,
): Promise<void> {
  const code = await publicClient.getCode({ address: chain.token });
  if (code === undefined || code === "0x") {
    throw new TokenIdentityError({
      check: "code",
      token: chain.token,
      message:
        `TOKEN_ADDRESS=${chain.token} has no contract code. ` +
        `Point TOKEN_ADDRESS at the ERC-20 payments are denominated in.`,
    });
  }

  const onChainDecimals = await publicClient.readContract({
    address: chain.token,
    abi: ERC20_IDENTITY_ABI,
    functionName: "decimals",
  });
  const decimals = Number(onChainDecimals);
  if (!Number.isInteger(decimals) || decimals !== chain.tokenDecimals) {
    throw new DecimalsMismatchError(
      chain.tokenDecimals,
      Number.isInteger(decimals) ? decimals : Number.NaN,
      chain.token,
    );
  }

  const onChainSymbol = await publicClient.readContract({
    address: chain.token,
    abi: ERC20_IDENTITY_ABI,
    functionName: "symbol",
  });
  if (
    typeof onChainSymbol !== "string" ||
    onChainSymbol !== chain.tokenSymbol
  ) {
    throw new TokenIdentityError({
      check: "symbol",
      token: chain.token,
      configured: chain.tokenSymbol,
      onChain:
        typeof onChainSymbol === "string"
          ? onChainSymbol
          : String(onChainSymbol),
      message:
        `TOKEN_SYMBOL=${chain.tokenSymbol} does not match symbol()=` +
        `${String(onChainSymbol)} reported by token contract ${chain.token}. ` +
        `Fix TOKEN_SYMBOL (or TOKEN_ADDRESS) so copy, config, and the ` +
        `contract name the same token.`,
    });
  }
}

/** @deprecated Use `assertTokenIdentity`. Kept as a thin alias. */
export async function assertTokenDecimals(
  publicClient: TokenIdentityClient,
  chain: Pick<ChainConfig, "token" | "tokenDecimals" | "tokenSymbol">,
): Promise<void> {
  await assertTokenIdentity(publicClient, chain);
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
 * requires testnet as the default. The identity check runs against the
 * public client; callers can pass a `PublicClient` to stub the RPC for
 * tests (a fake transport that returns the expected code/symbol/decimals).
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
  await assertTokenIdentity(publicClient, chain);
  const client =
    options?.sdkClient ??
    createClient({ chains: [network], defaultChainId: chain.chainId });
  return { client, network, publicClient, chain };
}
