import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleSnapshot, LedgerEntry } from "@neuro-pay/types";
import { SNAPSHOT_PAYMENT_CAP } from "@neuro-pay/types";
import { fetchPayments, fetchSnapshot, openConsoleEvents } from "@/lib/api";

const emptySnapshot: ConsoleSnapshot = {
  session: null,
  streams: [],
  budget: null,
  payments: [],
};

function cursorAfterSnapshot(payments: LedgerEntry[]): string | null {
  if (payments.length < SNAPSHOT_PAYMENT_CAP) return null;
  const oldest = payments.reduce(
    (min, entry) => (entry.sequence < min ? entry.sequence : min),
    payments[0]!.sequence,
  );
  return String(oldest);
}

/**
 * Owns the console data lifecycle:
 *   - REST snapshot on mount
 *   - SSE updates overwrite the snapshot (cursor recomputed each tick)
 *   - `loadMore` paginates payments when a cursor is available
 *
 * Returns plain state + a stable `loadMore` so the consumer stays a thin
 * composition root.
 */
export function useConsoleSnapshot() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(emptySnapshot);
  const [paymentCursor, setPaymentCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

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

  const loadMore = useCallback(() => {
    if (loadingRef.current) return;
    setPaymentCursor((cursor) => {
      if (!cursor) return cursor;
      loadingRef.current = true;
      setLoadingMore(true);
      void fetchPayments({ cursor })
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
        .finally(() => {
          loadingRef.current = false;
          setLoadingMore(false);
        });
      return cursor;
    });
  }, []);

  return {
    snapshot,
    paymentCursor,
    loadingMore,
    error,
    setError,
    setSnapshot,
    setPaymentCursor,
    loadMore,
  };
}
