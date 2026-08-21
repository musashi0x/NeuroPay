import type { BudgetState } from "./budget.js";
import type { IsoTimestamp } from "./primitives.js";
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

/**
 * State of the runtime auto-revoke-on-failure safety net.
 *
 * Served as `GET /v1/session/auto-revoke`. The flag is in-memory; a
 * process restart returns the runtime to `enabled: false`. `lastFiredAt`
 * is the wall-clock time of the most recent threshold crossing, or
 * `null` if the watcher has never fired.
 */
export type AutoRevokeOnFailureView = {
  enabled: boolean;
  lastFiredAt: IsoTimestamp | null;
};

/**
 * Request body for `PUT /v1/session/auto-revoke`. The PUT semantics are
 * "arm" when `enabled: true` and "disarm" when `enabled: false`; the
 * response is the new `AutoRevokeOnFailureView`.
 */
export type SetAutoRevokeRequest = {
  enabled: boolean;
};

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
/** Newest payments included in an SSE snapshot. REST lists paginate past this. */
export const SNAPSHOT_PAYMENT_CAP = 100;

export type { RevokeResult };
