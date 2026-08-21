import type { LedgerEntry } from "@neuro-pay/types";
import type { StatusTone } from "./index";

/**
 * Map a ledger event to a Pill tone. The colour rules live here so the
 * mapping is testable without the JSX.
 */
export function toneFor(event: LedgerEntry["event"]): StatusTone {
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
