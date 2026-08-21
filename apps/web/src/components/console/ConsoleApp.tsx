"use client";

import { useState } from "react";
import type { RevokeResult } from "@neuro-pay/types";
import { fetchSnapshot, revokeSession } from "@/lib/api";
import { BudgetPanel } from "@/components/console/BudgetPanel";
import { ConsoleHeader } from "@/components/console/ConsoleHeader";
import { HistoryPanel } from "@/components/console/HistoryPanel";
import { MuteToastsRow } from "@/components/console/MuteToastsRow";
import { RevokeSwitch } from "@/components/console/RevokeSwitch";
import { SessionPanel } from "@/components/console/SessionPanel";
import { StreamPanel } from "@/components/console/StreamPanel";
import { configuredSymbol } from "@/components/console/shared";
import { useConsoleSnapshot } from "@/components/console/useConsoleSnapshot";
import { useSettlementToasts } from "@/components/console/useSettlementToasts";
import { ToastProvider } from "@/components/ui";

/**
 * Composition root for the stream console. Data loading lives in
 * `useConsoleSnapshot`; settlement-lifecycle toasts ride the SSE stream
 * via `useSettlementToasts`; each panel owns its own presentation.
 */
export function ConsoleApp() {
  const {
    snapshot,
    paymentCursor,
    loadingMore,
    error,
    setError,
    setSnapshot,
    setPaymentCursor,
    loadMore,
  } = useConsoleSnapshot();

  useSettlementToasts(snapshot);

  const [confirming, setConfirming] = useState(false);
  const [revokePhrase, setRevokePhrase] = useState("");
  const [revokeResult, setRevokeResult] = useState<RevokeResult | null>(null);
  const [revoking, setRevoking] = useState(false);

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

  const symbol = configuredSymbol(snapshot);

  return (
    <ToastProvider>
      <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
        <ConsoleHeader error={error} />

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <SessionPanel session={snapshot.session} symbol={symbol} />
          <BudgetPanel budget={snapshot.budget} symbol={symbol} />
        </div>

        <StreamPanel streams={snapshot.streams} symbol={symbol} />
        <HistoryPanel
          payments={snapshot.payments}
          symbol={symbol}
          nextCursor={paymentCursor}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
        <MuteToastsRow />
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
    </ToastProvider>
  );
}
