/**
 * Console read model: session policy, streams, budget, ledger history,
 * two-stage revoke, and a live-update hub.
 *
 * The service is the only thing the HTTP layer talks to. Tests inject a
 * fake; production wires session store + ledger + seller + revoke.
 */

import { computeLocalLimit, type MeterState } from "@neuro-pay/metering";
import {
  computeWindowSpend,
  fraction,
  recordSessionRevoked,
  recordStreamEnded,
  type LedgerStore,
} from "@neuro-pay/ledger";
import type {
  Address,
  AppConfig,
  BudgetState,
  ConsoleSnapshot,
  Hex,
  LedgerEntry,
  RevokeResult,
  SessionCallPermission,
  SessionPolicyView,
  SessionStatus,
  SmallestUnits,
  StreamView,
} from "@neuro-pay/types";
import type {
  PersistedCallPermission,
  PersistedSession,
  SessionStore,
} from "@neuro-pay/altana";
import type { Seller } from "../seller/index.js";

export type ConsoleLiveEvent = {
  type: "snapshot";
  snapshot: ConsoleSnapshot;
};

export type ConsoleService = {
  getSession(): Promise<SessionPolicyView | null>;
  listStreams(): Promise<StreamView[]>;
  listPayments(): Promise<LedgerEntry[]>;
  getBudget(): Promise<BudgetState | null>;
  snapshot(): Promise<ConsoleSnapshot>;
  revoke(): Promise<RevokeResult>;
  subscribe(listener: (event: ConsoleLiveEvent) => void): () => void;
  notify(): void;
};

export type CreateConsoleServiceInput = {
  config: AppConfig;
  sessions: SessionStore;
  ledger: LedgerStore;
  seller?: Pick<Seller, "inspectStreams" | "endAll">;
  now?: () => number;
  resolveStatus?: (session: PersistedSession) => Promise<SessionStatus>;
  performRevoke?: (session: PersistedSession) => Promise<RevokeResult>;
};

const PERIOD_SECONDS: Record<string, number> = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

export function createConsoleService(
  input: CreateConsoleServiceInput,
): ConsoleService {
  const nowMs = input.now ?? Date.now;
  const listeners = new Set<(event: ConsoleLiveEvent) => void>();

  const service: ConsoleService = {
    async getSession() {
      const persisted = activeSession(input.sessions);
      if (!persisted) return null;
      return toPolicyView(
        persisted,
        input.config,
        nowMs(),
        input.resolveStatus
          ? await input.resolveStatus(persisted)
          : localStatus(persisted, nowMs()),
      );
    },

    async listStreams() {
      return buildStreamViews(input, nowMs());
    },

    async listPayments() {
      return input.ledger.entries();
    },

    async getBudget() {
      return buildBudget(input, nowMs());
    },

    async snapshot() {
      const [session, streams, budget, payments] = await Promise.all([
        service.getSession(),
        service.listStreams(),
        service.getBudget(),
        service.listPayments(),
      ]);
      return { session, streams, budget, payments };
    },

    async revoke() {
      const persisted = activeSession(input.sessions);
      if (!persisted) {
        throw new ConsoleNotFoundError("no active session to revoke");
      }

      const result = input.performRevoke
        ? await input.performRevoke(persisted)
        : {
            local: { revoked: input.sessions.remove(persisted.walletAddress) },
            onChain: { revoked: false, status: null, transactionHash: null },
          };

      const ended = input.seller?.endAll("session-revoked") ?? [];
      for (const streamId of ended) {
        await recordStreamEnded({
          store: input.ledger,
          ctx: {
            streamId,
            sessionPublicKey: persisted.publicKey,
            chainId: input.config.chain.chainId,
            token: input.config.chain.token,
            tokenDecimals: input.config.chain.tokenDecimals,
          },
          reason: "session-revoked",
        });
      }

      await recordSessionRevoked({
        store: input.ledger,
        sessionPublicKey: persisted.publicKey,
        chainId: input.config.chain.chainId,
        token: input.config.chain.token,
        tokenDecimals: input.config.chain.tokenDecimals,
        stage: result.onChain.revoked ? "both" : "local",
        transactionHash: result.onChain.transactionHash,
        detail: `local=${result.local.revoked} onChain=${result.onChain.revoked} status=${result.onChain.status ?? "null"}`,
      });

      service.notify();
      return result;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    notify() {
      void service.snapshot().then((snapshot) => {
        const event: ConsoleLiveEvent = { type: "snapshot", snapshot };
        for (const listener of listeners) listener(event);
      });
    },
  };

  return service;
}

export class ConsoleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleNotFoundError";
  }
}

function activeSession(store: SessionStore): PersistedSession | undefined {
  const [wallet] = store.list();
  if (!wallet) return undefined;
  return store.read(wallet);
}

function localStatus(session: PersistedSession, now: number): SessionStatus {
  if (now >= session.expiry * 1000) return "expired";
  if (!session.railProvisioned) return "unprovisioned";
  return "active";
}

function toPolicyView(
  session: PersistedSession,
  config: AppConfig,
  now: number,
  status: SessionStatus,
): SessionPolicyView {
  const spend = session.permissions.spend[0];
  const periodSeconds = spend
    ? (PERIOD_SECONDS[spend.period] ?? config.session.spendPeriodSeconds)
    : config.session.spendPeriodSeconds;
  const remainingLifetimeSeconds = Math.max(
    0,
    session.expiry - Math.floor(now / 1000),
  );
  return {
    walletAddress: session.walletAddress,
    publicKey: session.publicKey,
    status,
    allowedCalls: session.permissions.calls.map(toCallPermission),
    spendCap: {
      token: (spend?.token ?? config.chain.token) as Address,
      tokenDecimals: config.chain.tokenDecimals,
      limit: (spend?.limit ?? config.session.spendCap) as SmallestUnits,
      periodSeconds,
    },
    expiresAt: new Date(session.expiry * 1000).toISOString(),
    remainingLifetimeSeconds,
    grantTransactionHash: session.grantTransactionHash,
    railProvisioned: session.railProvisioned,
  };
}

function toCallPermission(
  call: PersistedCallPermission,
): SessionCallPermission {
  const selector =
    typeof call.signature === "string" &&
    /^0x[0-9a-fA-F]{8}$/.test(call.signature)
      ? (call.signature as Hex)
      : null;
  return {
    to: (call.to ?? "0x0000000000000000000000000000000000000000") as Address,
    selector,
  };
}

async function buildStreamViews(
  input: CreateConsoleServiceInput,
  now: number,
): Promise<StreamView[]> {
  const inspections = input.seller?.inspectStreams() ?? [];
  const entries = await input.ledger.entries();
  return inspections.map((stream) => {
    const inFlightSettlements = countInFlight(entries, stream.id);
    return {
      streamId: stream.id,
      status: stream.endReason === null ? "active" : "ended",
      endReason: stream.endReason,
      priceSheet: stream.priceSheet,
      accruedUnpaid: stream.meter.accruedUnpaid,
      totalAccrued: stream.meter.totalAccrued,
      deliveredCalls: stream.meter.deliveredCalls,
      deliveredSeconds: stream.meter.deliveredSeconds,
      deliveredUnits: stream.meter.deliveredUnits,
      secondsUntilNextTick: secondsUntilTick(
        stream.meter,
        input.config.metering.tickIntervalSeconds,
        now,
      ),
      inFlightSettlements,
      openedAt: stream.openedAt,
      expiresAt: stream.expiresAt,
    };
  });
}

function secondsUntilTick(
  meter: MeterState,
  tickIntervalSeconds: number,
  now: number,
): number {
  if (meter.lastPaidAtMs === null) return tickIntervalSeconds;
  const elapsed = Math.floor((now - meter.lastPaidAtMs) / 1000);
  return Math.max(0, tickIntervalSeconds - elapsed);
}

function countInFlight(entries: LedgerEntry[], streamId: string): number {
  const submitted = new Set<string>();
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.streamId !== streamId || entry.nonce === null) continue;
    if (entry.event === "settlement.submitted") submitted.add(entry.nonce);
    if (
      entry.event === "settlement.confirmed" ||
      entry.event === "settlement.failed"
    ) {
      settled.add(entry.nonce);
    }
  }
  let count = 0;
  for (const nonce of submitted) {
    if (!settled.has(nonce)) count += 1;
  }
  return count;
}

async function buildBudget(
  input: CreateConsoleServiceInput,
  now: number,
): Promise<BudgetState | null> {
  const persisted = activeSession(input.sessions);
  if (!persisted) return null;

  const spend = persisted.permissions.spend[0];
  const token = (spend?.token ?? input.config.chain.token) as Address;
  const onChainCap = (spend?.limit ??
    input.config.session.spendCap) as SmallestUnits;
  const periodSeconds = spend
    ? (PERIOD_SECONDS[spend.period] ?? input.config.session.spendPeriodSeconds)
    : input.config.session.spendPeriodSeconds;

  const retentionBps = Math.round(
    (1 - input.config.metering.budgetMargin) * 10_000,
  );
  const spendWindow = await computeWindowSpend(input.ledger, {
    sessionPublicKey: persisted.publicKey,
    token,
    onChainCap,
    budgetMarginFraction: fraction(BigInt(retentionBps) * 10n ** 14n),
    nowMs: now,
    periodMs: periodSeconds * 1000,
  });

  const localLimit = computeLocalLimit(
    onChainCap,
    input.config.metering.budgetMargin,
  );

  return {
    token,
    tokenDecimals: input.config.chain.tokenDecimals,
    windowStart: new Date(now - periodSeconds * 1000).toISOString(),
    windowEnd: new Date(now).toISOString(),
    periodSeconds,
    spent: spendWindow.windowSpend,
    localLimit,
    localRemaining: spendWindow.remainingLocalBudget,
    onChainCap,
    onChainRemaining: spendWindow.remainingOnChainCap,
    exhausted: spendWindow.remainingLocalBudget === 0n,
  };
}
