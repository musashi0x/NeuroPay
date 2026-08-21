/**
 * Cursor pagination for console lists.
 *
 * The ledger still loads a snapshot and filters in process — same
 * pattern as `entries()` itself. The query shape is the contract; the
 * scan can move into SQL later without changing callers.
 */

import type {
  CursorPage,
  LedgerEntry,
  StreamStatus,
  StreamView,
} from "@neuro-pay/types";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "@neuro-pay/types";

export type PaymentListQuery = {
  limit?: number;
  /** Last `sequence` from the previous page (newest-first). */
  cursor?: string;
  event?: LedgerEntry["event"];
  streamId?: string;
};

export type StreamListQuery = {
  limit?: number;
  /** `${openedAt}|${streamId}` of the last item on the previous page. */
  cursor?: string;
  status?: StreamStatus;
};

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw)) return DEFAULT_LIST_LIMIT;
  if (raw < 1) return 1;
  if (raw > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return raw;
}

export function paginatePayments(
  entries: LedgerEntry[],
  query: PaymentListQuery,
): CursorPage<LedgerEntry> {
  const limit = clampLimit(query.limit);
  const cursorSeq =
    query.cursor !== undefined && /^\d+$/.test(query.cursor)
      ? Number(query.cursor)
      : null;

  const filtered = entries.filter((entry) => {
    if (query.event !== undefined && entry.event !== query.event) return false;
    if (query.streamId !== undefined && entry.streamId !== query.streamId) {
      return false;
    }
    if (cursorSeq !== null && entry.sequence >= cursorSeq) return false;
    return true;
  });

  filtered.sort((a, b) => b.sequence - a.sequence);
  const page = filtered.slice(0, limit);
  const next = filtered[limit];
  return {
    items: page,
    nextCursor:
      next === undefined ? null : String(page[page.length - 1]!.sequence),
  };
}

export function streamCursor(stream: StreamView): string {
  return `${stream.openedAt}|${stream.streamId}`;
}

export function paginateStreams(
  streams: StreamView[],
  query: StreamListQuery,
): CursorPage<StreamView> {
  const limit = clampLimit(query.limit);
  const filtered = streams.filter((stream) => {
    if (query.status !== undefined && stream.status !== query.status) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? 1 : -1;
    return a.streamId < b.streamId ? 1 : a.streamId > b.streamId ? -1 : 0;
  });

  let start = 0;
  if (query.cursor !== undefined) {
    const idx = filtered.findIndex((s) => streamCursor(s) === query.cursor);
    start = idx === -1 ? filtered.length : idx + 1;
  }

  const page = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  return {
    items: page,
    nextCursor:
      hasMore && page.length > 0 ? streamCursor(page[page.length - 1]!) : null,
  };
}
