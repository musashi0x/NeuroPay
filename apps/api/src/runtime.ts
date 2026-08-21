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
import { createOpsService, type OpsService } from "./ops/service.js";
import {
  DEFAULT_ALERT_THRESHOLDS,
  type AlertThresholds,
  type Probe,
} from "./ops/health.js";
import {
  ledgerProbe,
  permit2Probe,
  rpcProbe,
  sessionAuthorityProbe,
  settlerBalanceProbe,
  skippedProbe,
  tokenIdentityProbe,
  type ProbeClient,
} from "./ops/probes.js";
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
import {
  createAutoRevokeWatcher,
  type AutoRevokeWatcher,
} from "./console/auto-revoke-watcher.js";
import { logger } from "./logger.js";
import { CONSOLE_TOKEN_ENV, resolveConsoleAuth } from "./auth.js";

export type PaymentRuntime = {
  console: ConsoleService;
  seller: Seller;
  ops: OpsService;
  ledger: LedgerStore;
  /**
   * Auto-revoke-on-failure watcher. Process-local; the flag defaults
   * to disarmed and resets on every restart. Exposed for the
   * operator routes (`GET/PUT /v1/session/auto-revoke`).
   */
  autoRevoke: AutoRevokeWatcher;
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

  // Surface the console's auth posture at boot. An open kill switch is
  // the kind of thing an operator should learn from the startup log, not
  // from an incident.
  const consoleAuthMode = resolveConsoleAuth(env);
  if (consoleAuthMode.kind === "disabled") {
    logger.warn(
      { reason: consoleAuthMode.reason },
      `${CONSOLE_TOKEN_ENV} is not set — the operator console is UNAUTHENTICATED. ` +
        "Anyone who can reach this port can read session policy and payment " +
        "history, and can revoke the session. Acceptable on a local dev box; " +
        "never in a deployment. Generate one with `openssl rand -hex 32`.",
    );
  }

  const priceSheet = readInitialPriceSheet(env);
  const alertThresholds = readAlertThresholds(env);

  const sessionPath = env.SESSION_STORE_PATH ?? ".data/session.json";
  const ledgerPath = env.LEDGER_PATH ?? ".data/ledger.sqlite";
  mkdirSync(dirname(sessionPath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const sessions = new SessionStore({ fileStorePath: sessionPath });
  const ledger = openLedgerStore({
    storagePath: ledgerPath,
    // A schema upgrade rewrites a durable file. It happens automatically
    // because refusing to start on a stale file would be worse, but it
    // is never silent.
    onMigrate: (report) => {
      if (report.applied.length === 0) return;
      logger.info(
        {
          from: report.from,
          to: report.to,
          applied: report.applied.map((a) => `${a.version}:${a.name}`),
        },
        "ledger schema migrated",
      );
    },
  });
  const hub: { notify: () => void } = { notify() {} };

  const verifier = createRuntimeVerifier(config);
  const {
    settler,
    settlerAddress,
    chainBacked: settlerOnChain,
  } = createRuntimeSettler(config, ledger, env);
  const sessionAuthority = createRuntimeSessionAuthority(config, sessions);

  const seller = createSeller({
    initialPriceSheet: priceSheet,
    config: {
      metering: config.metering,
      payTo: config.chain.payTo,
      chainId: config.chain.chainId,
      token: config.chain.token,
      tokenDecimals: config.chain.tokenDecimals,
      settlerAddress,
      ...(readOptionalPositiveInt(env, "MAX_CONCURRENT_STREAMS") !== undefined
        ? {
            maxConcurrentStreams: readOptionalPositiveInt(
              env,
              "MAX_CONCURRENT_STREAMS",
            )!,
          }
        : {}),
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

  const probeClient = createProbeClient(config);
  const ops = createOpsService({
    ledger,
    probes: buildProbes({
      config,
      ledger,
      probeClient,
      settlerAddress,
      settlerOnChain,
      thresholds: alertThresholds,
      readSessionStatus: async () => {
        const [wallet] = sessions.list();
        if (!wallet) return null;
        const persisted = sessions.read(wallet);
        if (!persisted) return null;
        return sessionAuthority.resolveStatus
          ? await sessionAuthority.resolveStatus(persisted)
          : null;
      },
    }),
    exposureStats: () => {
      const stats = seller.exposureStats();
      return { inFlight: stats.inFlight, ceiling: stats.ceiling };
    },
    getBudget: () => consoleService.getBudget(),
    getSession: () => consoleService.getSession(),
    ...(settlerOnChain && probeClient
      ? {
          settler: {
            address: settlerAddress,
            readBalanceWei: () =>
              probeClient.getBalance({ address: settlerAddress }),
          },
        }
      : {}),
    thresholds: alertThresholds,
  });

  const autoRevoke = createAutoRevokeWatcher({
    ledger,
    sessions,
    consoleService,
    ops,
    failedSettlementCritical: alertThresholds.failedSettlementCritical,
    sweepIntervalMs: readOptionalPositiveInt(env, "STREAM_SWEEP_INTERVAL_MS"),
  });

  // The audit trail's first record. A process that started is the
  // context every later administrative action is read against — without
  // it, a revoke at 03:00 gives no way to tell whether the process had
  // been up for a week or had just restarted into a bad config.
  void ledger
    .appendAudit({
      action: "config.loaded",
      actor: "system",
      outcome: "succeeded",
      subject: `chain:${config.chain.chainId}`,
      detail: describeEffectiveConfig(config, {
        settlerOnChain,
        consoleAuthenticated: consoleAuthMode.kind !== "disabled",
        verifierOnChain: Boolean(config.chain.rpcUrl),
      }),
    })
    .then(() =>
      ledger.appendAudit({
        action: "process.started",
        actor: "system",
        outcome: "succeeded",
      }),
    )
    .catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to record process start in the audit trail",
      );
    });

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
    ops,
    ledger,
    autoRevoke,
    close: async () => {
      clearInterval(sweepTimer);
      autoRevoke.close();
      await seller.shutdown();
      try {
        await ledger.appendAudit({
          action: "process.stopped",
          actor: "system",
          outcome: "succeeded",
        });
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to record process stop in the audit trail",
        );
      }
      consoleService.close();
      ledger.close();
    },
  };
}

/**
 * A viem client used only by the readiness probes.
 *
 * Deliberately separate from the verifier's and the settler's clients:
 * a probe must be able to report that the RPC is unreachable, and it
 * cannot do that if constructing it is what failed. Returns null when
 * no `RPC_URL` is configured, which the probe builder reads as "skip
 * the chain probes" rather than "the chain is down".
 */
function createProbeClient(
  config: ReturnType<typeof loadAppConfig>,
): ProbeClient | null {
  const rpcUrl = config.chain.rpcUrl;
  if (!rpcUrl) return null;
  try {
    const client = createPublicClient({
      chain: viemChainFor(config.chain.chainId),
      transport: http(rpcUrl),
    });
    return client as unknown as ProbeClient;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "readiness probe client could not be constructed; chain probes are skipped",
    );
    return null;
  }
}

/**
 * Assemble the probe set for this deployment.
 *
 * Every probe is always present in the report. A dependency that is not
 * wired reports `skipped` with the reason rather than being omitted,
 * because a missing line in a health report reads as "fine" and an
 * unconfigured settler is not fine in production — it is just not an
 * error the process can decide about on its own.
 */
function buildProbes(input: {
  config: ReturnType<typeof loadAppConfig>;
  ledger: LedgerStore;
  probeClient: ProbeClient | null;
  settlerAddress: Address;
  settlerOnChain: boolean;
  thresholds: AlertThresholds;
  readSessionStatus: () => Promise<string | null>;
}): Probe[] {
  const { probeClient, config } = input;
  const noRpc = "RPC_URL is not configured";

  return [
    probeClient
      ? rpcProbe(probeClient, config.chain.chainId)
      : skippedProbe("rpc", noRpc),
    probeClient
      ? tokenIdentityProbe(probeClient, config.chain.token, {
          decimals: config.chain.tokenDecimals,
          symbol: config.chain.tokenSymbol,
        })
      : skippedProbe("token-identity", noRpc),
    probeClient
      ? permit2Probe(probeClient, PERMIT2_ADDRESS as Address)
      : skippedProbe("permit2", noRpc),
    probeClient && input.settlerOnChain
      ? settlerBalanceProbe(
          probeClient,
          input.settlerAddress,
          input.thresholds.settlerBalanceFloorWei,
        )
      : skippedProbe(
          "settler-balance",
          input.settlerOnChain
            ? noRpc
            : "SETTLER_PRIVATE_KEY is not configured; settlement is in-memory only",
        ),
    ledgerProbe(input.ledger),
    sessionAuthorityProbe(input.readSessionStatus),
  ];
}

/**
 * Alert thresholds from the environment, falling back to the defaults.
 *
 * A malformed value is fatal rather than ignored, for the same reason a
 * malformed `MAX_CONCURRENT_STREAMS` is: an operator who set a threshold
 * and silently got the default is worse off than one whose process
 * refused to start.
 */
function readAlertThresholds(env: NodeJS.ProcessEnv): AlertThresholds {
  return {
    failedSettlementWarn:
      readOptionalPositiveInt(env, "ALERT_FAILED_SETTLEMENTS_WARN") ??
      DEFAULT_ALERT_THRESHOLDS.failedSettlementWarn,
    failedSettlementCritical:
      readOptionalPositiveInt(env, "ALERT_FAILED_SETTLEMENTS_CRITICAL") ??
      DEFAULT_ALERT_THRESHOLDS.failedSettlementCritical,
    settlerBalanceFloorWei:
      readOptionalBigint(env, "SETTLER_MIN_BALANCE_WEI") ??
      DEFAULT_ALERT_THRESHOLDS.settlerBalanceFloorWei,
    sessionExpiryWarnSeconds:
      readOptionalPositiveInt(env, "ALERT_SESSION_EXPIRY_WARN_SECONDS") ??
      DEFAULT_ALERT_THRESHOLDS.sessionExpiryWarnSeconds,
  };
}

/**
 * One line describing what the process actually wired, for the audit
 * trail.
 *
 * Names no secret and no host — an audit record is exportable by
 * definition, and "which RPC endpoint" is not worth putting in a file
 * meant to be shared. What it does record is every choice that changes
 * whether payments are real: stub verifier or chain, in-memory settler
 * or chain, console open or authenticated.
 */
function describeEffectiveConfig(
  config: ReturnType<typeof loadAppConfig>,
  posture: {
    settlerOnChain: boolean;
    consoleAuthenticated: boolean;
    verifierOnChain: boolean;
  },
): string {
  return [
    `chainId=${config.chain.chainId}`,
    `token=${config.chain.token}`,
    `tokenDecimals=${config.chain.tokenDecimals}`,
    `tokenSymbol=${config.chain.tokenSymbol}`,
    `payTo=${config.chain.payTo}`,
    `settlementThreshold=${config.metering.settlementThreshold}`,
    `tickIntervalSeconds=${config.metering.tickIntervalSeconds}`,
    `maxInFlightSettlements=${config.metering.maxInFlightSettlements}`,
    `budgetMargin=${config.metering.budgetMargin}`,
    `verifier=${posture.verifierOnChain ? "chain" : "stub"}`,
    `settler=${posture.settlerOnChain ? "chain" : "in-memory"}`,
    `consoleAuth=${posture.consoleAuthenticated ? "on" : "off"}`,
  ].join(" ");
}

/** Read an optional non-negative bigint (decimal digits) from the environment. */
function readOptionalBigint(
  env: NodeJS.ProcessEnv,
  name: string,
): bigint | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(
      `${name} must be digits only (got ${JSON.stringify(raw)})`,
    );
  }
  return BigInt(raw);
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
): {
  settler: import("./seller/settle.js").Settler;
  /** The address published in the 402 as `extra.spenderAddress`. */
  settlerAddress: Address;
  /**
   * True only when a real EOA submits to a real chain. The readiness
   * probes use this to tell "no settler configured" (skip the balance
   * check) from "settler configured and broke".
   */
  chainBacked: boolean;
} {
  const rpcUrl = config.chain.rpcUrl;
  const pk = env["SETTLER_PRIVATE_KEY"];

  if (!rpcUrl || !pk) {
    logger.warn(
      "RPC_URL or SETTLER_PRIVATE_KEY missing — using in-memory settler " +
        "(defaultBehavior: confirm). This is fine for local dev but no " +
        "settlement ever reaches the chain. The 402 advertises `payTo` as " +
        "the Permit2 spender, so signatures produced against this process " +
        "are NOT settleable on chain — configure a settler key before " +
        "treating a local payment as real.",
    );
    return {
      settler: createInMemorySettler({ defaultBehavior: "confirm" }),
      settlerAddress: config.chain.payTo,
      chainBacked: false,
    };
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

    return {
      settler: createChainBackedSettler({
        walletClient,
        publicClient,
        settlerAddress: account.address,
        permit2Address: PERMIT2_ADDRESS,
        chainId: config.chain.chainId,
        ledger,
        lostTxTimeoutMs: 60_000,
      }),
      // The address the buyer must bind as the Permit2 spender. It is the
      // settler EOA, not `payTo`: Permit2 checks the signed spender
      // against `msg.sender` of the settlement call, and this account is
      // what sends it.
      settlerAddress: account.address as Address,
      chainBacked: true,
    };
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
      },
      "settler wiring failed; falling back to in-memory settler",
    );
    return {
      settler: createInMemorySettler({ defaultBehavior: "confirm" }),
      settlerAddress: config.chain.payTo,
      chainBacked: false,
    };
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

/**
 * Read an optional positive integer from the environment.
 *
 * Undefined means "no ceiling", which is a legitimate local-dev choice.
 * A present but malformed value is fatal rather than ignored: an
 * operator who set a limit and got none because of a typo is worse off
 * than one whose process refused to start.
 */
function readOptionalPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new TypeError(
      `${name} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return Number(raw);
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
    // Audit and schema reads pass straight through: only payment
    // appends drive the console's live snapshot.
    appendAudit: (input) => store.appendAudit(input),
    auditEvents: (query) => store.auditEvents(query),
    schemaInfo: () => store.schemaInfo(),
  };
}
