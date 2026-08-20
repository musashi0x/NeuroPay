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

/**
 * The buyer-signed Permit2 authorization, persisted alongside the intent.
 *
 * Without these three fields a recovered intent is unsettleable: Permit2
 * rebuilds the signed digest from the spender, the witness, and the
 * permit body, then checks it against the signature. A process that
 * crashes between delivery and submission has to be able to reconstruct
 * the exact same arguments, so they live in the table rather than only in
 * the in-flight request.
 */
export type SettlementAuthorizationRecord = {
  signature: Hex;
  spender: Address;
  witness: { to: Address; validAfter: string };
};

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
  authorization: SettlementAuthorizationRecord | null;
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
  signature: string | null;
  spender: string | null;
  witness_to: string | null;
  witness_valid_after: string | null;
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
    signature: intent.authorization?.signature ?? null,
    spender: intent.authorization?.spender ?? null,
    witness_to: intent.authorization?.witness.to ?? null,
    witness_valid_after: intent.authorization?.witness.validAfter ?? null,
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
    authorization: decodeAuthorization(row),
    status: row.status as SettlementIntentStatus,
    transactionHash: row.transaction_hash as Hex | null,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Rebuild the authorization from its four columns.
 *
 * All-or-nothing: a row written before these columns existed (or by a
 * settler path that had no authorization to record) decodes to `null`
 * rather than to a half-populated struct, so a caller cannot mistake a
 * legacy row for a settleable one.
 */
function decodeAuthorization(
  row: SettlementIntentRow,
): SettlementAuthorizationRecord | null {
  if (
    row.signature === null ||
    row.spender === null ||
    row.witness_to === null ||
    row.witness_valid_after === null
  ) {
    return null;
  }
  return {
    signature: row.signature as Hex,
    spender: row.spender as Address,
    witness: {
      to: row.witness_to as Address,
      validAfter: row.witness_valid_after,
    },
  };
}
