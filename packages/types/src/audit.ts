import type { IsoTimestamp } from "./primitives.js";

/**
 * Administrative actions worth reconstructing after the fact.
 *
 * These are deliberately separate from `LedgerEventType`. A ledger entry
 * answers "what happened to the money"; an audit event answers "who told
 * the system to do something, and what came of it". The two overlap on
 * exactly one fact — revocation — and they record different halves of
 * it: the ledger records that the session ended, the audit trail records
 * that an operator asked for it, when, and under which request id.
 *
 * The list is closed rather than free-form so a reader can enumerate
 * what the system is capable of auditing without grepping call sites.
 */
export type AuditAction =
  /** Operator called the kill switch. */
  | "session.revoke.requested"
  /** Operator resubmitted the on-chain half of a failed revoke. */
  | "session.revoke.retry.requested"
  /** A session key was granted on chain. */
  | "session.granted"
  /** Token approvals / checker registration for a session's payment rail. */
  | "session.rail.provisioned"
  /** Operator asked for a failed settlement intent to be resubmitted. */
  | "settlement.retry.requested"
  /** The seller's price sheet changed, which ends every open stream. */
  | "prices.updated"
  /** Effective configuration observed at boot. */
  | "config.loaded"
  /** A configuration value changed while the process was running. */
  | "config.changed"
  /** The payment runtime finished wiring and began accepting work. */
  | "process.started"
  /** The payment runtime drained and shut down. */
  | "process.stopped";

/**
 * What the action did, from the point of view of the caller.
 *
 * `requested` is a real terminal state and not a placeholder: an action
 * whose effect lands asynchronously (an on-chain revoke that is still
 * pending) is recorded as requested, and its outcome arrives as a
 * separate later event rather than by mutating this one.
 */
export type AuditOutcome = "requested" | "succeeded" | "failed";

/**
 * One append-only administrative record.
 *
 * Like the payment ledger, rows are never updated in place, ordering is
 * carried by `sequence`, and no field ever carries private key material
 * — the same write-time guard runs on both tables.
 */
export type AuditEvent = {
  id: string;
  /** Dense, monotonic write order within the audit table. */
  sequence: number;
  timestamp: IsoTimestamp;
  action: AuditAction;
  /**
   * Who acted. `operator` for an authenticated console call, `system`
   * for the process acting on its own (boot, shutdown, sweep), or
   * `script:<name>` for an operator CLI.
   */
  actor: string;
  /**
   * What was acted on — a wallet address, a stream id, a settlement
   * nonce, a config key. Null when the action is process-wide.
   */
  subject: string | null;
  outcome: AuditOutcome;
  /** The HTTP request id the action arrived under, when it came over HTTP. */
  requestId: string | null;
  /** Free-form operator detail. Never key material. */
  detail: string | null;
};
