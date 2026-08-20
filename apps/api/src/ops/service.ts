/**
 * The operations read model: readiness, alerts, and metrics.
 *
 * Sits beside the console service rather than inside it because the two
 * answer different questions for different readers. The console answers
 * "what is this session doing" for a human watching a dashboard; ops
 * answers "is this deployment healthy" for a supervisor, a scraper, and
 * whoever is holding the pager. They share inputs and nothing else.
 *
 * Every dependency arrives as a function so the whole surface is
 * testable without a chain, a wallet, or a clock.
 */

import type { BudgetState, SessionPolicyView } from "@neuro-pay/types";
import { computeLedgerMetrics, type LedgerMetrics } from "@neuro-pay/ledger";
import type { LedgerStore } from "@neuro-pay/ledger";

import {
  deriveAlerts,
  overallStatus,
  runProbes,
  type Alert,
  type AlertThresholds,
  type Probe,
  type ReadinessReport,
} from "./health.js";

/**
 * The full operational picture, rendered as JSON for the console and as
 * Prometheus text for a scraper.
 */
export type MetricsSnapshot = {
  collectedAt: string;
  ledger: LedgerMetrics;
  schema: { version: number; latest: number };
  exposure: { inFlight: number; ceiling: number; saturation: number };
  budget: BudgetState | null;
  session: SessionPolicyView | null;
  settler: {
    /** Null when no chain-backed settler is wired. */
    address: string | null;
    balanceWei: bigint | null;
  };
  alerts: Alert[];
};

export type OpsService = {
  readiness(): Promise<ReadinessReport>;
  metrics(): Promise<MetricsSnapshot>;
};

export type CreateOpsServiceInput = {
  ledger: LedgerStore;
  probes: Probe[];
  exposureStats: () => { inFlight: number; ceiling: number };
  getBudget: () => Promise<BudgetState | null>;
  getSession: () => Promise<SessionPolicyView | null>;
  /**
   * Reads the settler's native balance. Absent when no settler key is
   * configured, which is a legitimate local-dev state and reported as
   * such rather than as a fault.
   */
  settler?: {
    address: string;
    readBalanceWei: () => Promise<bigint>;
  };
  thresholds?: Partial<AlertThresholds>;
  now?: () => Date;
};

export function createOpsService(input: CreateOpsServiceInput): OpsService {
  const now = input.now ?? (() => new Date());

  /**
   * Gather everything the alert rules need.
   *
   * Shared by both endpoints so a readiness report and a metrics scrape
   * taken a moment apart cannot disagree about whether something is
   * firing — they compute alerts from the same rules over the same
   * inputs.
   */
  const gather = async (): Promise<{
    metrics: LedgerMetrics;
    exposure: { inFlight: number; ceiling: number };
    budget: BudgetState | null;
    session: SessionPolicyView | null;
    settlerBalanceWei: bigint | null;
  }> => {
    const [metrics, budget, session, settlerBalanceWei] = await Promise.all([
      computeLedgerMetrics(input.ledger),
      input.getBudget().catch(() => null),
      input.getSession().catch(() => null),
      input.settler
        ? // A balance read that fails must not take the whole report
          // with it: the other alerts are still true and still worth
          // seeing. The `settler-balance` probe reports the failure.
          input.settler.readBalanceWei().catch(() => null)
        : Promise.resolve(null),
    ]);
    const stats = input.exposureStats();
    return {
      metrics,
      exposure: { inFlight: stats.inFlight, ceiling: stats.ceiling },
      budget,
      session,
      settlerBalanceWei,
    };
  };

  return {
    async readiness() {
      const [checks, facts] = await Promise.all([
        runProbes(input.probes),
        gather(),
      ]);
      return {
        status: overallStatus(checks),
        checkedAt: now().toISOString(),
        checks,
        alerts: deriveAlerts({ ...facts, thresholds: input.thresholds ?? {} }),
      };
    },

    async metrics() {
      const facts = await gather();
      const schema = input.ledger.schemaInfo();
      return {
        collectedAt: now().toISOString(),
        ledger: facts.metrics,
        schema: { version: schema.version, latest: schema.latest },
        exposure: {
          inFlight: facts.exposure.inFlight,
          ceiling: facts.exposure.ceiling,
          saturation:
            facts.exposure.ceiling === 0
              ? 0
              : facts.exposure.inFlight / facts.exposure.ceiling,
        },
        budget: facts.budget,
        session: facts.session,
        settler: {
          address: input.settler?.address ?? null,
          balanceWei: facts.settlerBalanceWei,
        },
        alerts: deriveAlerts({ ...facts, thresholds: input.thresholds ?? {} }),
      };
    },
  };
}
