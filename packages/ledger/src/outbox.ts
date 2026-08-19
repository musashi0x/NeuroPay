/**
 * Durable settlement outbox.
 *
 * The append-only event log records what happened. This table records
 * work that still has to happen: a delivered segment whose
 * `Permit2.permitWitnessTransferFrom` has not yet been submitted or
 * confirmed. Status is mutable (pending → submitted → confirmed|failed);
 * the audit trail stays in `ledger_entries`.
 */

import type {
  Address,
  Hex,
  IsoTimestamp,
  SmallestUnits,
} from "@neuro-pay/types";

export type SettlementIntentStatus =
  "pending" | "submitted" | "confirmed" | "failed";

export type SettlementIntent = {
  nonce: string;
  streamId: string;
  sessionPublicKey: Hex | null;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  amount: SmallestUnits;
  payer: Address;
  payTo: Address;
  deadline: number | null;
  status: SettlementIntentStatus;
  transactionHash: Hex | null;
  attempts: number;
  lastError: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type SettlementIntentPatch = {
  status?: SettlementIntentStatus;
  transactionHash?: Hex | null;
  attempts?: number;
  lastError?: string | null;
};

export type SettlementIntentRow = {
  nonce: string;
  stream_id: string;
  session_public_key: string | null;
  chain_id: number;
  token: string;
  token_decimals: number;
  amount: string;
  payer: string;
  pay_to: string;
  deadline: number | null;
  status: string;
  transaction_hash: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export function encodeSettlementIntent(
  intent: SettlementIntent,
): SettlementIntentRow {
  return {
    nonce: intent.nonce,
    stream_id: intent.streamId,
    session_public_key: intent.sessionPublicKey,
    chain_id: intent.chainId,
    token: intent.token,
    token_decimals: intent.tokenDecimals,
    amount: intent.amount.toString(10),
    payer: intent.payer,
    pay_to: intent.payTo,
    deadline: intent.deadline,
    status: intent.status,
    transaction_hash: intent.transactionHash,
    attempts: intent.attempts,
    last_error: intent.lastError,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

export function decodeSettlementIntentRow(
  row: SettlementIntentRow,
): SettlementIntent {
  return {
    nonce: row.nonce,
    streamId: row.stream_id,
    sessionPublicKey: row.session_public_key as Hex | null,
    chainId: row.chain_id,
    token: row.token as Address,
    tokenDecimals: row.token_decimals,
    amount: BigInt(row.amount) as SmallestUnits,
    payer: row.payer as Address,
    payTo: row.pay_to as Address,
    deadline: row.deadline,
    status: row.status as SettlementIntentStatus,
    transactionHash: row.transaction_hash as Hex | null,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
