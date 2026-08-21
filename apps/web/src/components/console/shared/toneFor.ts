import type { LedgerEntry } from "@neuro-pay/types";
import type { StatusTone } from "./StatusPill";

/**
 * Map a ledger event to a `StatusPill` tone. Keep this next to the pill so
 * the colour rules stay co-located with the visual contract they drive.
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
