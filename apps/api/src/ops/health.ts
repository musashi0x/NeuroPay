/**
 * Readiness probes and operator alerts.
 *
 * ## Liveness is not readiness
 *
 * `GET /health` answers "is this process running". It has always
 * answered `ok` unconditionally, and that is correct: it is what a
 * supervisor restarts on. It is also nearly useless for the question an
 * operator actually has, which is "can this process settle a payment
 * right now" — a process with an unreachable RPC, a Permit2 address with
 * no code behind it, or a settler with no gas is alive and completely
 * unable to do its job.
 *
 * So readiness is a separate surface with a probe per dependency. Each
 * probe is a function the runtime injects, which is what lets the whole
 * thing be tested without a chain, and each returns one of three
 * verdicts:
 *
 * - `ok` — the dependency answered and matches configuration;
 * - `degraded` — it answered, but something is wrong that does not stop
 *   work immediately (a settler balance below its floor, a session about
 *   to expire);
 * - `down` — it did not answer, or answered with something that makes
 *   settlement impossible (a chain id that is not the configured one).
 *
 * `skipped` is the fourth verdict and means the dependency is not wired
 * in this environment at all — a local dev process with no `RPC_URL`.
 * It is deliberately *not* an error: reporting "down" for something the
 * operator chose not to configure trains people to ignore the report.
 *
 * ## Alerts are derived, not raised
 *
 * Nothing here pushes anywhere. An alert is a *conclusion recomputed on
 * read* from the ledger-derived metrics plus live process state, so it
 * cannot go stale, cannot be missed by a process that was restarting,
 * and needs no delivery machinery to be correct. Wiring these to a pager
 * is a matter of scraping the endpoint.
 */

import type { BudgetState, SessionPolicyView } from "@neuro-pay/types";
import type { LedgerMetrics } from "@neuro-pay/ledger";

export type ProbeStatus = "ok" | "degraded" | "down" | "skipped";

export type ProbeName =
  | "rpc"
  | "token-decimals"
  | "permit2"
  | "settler-balance"
  | "ledger"
  | "session-authority";

/** What a probe reports before the runner stamps timing onto it. */
export type ProbeVerdict = {
  status: ProbeStatus;
  /** One line an operator can act on. Never carries key material. */
  message: string;
};

export type ProbeResult = ProbeVerdict & {
  name: ProbeName;
  durationMs: number;
};

export type Probe = {
  name: ProbeName;
  run: () => Promise<ProbeVerdict>;
};

export type OverallStatus = "ok" | "degraded" | "down";

export type AlertSeverity = "warning" | "critical";

export type Alert = {
  /** Stable identifier; safe to use as an alert-manager key. */
  id: string;
  severity: AlertSeverity;
  summary: string;
};

export type ReadinessReport = {
  status: OverallStatus;
  checkedAt: string;
  checks: ProbeResult[];
  alerts: Alert[];
};

/**
 * How long a probe may take before it is called down.
 *
 * A hung RPC connection is the common failure and it does not fail fast
 * on its own — without a deadline the readiness endpoint hangs with it,
 * which turns a degraded dependency into a broken health check.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Run every probe in parallel, bounding each one.
 *
 * Parallel because the probes are independent and a serial run pays the
 * worst case of each in turn; bounded because see above.
 */
export async function runProbes(
  probes: Probe[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  return Promise.all(
    probes.map(async (probe) => {
      const startedAt = Date.now();
      try {
        const verdict = await withTimeout(probe.run(), timeoutMs, probe.name);
        return {
          name: probe.name,
          ...verdict,
          durationMs: Date.now() - startedAt,
        };
      } catch (err: unknown) {
        return {
          name: probe.name,
          status: "down" as const,
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        };
      }
    }),
  );
}

/**
 * Fold probe verdicts into one status.
 *
 * The worst verdict wins, and `skipped` contributes nothing — an
 * unconfigured dependency is not a fault.
 */
export function overallStatus(checks: ProbeResult[]): OverallStatus {
  if (checks.some((c) => c.status === "down")) return "down";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  return "ok";
}

/**
 * Thresholds the alert rules fire on.
 *
 * `failedSettlementWarn` defaults to 1 rather than some larger round
 * number on purpose: a failed settlement is a segment the seller has
 * already delivered and will not be paid for. One is already worth a
 * human looking. The critical threshold is where it stops being an
 * incident with a single cause and starts looking systemic.
 */
export type AlertThresholds = {
  failedSettlementWarn: number;
  failedSettlementCritical: number;
  /** Native-token balance below which the settler is called low, in wei. */
  settlerBalanceFloorWei: bigint;
  /** Seconds of remaining session lifetime below which expiry is warned about. */
  sessionExpiryWarnSeconds: number;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  failedSettlementWarn: 1,
  failedSettlementCritical: 5,
  // 0.01 native token. On BNB testnet a `permitWitnessTransferFrom`
  // costs well under 0.001, so this is roughly ten settlements of
  // headroom — enough to notice and refill before anything stops.
  settlerBalanceFloorWei: 10_000_000_000_000_000n,
  sessionExpiryWarnSeconds: 3_600,
};

/** Everything the alert rules read. All of it is already computed elsewhere. */
export type AlertInputs = {
  metrics: LedgerMetrics;
  exposure: { inFlight: number; ceiling: number };
  budget: BudgetState | null;
  session: SessionPolicyView | null;
  /** Null when no settler is wired or its balance could not be read. */
  settlerBalanceWei: bigint | null;
  thresholds?: Partial<AlertThresholds>;
};

export function deriveAlerts(input: AlertInputs): Alert[] {
  const thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...input.thresholds };
  const alerts: Alert[] = [];

  const unrecovered = input.metrics.settlement.failedUnrecovered;
  if (unrecovered >= thresholds.failedSettlementCritical) {
    alerts.push({
      id: "failed-settlement-accumulation",
      severity: "critical",
      summary:
        `${unrecovered} settlements have failed and not been recovered. ` +
        "Delivered value is unpaid and each one still holds an exposure slot; " +
        "investigate before the seller stops delivering.",
    });
  } else if (unrecovered >= thresholds.failedSettlementWarn) {
    alerts.push({
      id: "failed-settlement-accumulation",
      severity: "warning",
      summary:
        `${unrecovered} settlement(s) failed and have not been recovered. ` +
        "Retry with `retrySettlement(nonce)` once the cause is understood.",
    });
  }

  if (input.settlerBalanceWei !== null) {
    const floor = thresholds.settlerBalanceFloorWei;
    if (input.settlerBalanceWei < floor / 10n) {
      alerts.push({
        id: "settler-drained",
        severity: "critical",
        summary:
          "The settler account is out of gas. Every settlement will fail to " +
          "submit until it is refilled, and delivered segments stay unpaid.",
      });
    } else if (input.settlerBalanceWei < floor) {
      alerts.push({
        id: "settler-balance-low",
        severity: "warning",
        summary:
          "The settler account is below its configured balance floor. Refill " +
          "it before it runs out mid-stream.",
      });
    }
  }

  if (input.exposure.ceiling > 0) {
    if (input.exposure.inFlight >= input.exposure.ceiling) {
      alerts.push({
        id: "exposure-saturated",
        severity: "critical",
        summary:
          `All ${input.exposure.ceiling} exposure slots are held. The seller is ` +
          "refusing segments until a settlement confirms.",
      });
    } else if (input.exposure.inFlight >= input.exposure.ceiling * 0.8) {
      alerts.push({
        id: "exposure-saturation-near",
        severity: "warning",
        summary:
          `${input.exposure.inFlight} of ${input.exposure.ceiling} exposure slots ` +
          "are held. Delivery stops when the last one goes.",
      });
    }
  }

  if (input.budget?.exhausted === true) {
    alerts.push({
      id: "budget-exhausted",
      severity: "warning",
      summary:
        "The session's local budget for this window is spent. Payments are " +
        "refused before signing until the window rolls or the cap is raised.",
    });
  }

  if (input.session) {
    if (input.session.status === "revoked") {
      alerts.push({
        id: "session-revoked",
        severity: "critical",
        summary: "The session is revoked on chain. Nothing can be signed.",
      });
    } else if (input.session.status === "expired") {
      alerts.push({
        id: "session-expired",
        severity: "critical",
        summary: "The session has expired. Grant a new one to resume payments.",
      });
    } else if (
      input.session.remainingLifetimeSeconds <=
      thresholds.sessionExpiryWarnSeconds
    ) {
      alerts.push({
        id: "session-expiring",
        severity: "warning",
        summary:
          `The session expires in ${input.session.remainingLifetimeSeconds}s. ` +
          "Streams opened now may outlive it and be refused.",
      });
    }
  }

  return alerts;
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} probe timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
