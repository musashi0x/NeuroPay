import type { BudgetState } from "./budget.js";
import type { LedgerEntry } from "./ledger.js";
import type { RevokeResult, SessionPolicyView } from "./session.js";
import type { StreamView } from "./stream.js";

/**
 * One snapshot of everything the stream console renders.
 *
 * Served as `GET /v1/console` and as each SSE `snapshot` event. Amounts
 * are `bigint` here; the HTTP codec stringifies them.
 */
export type ConsoleSnapshot = {
  session: SessionPolicyView | null;
  streams: StreamView[];
  budget: BudgetState | null;
  payments: LedgerEntry[];
};

export type { RevokeResult };
