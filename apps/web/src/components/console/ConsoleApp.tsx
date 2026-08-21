"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  BudgetState,
  ConsoleSnapshot,
  LedgerEntry,
  RevokeResult,
  SessionPolicyView,
  StreamView,
} from "@neuro-pay/types";
import { SNAPSHOT_PAYMENT_CAP } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import {
  fetchPayments,
  fetchSnapshot,
  openConsoleEvents,
  revokeSession,
} from "@/lib/api";

const emptySnapshot: ConsoleSnapshot = {
  session: null,
  streams: [],
  budget: null,
  payments: [],
};

function configuredSymbol(snapshot: ConsoleSnapshot): string {
  return (
    snapshot.session?.spendCap.tokenSymbol ??
    snapshot.budget?.tokenSymbol ??
    snapshot.streams[0]?.tokenSymbol ??
    "token"
  );
}

function cursorAfterSnapshot(payments: LedgerEntry[]): string | null {
  if (payments.length < SNAPSHOT_PAYMENT_CAP) return null;
  const oldest = payments.reduce(
    (min, entry) => (entry.sequence < min ? entry.sequence : min),
    payments[0]!.sequence,
  );
  return String(oldest);
}

export function ConsoleApp() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(emptySnapshot);
  const [paymentCursor, setPaymentCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [revokePhrase, setRevokePhrase] = useState("");
  const [revokeResult, setRevokeResult] = useState<RevokeResult | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchSnapshot()
      .then(({ snapshot: next, nextPaymentCursor }) => {
        if (!cancelled) {
          setSnapshot(next);
          setPaymentCursor(nextPaymentCursor);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "API unavailable");
        }
      });

    const stop = openConsoleEvents((next) => {
      setSnapshot(next);
      setPaymentCursor(cursorAfterSnapshot(next.payments));
      setError(null);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  async function onRevoke() {
    if (revokePhrase !== "REVOKE") return;
    setRevoking(true);
    try {
      const result = await revokeSession();
      setRevokeResult(result);
      setConfirming(false);
      setRevokePhrase("");
      const loaded = await fetchSnapshot();
      setSnapshot(loaded.snapshot);
      setPaymentCursor(loaded.nextPaymentCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke failed");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
      <header
        className="flex flex-wrap items-end justify-between gap-4 border-b pb-6"
        style={{ borderColor: "var(--line)" }}
      >
        <div>
          <p className="text-xs tracking-[0.28em] text-[var(--muted)] uppercase">
            neuro-pay · stream console
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Settlement blotter
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
            Live spend against the session a human approved. Signing stays on
            the API. This page never sees a private key.
          </p>
        </div>
        {error ? (
          <p
            className="border px-3 py-2 text-sm"
            style={{
              borderColor: "var(--bad)",
              background: "var(--bad-wash)",
              color: "var(--bad)",
            }}
          >
            {error}
          </p>
        ) : null}
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <SessionPanel
          session={snapshot.session}
          symbol={configuredSymbol(snapshot)}
        />
        <BudgetPanel
          budget={snapshot.budget}
          symbol={configuredSymbol(snapshot)}
        />
      </div>

      <StreamPanel
        streams={snapshot.streams}
        symbol={configuredSymbol(snapshot)}
      />
      <HistoryPanel
        payments={snapshot.payments}
        symbol={configuredSymbol(snapshot)}
        nextCursor={paymentCursor}
        loadingMore={loadingMore}
        onLoadMore={() => {
          if (!paymentCursor || loadingMore) return;
          setLoadingMore(true);
          void fetchPayments({ cursor: paymentCursor })
            .then((page) => {
              setSnapshot((prev) => ({
                ...prev,
                payments: [...prev.payments, ...page.payments],
              }));
              setPaymentCursor(page.nextCursor);
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : "load more failed");
            })
            .finally(() => setLoadingMore(false));
        }}
      />
      <RevokeSwitch
        confirming={confirming}
        phrase={revokePhrase}
        revoking={revoking}
        result={revokeResult}
        onBegin={() => setConfirming(true)}
        onCancel={() => {
          setConfirming(false);
          setRevokePhrase("");
        }}
        onPhrase={setRevokePhrase}
        onConfirm={() => void onRevoke()}
        onRetry={() => {
          setConfirming(true);
          setRevokePhrase("");
        }}
      />
    </main>
  );
}

function SessionPanel({
  session,
  symbol,
}: {
  session: SessionPolicyView | null;
  symbol: string;
}) {
  const remaining = useRemaining(session?.expiresAt ?? null);
  if (!session) {
    return (
      <section className="border p-5" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Session policy
        </h2>
        <p className="mt-4 text-sm text-[var(--muted)]">
          No active session. Run the provisioning script, then refresh.
        </p>
      </section>
    );
  }

  return (
    <section className="border p-5" style={{ borderColor: "var(--line)" }}>
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Session policy
      </h2>
      <dl className="mt-4 space-y-3 text-sm">
        <Row label="Wallet" value={session.walletAddress} mono />
        <Row label="Public key" value={session.publicKey} mono />
        <Row label="Status" value={session.status} />
        <Row
          label="Allowed contracts"
          value={
            session.allowedCalls.length === 0
              ? "none"
              : session.allowedCalls
                  .map((call) =>
                    call.selector ? `${call.to} ${call.selector}` : call.to,
                  )
                  .join("\n")
          }
          mono
        />
        <div>
          <dt className="text-[var(--muted)]">Spend cap</dt>
          <dd className="mt-1">
            <Amount
              amount={session.spendCap.limit}
              decimals={session.spendCap.tokenDecimals}
              symbol={session.spendCap.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              / {formatPeriod(session.spendCap.periodSeconds)}
            </span>
          </dd>
        </div>
        <Row label="Expires" value={session.expiresAt} />
        <Row label="Remaining" value={formatDuration(remaining)} />
      </dl>
    </section>
  );
}

function BudgetPanel({
  budget,
  symbol,
}: {
  budget: BudgetState | null;
  symbol: string;
}) {
  if (!budget) {
    return (
      <section className="border p-5" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Budget
        </h2>
        <p className="mt-4 text-sm text-[var(--muted)]">
          Budget is derived from the active session.
        </p>
      </section>
    );
  }

  return (
    <section
      className="border p-5"
      style={{
        borderColor: budget.exhausted ? "var(--bad)" : "var(--line)",
        background: budget.exhausted ? "var(--bad-wash)" : undefined,
      }}
    >
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Budget
      </h2>
      {budget.exhausted ? (
        <p className="mt-3 text-sm" style={{ color: "var(--bad)" }}>
          Local budget exhausted. Further payments will be refused until the
          window rolls.
        </p>
      ) : null}
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-[var(--muted)]">Remaining local budget</dt>
          <dd className="mt-1">
            <Amount
              amount={budget.localRemaining}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              of{" "}
              <Amount
                amount={budget.localLimit}
                decimals={budget.tokenDecimals}
              />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Remaining on-chain cap</dt>
          <dd className="mt-1">
            <Amount
              amount={budget.onChainRemaining}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              of{" "}
              <Amount
                amount={budget.onChainCap}
                decimals={budget.tokenDecimals}
              />
            </span>
          </dd>
        </div>
        <Row
          label="Window spend"
          value={
            <Amount
              amount={budget.spent}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
          }
        />
      </dl>
    </section>
  );
}

function streamTone(status: StreamView["status"]): "ok" | "bad" | "warn" {
  if (status === "active") return "ok";
  if (status === "abandoned") return "warn";
  return "bad";
}

function streamLabel(stream: StreamView): string {
  if (stream.status === "active") return "active";
  if (stream.status === "abandoned") return "abandoned";
  return `ended · ${stream.endReason ?? "unknown"}`;
}

function StreamPanel({
  streams,
  symbol,
}: {
  streams: StreamView[];
  symbol: string;
}) {
  return (
    <section className="mt-6 border p-5" style={{ borderColor: "var(--line)" }}>
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Streams
      </h2>
      {streams.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">No streams yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {streams.map((stream) => (
            <li
              key={stream.streamId}
              className="border p-4"
              style={{ borderColor: "var(--line)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-sm">{stream.streamId}</p>
                <StatusPill
                  tone={streamTone(stream.status)}
                  label={streamLabel(stream)}
                />
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--muted)]">Pinned prices</dt>
                  <dd className="mt-1 space-y-1">
                    <div>
                      per call{" "}
                      <Amount
                        amount={stream.priceSheet.perCall}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                    <div>
                      per second{" "}
                      <Amount
                        amount={stream.priceSheet.perSecond}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                    <div>
                      per {stream.priceSheet.unitName}{" "}
                      <Amount
                        amount={stream.priceSheet.perUnit}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Accrued unpaid</dt>
                  <dd className="mt-1">
                    <Amount
                      amount={stream.accruedUnpaid}
                      decimals={stream.priceSheet.tokenDecimals}
                      symbol={stream.tokenSymbol || symbol}
                    />
                  </dd>
                </div>
                <Row
                  label="Consumed"
                  value={`${stream.deliveredSeconds}s · ${stream.deliveredUnits} ${stream.priceSheet.unitName}s · ${stream.deliveredCalls} calls`}
                />
                <Row
                  label="Next tick"
                  value={
                    stream.status === "active"
                      ? `${stream.secondsUntilNextTick}s`
                      : "—"
                  }
                />
                <Row
                  label="In-flight settlements"
                  value={String(stream.inFlightSettlements)}
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryPanel({
  payments,
  symbol,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  payments: LedgerEntry[];
  symbol: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const ordered = useMemo(
    () => [...payments].sort((a, b) => b.sequence - a.sequence),
    [payments],
  );

  return (
    <section className="mt-6 border p-5" style={{ borderColor: "var(--line)" }}>
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Payment history
      </h2>
      {ordered.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">No ledger entries.</p>
      ) : (
        <ol className="mt-4 divide-y" style={{ borderColor: "var(--line)" }}>
          {ordered.map((entry) => (
            <li key={entry.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <StatusPill tone={toneFor(entry.event)} label={entry.event} />
                <p className="text-xs text-[var(--muted)]">{entry.timestamp}</p>
              </div>
              <div className="mt-2 text-sm">
                {entry.amount !== null ? (
                  <Amount
                    amount={entry.amount}
                    decimals={entry.tokenDecimals}
                    symbol={symbol}
                  />
                ) : (
                  <span className="text-[var(--muted)]">no amount</span>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-[var(--muted)]">
                {entry.classification ? `${entry.classification} · ` : ""}
                {entry.nonce ? `nonce ${entry.nonce}` : "no nonce"}
                {entry.transactionHash ? ` · ${entry.transactionHash}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
      {nextCursor ? (
        <button
          type="button"
          className="mt-4 border px-4 py-2 text-sm"
          style={{ borderColor: "var(--line)" }}
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}

function RevokeSwitch({
  confirming,
  phrase,
  revoking,
  result,
  onBegin,
  onCancel,
  onPhrase,
  onConfirm,
  onRetry,
}: {
  confirming: boolean;
  phrase: string;
  revoking: boolean;
  result: RevokeResult | null;
  onBegin: () => void;
  onCancel: () => void;
  onPhrase: (value: string) => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  return (
    <section
      className="mt-6 border p-5"
      style={{ borderColor: "var(--bad)", background: "var(--bad-wash)" }}
    >
      <h2
        className="text-sm tracking-[0.2em] uppercase"
        style={{ color: "var(--bad)" }}
      >
        Kill switch
      </h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Local revoke stops signing immediately. On-chain revoke is the provable
        stage and can take a block. They are reported separately.
      </p>

      {result ? (
        <dl className="mt-4 space-y-2 text-sm">
          <Row
            label="Local"
            value={result.local.revoked ? "signing stopped" : "still loaded"}
          />
          <Row
            label="On-chain"
            value={
              result.onChain.revoked
                ? `revoked${result.onChain.transactionHash ? ` · ${result.onChain.transactionHash}` : ""}`
                : `not revoked${result.onChain.status ? ` · ${result.onChain.status}` : ""}`
            }
          />
        </dl>
      ) : null}

      {!confirming ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className="border px-4 py-2 text-sm font-medium"
            style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
            onClick={onBegin}
          >
            Revoke session
          </button>
          {result && !result.onChain.revoked ? (
            <button
              type="button"
              className="border px-4 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
              onClick={onRetry}
            >
              Retry on-chain revoke
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm">
            Type <span className="font-mono">REVOKE</span> to confirm. This
            cannot be undone from the console.
          </p>
          <input
            value={phrase}
            onChange={(event) => onPhrase(event.target.value)}
            className="w-full max-w-xs border bg-transparent px-3 py-2 font-mono text-sm"
            style={{ borderColor: "var(--line)" }}
            autoComplete="off"
          />
          <div className="flex gap-3">
            <button
              type="button"
              disabled={phrase !== "REVOKE" || revoking}
              className="border px-4 py-2 text-sm font-medium disabled:opacity-40"
              style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
              onClick={onConfirm}
            >
              {revoking ? "Revoking…" : "Confirm revoke"}
            </button>
            <button
              type="button"
              className="border px-4 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd
        className={`mt-1 whitespace-pre-wrap break-all ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "ok" | "bad" | "warn" | "neutral";
  label: string;
}) {
  const styles = {
    ok: { color: "var(--ok)", background: "var(--ok-wash)" },
    bad: { color: "var(--bad)", background: "var(--bad-wash)" },
    warn: { color: "#7a4b00", background: "#f3e6c8" },
    neutral: { color: "var(--ink)", background: "transparent" },
  } as const;
  return (
    <span
      className="inline-block border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase"
      style={{ ...styles[tone], borderColor: "currentColor" }}
    >
      {label}
    </span>
  );
}

function toneFor(
  event: LedgerEntry["event"],
): "ok" | "bad" | "warn" | "neutral" {
  if (event === "settlement.confirmed" || event === "payment.signed")
    return "ok";
  if (
    event === "settlement.failed" ||
    event === "payment.refused" ||
    event === "payment.rejected"
  ) {
    return "bad";
  }
  if (event === "payment.demanded" || event === "session.revoked")
    return "warn";
  return "neutral";
}

function useRemaining(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatPeriod(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}
