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
  type LedgerStore,
} from "@neuro-pay/ledger";
import type {
  Address,
  AppConfig,
  AuditAction,
  AuditOutcome,
  BudgetState,
  ConsoleSnapshot,
  CursorPage,
  Hex,
  LedgerEntry,
  RevokeResult,
  SessionCallPermission,
  SessionPolicyView,
  SessionStatus,
  SmallestUnits,
  StreamView,
} from "@neuro-pay/types";
import {
  SNAPSHOT_PAYMENT_CAP,
  streamStatusFromEndReason,
} from "@neuro-pay/types";
import {
  paginatePayments,
  paginateStreams,
  type PaymentListQuery,
  type StreamListQuery,
} from "./page.js";
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
  listStreams(query?: StreamListQuery): Promise<CursorPage<StreamView>>;
  listPayments(query?: PaymentListQuery): Promise<CursorPage<LedgerEntry>>;
  getBudget(): Promise<BudgetState | null>;
  snapshot(): Promise<ConsoleSnapshot>;
  revoke(context?: OperatorContext): Promise<RevokeResult>;
  /** Resubmit the on-chain stage of a revoke whose first attempt failed. */
  retryRevoke(context?: OperatorContext): Promise<RevokeResult>;
  /**
   * Operator recovery: move a failed settlement intent back to pending
   * and resubmit it. Throws `ConsoleNotFoundError` when the nonce is
   * unknown or the deployment has no settlement queue wired.
   */
  retrySettlement(
    nonce: string,
    context?: OperatorContext,
  ): Promise<{ transactionHash: Hex }>;
  subscribe(listener: (event: ConsoleLiveEvent) => void): () => void;
  notify(): void;
  /** Abort live SSE connections and drop subscribers. */
  close(): void;
  /** Register a closer invoked by `close()` so SSE handlers can abort. */
  registerSseAbort(abort: () => void): () => void;
};

/**
 * Who asked, and under which HTTP request.
 *
 * Threaded from the route rather than defaulted inside the service so
 * an action taken by a script and an action taken through the console
 * are distinguishable in the trail — the whole point of recording an
 * actor is that it is not always the same one.
 */
export type OperatorContext = {
  actor?: string;
  requestId?: string | null;
};

export type CreateConsoleServiceInput = {
  config: AppConfig;
  sessions: SessionStore;
  ledger: LedgerStore;
  seller?: Pick<Seller, "inspectStreams" | "endAll"> &
    Partial<Pick<Seller, "retrySettlement">>;
  now?: () => number;
  resolveStatus?: (session: PersistedSession) => Promise<SessionStatus>;
  performRevoke?: (session: PersistedSession) => Promise<RevokeResult>;
  /**
   * Resubmit the on-chain stage only, given the persisted snapshot from
   * the failed attempt (the store no longer has the record — local
   * revocation already removed it). `local.revoked` on the result is
   * expected to be `true`, since the local stage isn't repeated.
   */
  performRetryRevoke?: (session: PersistedSession) => Promise<RevokeResult>;
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
  const sseAborts = new Set<() => void>();
  /**
   * The persisted snapshot of a session whose local revoke succeeded but
   * on-chain revoke did not, kept so `retryRevoke()` can resubmit without
   * a store lookup (the record is already gone from the store). Cleared
   * once the on-chain stage confirms.
   */
  let pendingRevoke: PersistedSession | undefined;

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

    async listStreams(query = {}) {
      const streams = await buildStreamViews(input, nowMs());
      return paginateStreams(streams, query);
    },

    async listPayments(query = {}) {
      const payments = await input.ledger.entries();
      return paginatePayments(payments, query);
    },

    async getBudget() {
      return buildBudget(input, nowMs());
    },

    async snapshot() {
      const [session, streamPage, budget, paymentPage] = await Promise.all([
        service.getSession(),
        service.listStreams({ limit: SNAPSHOT_PAYMENT_CAP }),
        service.getBudget(),
        service.listPayments({ limit: SNAPSHOT_PAYMENT_CAP }),
      ]);
      return {
        session,
        streams: streamPage.items,
        budget,
        payments: paymentPage.items,
      };
    },

    async revoke(context) {
      const persisted = activeSession(input.sessions);
      if (!persisted) {
        await audit(input.ledger, context, {
          action: "session.revoke.requested",
          outcome: "failed",
          subject: null,
          detail: "no active session",
        });
        throw new ConsoleNotFoundError("no active session to revoke");
      }

      const result = input.performRevoke
        ? await input.performRevoke(persisted)
        : {
            local: { revoked: input.sessions.remove(persisted.walletAddress) },
            onChain: { revoked: false, status: null, transactionHash: null },
          };

      input.seller?.endAll("session-revoked");
      pendingRevoke = result.onChain.revoked ? undefined : persisted;

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

      await audit(input.ledger, context, {
        action: "session.revoke.requested",
        // The local stage is what stops signing, and it is synchronous.
        // A pending on-chain stage is still a successful request; its
        // own outcome arrives as a later retry record.
        outcome: result.local.revoked ? "succeeded" : "failed",
        subject: persisted.walletAddress,
        detail: `onChain=${result.onChain.revoked} status=${result.onChain.status ?? "null"}`,
      });

      service.notify();
      return result;
    },

    async retryRevoke(context) {
      const snapshot = pendingRevoke;
      if (!snapshot) {
        throw new ConsoleNotFoundError("no pending on-chain revoke to retry");
      }
      if (!input.performRetryRevoke) {
        throw new Error(
          "on-chain revoke retry is not wired in this environment",
        );
      }

      const result = await input.performRetryRevoke(snapshot);
      pendingRevoke = result.onChain.revoked ? undefined : snapshot;

      await recordSessionRevoked({
        store: input.ledger,
        sessionPublicKey: snapshot.publicKey,
        chainId: input.config.chain.chainId,
        token: input.config.chain.token,
        tokenDecimals: input.config.chain.tokenDecimals,
        stage: result.onChain.revoked ? "both" : "local",
        transactionHash: result.onChain.transactionHash,
        detail: `retry local=${result.local.revoked} onChain=${result.onChain.revoked} status=${result.onChain.status ?? "null"}`,
      });

      await audit(input.ledger, context, {
        action: "session.revoke.retry.requested",
        outcome: result.onChain.revoked ? "succeeded" : "failed",
        subject: snapshot.walletAddress,
        detail: `status=${result.onChain.status ?? "null"}`,
      });

      service.notify();
      return result;
    },

    async retrySettlement(nonce, context) {
      const retry = input.seller?.retrySettlement;
      if (!retry) {
        throw new ConsoleNotFoundError(
          "settlement retry is not available in this deployment",
        );
      }
      try {
        const result = await retry(nonce);
        await audit(input.ledger, context, {
          action: "settlement.retry.requested",
          outcome: "succeeded",
          subject: nonce,
          detail: `transactionHash=${result.transactionHash}`,
        });
        service.notify();
        return result;
      } catch (err: unknown) {
        await audit(input.ledger, context, {
          action: "settlement.retry.requested",
          outcome: "failed",
          subject: nonce,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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

    registerSseAbort(abort) {
      sseAborts.add(abort);
      return () => {
        sseAborts.delete(abort);
      };
    },

    close() {
      for (const abort of sseAborts) abort();
      sseAborts.clear();
      listeners.clear();
    },
  };

  return service;
}

/**
 * Write one administrative record, never letting the write break the
 * action it describes.
 *
 * An audit trail that can fail an operation is worse than one with a
 * gap: it turns a bookkeeping problem into an outage, and it would make
 * the kill switch — the one action that must always work — depend on a
 * disk write succeeding.
 */
async function audit(
  ledger: LedgerStore,
  context: OperatorContext | undefined,
  record: {
    action: AuditAction;
    outcome: AuditOutcome;
    subject: string | null;
    detail: string;
  },
): Promise<void> {
  try {
    await ledger.appendAudit({
      action: record.action,
      actor: context?.actor ?? "operator",
      outcome: record.outcome,
      subject: record.subject,
      requestId: context?.requestId ?? null,
      detail: record.detail,
    });
  } catch {
    // Deliberately swallowed — see the docstring.
  }
}

export class ConsoleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleNotFoundError";
  }
}

/**
 * The product is one session. The store is keyed by wallet and can hold
 * more than one record, but the console always binds to the
 * lexicographically first address so the choice is deterministic rather
 * than Map insertion order. A selector UI is out of scope until the
 * product supports concurrent sessions.
 */
function activeSession(store: SessionStore): PersistedSession | undefined {
  const wallets = [...store.list()].sort();
  const wallet = wallets[0];
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
      tokenSymbol: config.chain.tokenSymbol,
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
      status: streamStatusFromEndReason(stream.endReason),
      endReason: stream.endReason,
      tokenSymbol: input.config.chain.tokenSymbol,
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
    tokenSymbol: input.config.chain.tokenSymbol,
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
