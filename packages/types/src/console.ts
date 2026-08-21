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

/** One page of a cursor-paginated console list. */
export type CursorPage<T> = {
  items: T[];
  /** Opaque cursor for the next page; null when this page is the last. */
  nextCursor: string | null;
};

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
/** Newest payments included in an SSE snapshot. REST lists paginate past this. */
export const SNAPSHOT_PAYMENT_CAP = 100;

export type { RevokeResult };
