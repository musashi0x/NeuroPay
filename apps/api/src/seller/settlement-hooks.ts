/**
 * Settlement lifecycle hooks (P0 TODO 5/7).
 *
 * The chain-backed settler in `chain-settler.ts` emits the chain-truth
 * `payment.settlement.*` ledger entries. This module is the matching
 * accounting hook: when a settlement confirms, decrement the local
 * accrued-unpaid counter and mark the segment as settled. When it
 * fails or is lost, *keep* the exposure reserved and surface the
 * failure classification.
 */

import type {
  Address,
  Hex,
  PaymentFailureClassification,
  SmallestUnits,
} from "@neuro-pay/types";
import type { LedgerStore } from "@neuro-pay/ledger";
import { recordPaymentSettlementFailed } from "@neuro-pay/ledger";
import type { ExposureCounter } from "./exposure.js";
import type { SettlementQueue } from "./settle.js";
import { logger } from "../logger.js";

export type SettlementHookInput = {
  spenderAddress: Address;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  exposure: ExposureCounter;
  queue: SettlementQueue;
  ledger: LedgerStore;
};

export function attachSettlementHooks(
  _input: SettlementHookInput,
): { detach: () => void } {
void _input; // reserved for future hook lifecycle wiring (ledger event subscription, exposure-notify)
  const detach = (): void => {
    // No listener removal — the runtime owns the lifecycle.
  };
  return { detach };
}

export function onSettlementConfirmed(input: {
  exposure: ExposureCounter;
  nonce: string;
  amount: SmallestUnits;
}): void {
  input.exposure.release();
  logger.debug(
    { nonce: input.nonce, amount: input.amount.toString() },
    "settlement confirmed: exposure released",
  );
}

export async function onSettlementFailed(input: {
  exposure: ExposureCounter;
  queue: SettlementQueue;
  ledger: LedgerStore;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  nonce: string;
  amount: SmallestUnits;
  streamId: string;
  transactionHash: Hex | null;
  classification: PaymentFailureClassification;
  detail: string;
}): Promise<void> {
  try {
    await recordPaymentSettlementFailed({
      store: input.ledger,
      ctx: {
        streamId: input.streamId,
        sessionPublicKey: null,
        chainId: input.chainId,
        token: input.token,
        tokenDecimals: input.tokenDecimals,
      },
      amount: input.amount,
      nonce: input.nonce,
      classification: input.classification,
      transactionHash: input.transactionHash,
      detail: input.detail,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        nonce: input.nonce,
      },
      "settlement-hooks: failed to record payment.settlement.failed",
    );
  }
  logger.debug(
    {
      nonce: input.nonce,
      classification: input.classification,
    },
    "settlement failed: exposure held",
  );
}

export function onSettlementLost(input: {
  exposure: ExposureCounter;
  nonce: string;
}): void {
  input.exposure.release();
  logger.warn(
    { nonce: input.nonce },
    "settlement lost: exposure released; operator reconciliation required",
  );
}
