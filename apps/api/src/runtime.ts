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
  buildAltanaClient,
  checkSessionAuthority,
  ConfigError,
  PERMIT2_ADDRESS,
  retryOnChainRevoke,
  revokeSession,
  SessionStore,
  signerFromPrivateKey,
  loadAppConfig,
  type AltanaClientContext,
  type PersistedSession,
  type RevokeSessionResult,
} from "@neuro-pay/altana";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import type {
  Address,
  Hex,
  RevokeResult,
  SessionStatus,
} from "@neuro-pay/types";

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
  close: () => Promise<void>;
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
  const sessionAuthority = createRuntimeSessionAuthority(config, sessions);

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
    ...(sessionAuthority.resolveStatus
      ? { resolveStatus: sessionAuthority.resolveStatus }
      : {}),
    ...(sessionAuthority.performRevoke
      ? { performRevoke: sessionAuthority.performRevoke }
      : {}),
    ...(sessionAuthority.performRetryRevoke
      ? { performRetryRevoke: sessionAuthority.performRetryRevoke }
      : {}),
  });
  hub.notify = () => consoleService.notify();

  void seller.reconcileSettlements().catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "settlement outbox reconciliation failed at startup",
    );
  });

  const sweepMs = Number.parseInt(env.STREAM_SWEEP_INTERVAL_MS ?? "30000", 10);
  const sweepTimer = setInterval(
    () => {
      void seller.sweepAbandoned().catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "abandoned-stream sweep failed",
        );
      });
    },
    Number.isFinite(sweepMs) && sweepMs > 0 ? sweepMs : 30_000,
  );
  sweepTimer.unref?.();

  return {
    console: consoleService,
    seller,
    close: async () => {
      clearInterval(sweepTimer);
      await seller.shutdown();
      consoleService.close();
      ledger.close();
    },
  };
}

function createRuntimeVerifier(
  config: ReturnType<typeof loadAppConfig>,
): (input: { payer: Address; hash: Hex; signature: Hex }) => Promise<Hex> {
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

/**
 * Wire the on-chain session authority read and the two-stage revoke.
 *
 * The authority read (`checkSessionAuthority`) is a free Keystore view and
 * needs only `RPC_URL`; it is wired whenever that is set. On-chain revoke
 * additionally needs `ADMIN_PRIVATE_KEY` — the same authority that granted
 * the session. Missing either falls back to `undefined`, which leaves the
 * console reporting local-only session status and local-only revoke state,
 * same as before this wiring existed.
 *
 * The Altana client is built once (lazily, on first use) and reused for
 * every authority read and every revoke — `buildAltanaClient` asserts
 * token decimals against the chain, which is one RPC round trip we don't
 * want repeated on every `/v1/session` poll.
 */
function createRuntimeSessionAuthority(
  config: ReturnType<typeof loadAppConfig>,
  sessions: SessionStore,
): {
  resolveStatus?: (session: PersistedSession) => Promise<SessionStatus>;
  performRevoke?: (session: PersistedSession) => Promise<RevokeResult>;
  performRetryRevoke?: (session: PersistedSession) => Promise<RevokeResult>;
} {
  const rpcUrl = config.chain.rpcUrl;
  if (!rpcUrl) {
    logger.warn(
      "RPC_URL not set — on-chain session authority reads are disabled. " +
        "The console reports local-only session status (expiry + rail flag only).",
    );
    return {};
  }

  let ctxPromise: Promise<AltanaClientContext> | undefined;
  const getCtx = (): Promise<AltanaClientContext> => {
    if (!ctxPromise) ctxPromise = buildAltanaClient(config.chain);
    return ctxPromise;
  };

  const resolveStatus = async (
    persisted: PersistedSession,
  ): Promise<SessionStatus> => {
    if (!persisted.railProvisioned) return "unprovisioned";
    try {
      const ctx = await getCtx();
      const authority = await checkSessionAuthority({
        session: persisted,
        network: ctx.network,
        publicClient: ctx.publicClient,
      });
      return authority.status;
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "session authority read failed — reporting status as unknown",
      );
      return "unknown";
    }
  };

  const adminPrivateKey = config.secrets.adminPrivateKey;
  if (!adminPrivateKey) {
    logger.warn(
      "ADMIN_PRIVATE_KEY not set — on-chain revoke is disabled. " +
        "The revoke endpoint still stops local signing but cannot submit " +
        "revokeSession on chain.",
    );
    return { resolveStatus };
  }

  const adminSigner = signerFromPrivateKey(adminPrivateKey);

  const toRevokeResult = (
    outcome: Pick<
      RevokeSessionResult,
      "onChainRevoked" | "onChainStatus" | "onChainTransactionHash"
    >,
    localRevoked: boolean,
  ): RevokeResult => ({
    local: { revoked: localRevoked },
    onChain: {
      revoked: outcome.onChainRevoked,
      status: outcome.onChainStatus,
      transactionHash: outcome.onChainTransactionHash,
    },
  });

  const performRevoke = async (
    persisted: PersistedSession,
  ): Promise<RevokeResult> => {
    const ctx = await getCtx();
    const outcome = await revokeSession(sessions, {
      client: ctx.client,
      wallet: { address: persisted.walletAddress } as never,
      adminSigner,
    });
    return toRevokeResult(outcome, outcome.localRevoked);
  };

  const performRetryRevoke = async (
    persisted: PersistedSession,
  ): Promise<RevokeResult> => {
    const ctx = await getCtx();
    const outcome = await retryOnChainRevoke({
      client: ctx.client,
      wallet: { address: persisted.walletAddress } as never,
      adminSigner,
      session: persisted,
    });
    // Local was already true — that's why this is a retry of the on-chain
    // stage only. `retryOnChainRevoke` never touches the store.
    return toRevokeResult(outcome, true);
  };

  return { resolveStatus, performRevoke, performRetryRevoke };
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
    putDelivery: (record) => store.putDelivery(record),
    getDelivery: (nonce) => store.getDelivery(nonce),
    listDeliveryNonces: () => store.listDeliveryNonces(),
    putIntent: (intent) => store.putIntent(intent),
    getIntent: (nonce) => store.getIntent(nonce),
    listIntents: (status) => store.listIntents(status),
    updateIntent: (nonce, patch) => store.updateIntent(nonce, patch),
  };
}
