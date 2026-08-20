/**
 * Prometheus text-format rendering of a `MetricsSnapshot`.
 *
 * The exposition format is stable and boring, so this is a plain string
 * builder rather than a client library: pulling in `prom-client` would
 * mean maintaining a parallel set of registered counters that must be
 * kept in sync with the ledger-derived numbers, which is precisely the
 * duplication the derived-metrics design exists to avoid.
 *
 * Conventions followed:
 *
 * - one `# HELP` and one `# TYPE` per metric family, emitted once;
 * - `_total` suffix on counters, none on gauges;
 * - durations in seconds, not milliseconds, because that is what the
 *   ecosystem's dashboards and alert expressions assume;
 * - a value that is unknown is **omitted**, never emitted as 0. A
 *   settler balance of "we could not read it" and a settler balance of
 *   "empty" must not render identically.
 */

import type { MetricsSnapshot } from "./service.js";

/** Content type Prometheus expects; the route sets it from here. */
export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const out: string[] = [];

  const counter = (
    name: string,
    help: string,
    samples: { labels?: Record<string, string>; value: number }[],
  ): void => emit(out, name, help, "counter", samples);
  const gauge = (
    name: string,
    help: string,
    samples: { labels?: Record<string, string>; value: number }[],
  ): void => emit(out, name, help, "gauge", samples);

  const { ledger } = snapshot;

  counter("neuropay_ledger_entries_total", "Entries in the payment ledger.", [
    { value: ledger.entries },
  ]);

  counter(
    "neuropay_payments_total",
    "Payment lifecycle outcomes recorded in the ledger.",
    [
      { labels: { outcome: "demanded" }, value: ledger.verification.demanded },
      { labels: { outcome: "verified" }, value: ledger.verification.verified },
      { labels: { outcome: "rejected" }, value: ledger.verification.rejected },
      { labels: { outcome: "refused" }, value: ledger.verification.refused },
    ],
  );

  counter(
    "neuropay_payment_failures_total",
    "Refusals and rejections by failure classification.",
    Object.entries(ledger.verification.byClassification).map(
      ([classification, value]) => ({ labels: { classification }, value }),
    ),
  );

  counter(
    "neuropay_settlements_total",
    "Settlements by terminal state, de-duplicated by authorization nonce.",
    [
      { labels: { state: "submitted" }, value: ledger.settlement.submitted },
      { labels: { state: "confirmed" }, value: ledger.settlement.confirmed },
      { labels: { state: "failed" }, value: ledger.settlement.failed },
      { labels: { state: "lost" }, value: ledger.settlement.lost },
      { labels: { state: "retried" }, value: ledger.settlement.retried },
      { labels: { state: "recovered" }, value: ledger.settlement.recovered },
    ],
  );

  gauge(
    "neuropay_settlements_in_flight",
    "Settlements submitted with neither confirmation nor failure.",
    [{ value: ledger.settlement.inFlight }],
  );

  gauge(
    "neuropay_settlements_failed_unrecovered",
    "Failed or lost settlements with no recovery — delivered value that is unpaid.",
    [{ value: ledger.settlement.failedUnrecovered }],
  );

  const latency = ledger.settlement.latency;
  const latencySamples: { labels?: Record<string, string>; value: number }[] =
    [];
  if (latency.p50Ms !== null)
    latencySamples.push({
      labels: { quantile: "0.5" },
      value: latency.p50Ms / 1000,
    });
  if (latency.p95Ms !== null)
    latencySamples.push({
      labels: { quantile: "0.95" },
      value: latency.p95Ms / 1000,
    });
  if (latency.maxMs !== null)
    latencySamples.push({
      labels: { quantile: "1" },
      value: latency.maxMs / 1000,
    });
  if (latencySamples.length > 0) {
    gauge(
      "neuropay_settlement_latency_seconds",
      "Submitted-to-confirmed settlement latency, lifetime-to-date.",
      latencySamples,
    );
  }
  gauge(
    "neuropay_settlement_latency_observations",
    "Settlements that have both a submission and a confirmation.",
    [{ value: latency.count }],
  );

  counter("neuropay_segments_delivered_total", "Segments delivered.", [
    { value: ledger.delivery.segments },
  ]);

  counter("neuropay_streams_total", "Streams by lifecycle outcome.", [
    { labels: { state: "opened" }, value: ledger.streams.opened },
    { labels: { state: "ended" }, value: ledger.streams.ended },
    { labels: { state: "abandoned" }, value: ledger.streams.abandoned },
  ]);

  counter("neuropay_sessions_total", "Session grants and revocations.", [
    { labels: { event: "granted" }, value: ledger.session.granted },
    { labels: { event: "revoked" }, value: ledger.session.revoked },
  ]);

  gauge(
    "neuropay_exposure_slots",
    "Seller credit exposure slots, held and configured.",
    [
      { labels: { state: "in_flight" }, value: snapshot.exposure.inFlight },
      { labels: { state: "ceiling" }, value: snapshot.exposure.ceiling },
    ],
  );
  gauge(
    "neuropay_exposure_saturation_ratio",
    "Held exposure slots as a fraction of the ceiling. 1 means delivery has stopped.",
    [{ value: snapshot.exposure.saturation }],
  );

  if (snapshot.budget) {
    const budget = snapshot.budget;
    gauge(
      "neuropay_budget_smallest_units",
      "Session budget for the current window, in the token's smallest units.",
      [
        { labels: { kind: "spent" }, value: Number(budget.spent) },
        { labels: { kind: "local_limit" }, value: Number(budget.localLimit) },
        {
          labels: { kind: "local_remaining" },
          value: Number(budget.localRemaining),
        },
        { labels: { kind: "on_chain_cap" }, value: Number(budget.onChainCap) },
        {
          labels: { kind: "on_chain_remaining" },
          value: Number(budget.onChainRemaining),
        },
      ],
    );
    gauge(
      "neuropay_budget_exhausted",
      "1 when the session's local budget for this window is spent.",
      [{ value: budget.exhausted ? 1 : 0 }],
    );
  }

  if (snapshot.session) {
    const session = snapshot.session;
    gauge(
      "neuropay_session_remaining_lifetime_seconds",
      "Seconds until the session's on-chain expiry.",
      [{ value: session.remainingLifetimeSeconds }],
    );
    // One series per status with a 0/1 value, rather than a single
    // series carrying a status-coded number. A dashboard can then graph
    // `neuropay_session_status{status="revoked"}` without a lookup table
    // mapping integers back to meanings.
    gauge(
      "neuropay_session_status",
      "1 for the session's current status, 0 for the others.",
      (
        ["active", "expired", "revoked", "unprovisioned", "unknown"] as const
      ).map((status) => ({
        labels: { status },
        value: session.status === status ? 1 : 0,
      })),
    );
  }

  if (snapshot.settler.balanceWei !== null) {
    gauge(
      "neuropay_settler_balance_wei",
      "Native-token balance of the settler EOA that pays settlement gas.",
      [{ value: Number(snapshot.settler.balanceWei) }],
    );
  }

  gauge(
    "neuropay_ledger_schema_version",
    "Schema version of the open ledger file, and the version this build supports.",
    [
      { labels: { kind: "file" }, value: snapshot.schema.version },
      { labels: { kind: "supported" }, value: snapshot.schema.latest },
    ],
  );

  gauge(
    "neuropay_alerts_firing",
    "Operator alerts currently derived from ledger and process state.",
    [
      {
        labels: { severity: "warning" },
        value: snapshot.alerts.filter((a) => a.severity === "warning").length,
      },
      {
        labels: { severity: "critical" },
        value: snapshot.alerts.filter((a) => a.severity === "critical").length,
      },
    ],
  );
  if (snapshot.alerts.length > 0) {
    gauge(
      "neuropay_alert",
      "1 per firing alert, labelled by id and severity.",
      snapshot.alerts.map((alert) => ({
        labels: { id: alert.id, severity: alert.severity },
        value: 1,
      })),
    );
  }

  return `${out.join("\n")}\n`;
}

function emit(
  out: string[],
  name: string,
  help: string,
  type: "counter" | "gauge",
  samples: { labels?: Record<string, string>; value: number }[],
): void {
  if (samples.length === 0) return;
  out.push(`# HELP ${name} ${escapeHelp(help)}`);
  out.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) {
    out.push(
      `${name}${renderLabels(sample.labels)} ${renderValue(sample.value)}`,
    );
  }
}

function renderLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  const pairs = Object.entries(labels).map(
    ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Render a sample value.
 *
 * A non-finite number would produce a line Prometheus rejects, and one
 * bad line invalidates the whole scrape — so anything that is not finite
 * is rendered as the format's own `NaN`, which parsers accept.
 */
function renderValue(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  return Number.isInteger(value) ? value.toString(10) : value.toString();
}

/** Help text is newline-delimited, so escape what would end the line. */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}
