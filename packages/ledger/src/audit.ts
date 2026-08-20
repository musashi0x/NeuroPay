/**
 * The administrative audit trail.
 *
 * ## Why it is not the payment ledger
 *
 * Every `ledger_entries` row carries a chain id, a token, and decimals,
 * because every row is a fact about money. "An operator revoked the
 * session at 14:02 under request id `r-91`" has none of those, and the
 * only way to store it there is to invent a token and a chain that later
 * aggregations would then sum over. So administrative actions get their
 * own table with their own shape, in the same file so a single backup
 * captures both and a single `close()` releases both.
 *
 * ## What it guarantees
 *
 * The same three invariants the payment ledger has:
 *
 * - **append-only** — rows are inserted, never updated or deleted; a
 *   mistaken record is superseded by a later one, not rewritten;
 * - **ordered** — `seq` is dense and monotonic, because two operator
 *   actions in the same millisecond still happened in an order;
 * - **free of key material** — the same `assertNoKeyMaterial` guard runs
 *   on the write path, so an operator note that pastes a private key is
 *   refused rather than persisted.
 */

import type { AuditAction, AuditEvent, AuditOutcome } from "@neuro-pay/types";

/** Wire columns of an audit row on disk. */
export type AuditRow = {
  id: string;
  seq: number;
  timestamp: string;
  action: string;
  actor: string;
  subject: string | null;
  outcome: string;
  request_id: string | null;
  detail: string | null;
};

/**
 * Inputs for an audit append.
 *
 * The caller supplies the facts; `id`, `sequence`, and `timestamp` come
 * from the store, which is what makes the ordering guarantee the
 * store's to keep rather than each call site's.
 */
export type AuditAppendInput = {
  action: AuditAction;
  actor: string;
  outcome: AuditOutcome;
  subject?: string | null;
  requestId?: string | null;
  detail?: string | null;
  /** Test hook: pin the timestamp so snapshots are reproducible. */
  timestamp?: string;
};

/** Narrowing filter for `auditEvents`. */
export type AuditQuery = {
  action?: AuditAction;
  /** Most recent N, still returned oldest-first. Omit for everything. */
  limit?: number;
};

const VALID_OUTCOMES: readonly AuditOutcome[] = [
  "requested",
  "succeeded",
  "failed",
];

/**
 * Reject inputs that would make the trail unreadable later.
 *
 * An empty actor is the one that matters: "someone did this" with no
 * `who` is indistinguishable from a bug that forgot to pass one, and a
 * trail you cannot attribute is not an audit trail.
 */
export function validateAuditInput(input: AuditAppendInput): void {
  if (typeof input.action !== "string" || input.action.length === 0) {
    throw new TypeError("audit action must be a non-empty string");
  }
  if (typeof input.actor !== "string" || input.actor.trim().length === 0) {
    throw new TypeError("audit actor must be a non-empty string");
  }
  if (!VALID_OUTCOMES.includes(input.outcome)) {
    throw new TypeError(
      `audit outcome must be one of ${VALID_OUTCOMES.join(", ")} (got ${JSON.stringify(input.outcome)})`,
    );
  }
}

export function decodeAuditRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    sequence: row.seq,
    timestamp: row.timestamp,
    action: row.action as AuditAction,
    actor: row.actor,
    subject: row.subject,
    outcome: row.outcome as AuditOutcome,
    requestId: row.request_id,
    detail: row.detail,
  };
}
