/**
 * Optional payment runtime. The API still boots `/health` when chain
 * config is missing; the console and seller attach only when
 * `loadAppConfig` succeeds.
 *
 * ## What runs here
 *
 * When `RPC_URL` and `SETTLER_PRIVATE_KEY` are both set in the
 * environment, the runtime mounts:
 *
 *  - a **chain-backed Permit2 verifier** (`createChainBackedVerifier`) that
 *    reads `isValidSignature` from the canonical Permit2 address over a
 *    viem `PublicClient`.
 *  - a **chain-backed settler** (`createChainBackedSettler`) that submits
 *    `permitWitnessTransferFrom` from the configured settler EOA and
 *    polls `getTransactionReceipt` until the tx confirms or times out.
 *
 * When either is missing the runtime falls back to the in-memory
 * stubs (`IS_VALID_SIGNATURE_MAGIC` verifier + `createInMemorySettler`)
 * with a logged warning, so a local dev process that has no chain can
 * still run the seller / console without surprises.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ConfigError,
  PERMIT2_ADDRESS,
  SessionStore,
  loadAppConfig,
} from "@neuro-pay/altana";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import { createPublicClient, createWalletClient, http, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import type { Address, Hex } from "@neuro-pay/types";

import { createSeller, type Seller } from "./seller/index.js";
import { createInMemorySettler } from "./seller/settle.js";
import { IS_VALID_SIGNATURE_MAGIC } from "./seller/verify.js";
import { createChainBackedVerifier } from "./seller/chain-verifier.js";
import { createChainBackedSettler } from "./seller/chain-settler.js";
import {
  createConsoleService,
  type ConsoleService,
} from "./console/service.js";
import { logger } from "./logger.js";

export type PaymentRuntime = {
  console: ConsoleService;
  seller: Seller;
  close: () => void;
};

export function tryCreateRuntime(
  env: NodeJS.ProcessEnv = process.env,
): PaymentRuntime | null {
  let config;
  try {
    config = loadAppConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.warn(
        { err: { name: err.name, message: err.message } },
        "payment runtime disabled — console and seller routes are not mounted",
      );
      return null;
    }
    throw err;
  }

  const priceSheet = readInitialPriceSheet(env);

  const sessionPath = env.SESSION_STORE_PATH ?? ".data/session.json";
  const ledgerPath = env.LEDGER_PATH ?? ".data/ledger.sqlite";
  mkdirSync(dirname(sessionPath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const sessions = new SessionStore({ fileStorePath: sessionPath });
  const ledger = openLedgerStore({ storagePath: ledgerPath });
  const hub: { notify: () => void } = { notify() {} };

  const verifier = createRuntimeVerifier(config);
  const settler = createRuntimeSettler(config, ledger, env);

  const seller = createSeller({
    initialPriceSheet: priceSheet,
    config: {
      metering: config.metering,
      payTo: config.chain.payTo,
      chainId: config.chain.chainId,
      token: config.chain.token,
      tokenDecimals: config.chain.tokenDecimals,
    },
    store: watchLedger(ledger, () => hub.notify()),
    verifier,
    settler,
  });

  const consoleService = createConsoleService({
    config,
    sessions,
    ledger,
    seller,
  });
  hub.notify = () => consoleService.notify();

  return {
    console: consoleService,
    seller,
    close: () => ledger.close(),
  };
}

function createRuntimeVerifier(
  config: ReturnType<typeof loadAppConfig>,
): (input: {
  payer: Address;
  hash: Hex;
  signature: Hex;
}) => Promise<Hex> {
  const rpcUrl = config.chain.rpcUrl;
  if (!rpcUrl) {
    logger.warn(
      "RPC_URL not set — using stub verifier (accepts every envelope). " +
        "This is fine for local dev but every payment is unsigned on chain.",
    );
    return async () => IS_VALID_SIGNATURE_MAGIC;
  }

  try {
    const publicClient = createPublicClient({
      chain: viemChainFor(config.chain.chainId),
      transport: http(rpcUrl),
    }) as PublicClient<Transport>;

    return createChainBackedVerifier({
      publicClient,
      permit2Address: PERMIT2_ADDRESS,
      chainId: config.chain.chainId,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
      },
      "verifier wiring failed; falling back to stub verifier",
    );
    return async () => IS_VALID_SIGNATURE_MAGIC;
  }
}

function createRuntimeSettler(
  config: ReturnType<typeof loadAppConfig>,
  ledger: LedgerStore,
  env: NodeJS.ProcessEnv,
): import("./seller/settle.js").Settler {
  const rpcUrl = config.chain.rpcUrl;
  const pk = env["SETTLER_PRIVATE_KEY"];

  if (!rpcUrl || !pk) {
    logger.warn(
      "RPC_URL or SETTLER_PRIVATE_KEY missing — using in-memory settler " +
        "(defaultBehavior: confirm). This is fine for local dev but no " +
        "settlement ever reaches the chain.",
    );
    return createInMemorySettler({ defaultBehavior: "confirm" });
  }

  try {
    const account = privateKeyToAccount(pk as Hex);
    const chain = viemChainFor(config.chain.chainId);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    return createChainBackedSettler({
      walletClient,
      publicClient,
      spenderAddress: config.chain.payTo,
      permit2Address: PERMIT2_ADDRESS,
      chainId: config.chain.chainId,
      ledger,
      lostTxTimeoutMs: 60_000,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
      },
      "settler wiring failed; falling back to in-memory settler",
    );
    return createInMemorySettler({ defaultBehavior: "confirm" });
  }
}

function viemChainFor(chainId: number) {
  return chainId === bscTestnet.id ? bscTestnet : bsc;
}

function readInitialPriceSheet(env: NodeJS.ProcessEnv): {
  perCall: bigint;
  perSecond: bigint;
  perUnit: bigint;
  unitName: string;
} {
  return {
    perCall: readSmallestUnits(env, "PRICE_PER_CALL"),
    perSecond: readSmallestUnits(env, "PRICE_PER_SECOND"),
    perUnit: readSmallestUnits(env, "PRICE_PER_UNIT"),
    unitName: env.PRICE_UNIT_NAME ?? "unit",
  };
}

function readSmallestUnits(env: NodeJS.ProcessEnv, name: string): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return 0n;
  if (!/^\d+$/.test(raw.trim())) {
    throw new TypeError(
      `${name} must be digits only, in smallest token units (got ${JSON.stringify(raw)})`,
    );
  }
  return BigInt(raw.trim());
}

function watchLedger(store: LedgerStore, onAppend: () => void): LedgerStore {
  return {
    append: async (input) => {
      const entry = await store.append(input);
      onAppend();
      return entry;
    },
    entries: () => store.entries(),
    size: () => store.size(),
    close: () => store.close(),
  };
}
