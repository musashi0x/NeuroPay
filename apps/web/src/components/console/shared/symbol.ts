import type { ConsoleSnapshot } from "@neuro-pay/types";

/**
 * Pick the token symbol a panel should display. Prefers the value the
 * session was provisioned with, then the live budget, then the first
 * stream, then a neutral default. Centralised so every panel reports the
 * same symbol for the same snapshot.
 */
export function configuredSymbol(snapshot: ConsoleSnapshot): string {
  return (
    snapshot.session?.spendCap.tokenSymbol ??
    snapshot.budget?.tokenSymbol ??
    snapshot.streams[0]?.tokenSymbol ??
    "token"
  );
}
