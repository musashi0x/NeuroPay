import { useMemo } from "react";
import type { LedgerEntry } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import { StatusPill, toneFor } from "@/components/console/shared";

export function HistoryPanel({
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
