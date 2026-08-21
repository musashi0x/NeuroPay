import { useMemo } from "react";
import type { LedgerEntry } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import { toneFor } from "@/components/console/shared";
import { Pill } from "@/components/ui";
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "@/components/ui";

/**
 * Truncates an identifier for inline display, retaining head + tail so
 * the visible part is still recognizable. The full value rides in a
 * tooltip on hover.
 */
function truncated(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

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
    <TooltipProvider delayDuration={150}>
      <section
        className="mt-6 border p-5"
        style={{ borderColor: "var(--line)" }}
      >
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
                  <Pill tone={toneFor(entry.event)}>{entry.event}</Pill>
                  <p className="text-xs text-[var(--muted)]">
                    {entry.timestamp}
                  </p>
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
                  {entry.nonce ? (
                    <TooltipRoot>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={0}
                          className="cursor-help underline decoration-dotted underline-offset-2"
                        >
                          nonce {truncated(entry.nonce)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{entry.nonce}</TooltipContent>
                    </TooltipRoot>
                  ) : (
                    "no nonce"
                  )}
                  {entry.transactionHash ? (
                    <>
                      {" · "}
                      <TooltipRoot>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="cursor-help underline decoration-dotted underline-offset-2"
                          >
                            {truncated(entry.transactionHash)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{entry.transactionHash}</TooltipContent>
                      </TooltipRoot>
                    </>
                  ) : null}
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
    </TooltipProvider>
  );
}
