/**
 * Wire contracts shared between `apps/api` and `apps/web`.
 *
 * Token amounts are `bigint` in the smallest unit of their token, never a
 * float and never a human-readable decimal — a per-second price on an
 * 18-decimal token loses cents to `number` before the first tick. JSON cannot
 * carry `bigint`, so any transport of these shapes must go through a codec
 * that tags and restores them; these types describe the decoded value on
 * either side of that codec, not the bytes on the socket.
 */

export type HealthResponse = {
  status: "ok";
  service: "api";
  timestamp: string;
};

export type {
  Address,
  Hex,
  IsoTimestamp,
  SmallestUnits,
} from "./primitives.js";
export type { PriceSheet } from "./pricing.js";
export type {
  SegmentResponse,
  StreamEndReason,
  StreamOpenResponse,
  StreamView,
} from "./stream.js";
export type {
  X402Extra,
  X402PaymentRequired,
  X402Rail,
  X402Requirement,
} from "./x402.js";
export type {
  LedgerEntry,
  LedgerEventType,
  PaymentFailureClassification,
} from "./ledger.js";
export type {
  RevokeResult,
  SessionCallPermission,
  SessionPolicyView,
  SessionStatus,
} from "./session.js";
export type { ConsoleSnapshot } from "./console.js";
export type { BudgetState } from "./budget.js";
export type {
  AppConfig,
  ChainConfig,
  MeteringConfig,
  SecretsConfig,
  SessionConfig,
} from "./config.js";
