"use client";

import { useEffect, useRef } from "react";
import type { ConsoleSnapshot, LedgerEntry } from "@neuro-pay/types";
import { truncated } from "@/components/console/shared";
import { explorerUrl } from "@/lib/explorer";
import { useToast, type ToastTone } from "@/components/ui";

/**
 * Events worth surfacing as a corner toast. Everything else is routine
 * ledger traffic that already appears inline in the history list.
 */
const TOAST_EVENTS = new Set<LedgerEntry["event"]>([
  "settlement.submitted",
  "settlement.confirmed",
  "settlement.failed",
  "payment.settlement.submitted",
  "payment.settlement.confirmed",
  "payment.settlement.failed",
  "payment.settlement.lost",
]);

function toneForEvent(event: LedgerEntry["event"]): ToastTone {
  if (event.endsWith(".confirmed") || event === "settlement.recovered") {
    return "ok";
  }
  if (event.endsWith(".failed") || event === "payment.settlement.lost") {
    return "bad";
  }
  return "neutral";
}

function titleForEvent(entry: LedgerEntry): string {
  // The event names are already informative; we just space them and title
  // case each segment so the toast reads naturally.
  const parts = entry.event.split(".");
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" · ");
}

function descriptionForEntry(entry: LedgerEntry): string | undefined {
  if (entry.transactionHash) return `tx ${truncated(entry.transactionHash)}`;
  return entry.classification ?? undefined;
}

function hrefForEntry(entry: LedgerEntry): string | undefined {
  if (!entry.transactionHash) return undefined;
  return explorerUrl(entry.chainId, "tx", entry.transactionHash) ?? undefined;
}

/**
 * Compares the current snapshot's payments against the previous one and
 * fires a toast for each newly-arrived settlement-lifecycle entry. The
 * first render is silent — we only toast deltas after a baseline exists.
 */
export function useSettlementToasts(snapshot: ConsoleSnapshot) {
  const { push } = useToast();
  const seenIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    const next = new Set<string>();
    for (const entry of snapshot.payments) next.add(entry.id);

    if (primed.current) {
      for (const entry of snapshot.payments) {
        if (seenIds.current.has(entry.id)) continue;
        if (!TOAST_EVENTS.has(entry.event)) continue;
        const description = descriptionForEntry(entry);
        const href = hrefForEntry(entry);
        push({
          title: titleForEvent(entry),
          ...(description !== undefined ? { description } : {}),
          ...(href !== undefined ? { href } : {}),
          tone: toneForEvent(entry.event),
        });
      }
    } else {
      primed.current = true;
    }

    seenIds.current = next;
  }, [snapshot, push]);
}
