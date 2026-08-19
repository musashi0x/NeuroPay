/**
 * Settlement lifecycle hooks (P0 TODO 5/7).
 *
 * The settlement queue records `settlement.*` ledger entries. This module
 * is the matching in-process accounting: when a settlement confirms,
 * credit the stream meter (`recordSettle`) and release the exposure slot.
 * When it fails or is lost, keep the slot reserved so failed delivery
 * stays visible as unrecovered exposure. Operator retry/recovery of
 * those slots is a P1 outbox concern — this layer only holds them.
 */

import type {
  PaymentFailureClassification,
  SmallestUnits,
} from "@neuro-pay/types";
import type { Clock } from "@neuro-pay/metering";
import type { ExposureCounter } from "./exposure.js";
import type { StreamStore } from "./streams.js";
import type { SettlementQueueHooks } from "./settle.js";
import { logger } from "../logger.js";

export type SettlementHookDeps = {
  streams: StreamStore;
  exposure: ExposureCounter;
  clock: Clock;
};

/**
 * Bind meter + exposure accounting to the settlement queue callbacks.
 * `detach` is a no-op today: the seller owns the process lifetime.
 */
export function attachSettlementHooks(
  deps: SettlementHookDeps,
): SettlementQueueHooks & { detach: () => void } {
  return {
    onConfirmed: (input) =>
      onSettlementConfirmed({
        streams: deps.streams,
        exposure: deps.exposure,
        clock: deps.clock,
        streamId: input.streamId,
        nonce: input.nonce,
        amount: input.amount,
      }),
    onFailed: (input, failure) =>
      onSettlementFailed({
        nonce: input.nonce,
        classification: failure.classification,
        detail: failure.detail,
      }),
    detach: () => {
      // No listener removal — the seller owns the lifecycle.
    },
  };
}

/**
 * Credit `min(amount, accruedUnpaid)` on the stream meter and release
 * the in-flight exposure slot. Caps at unpaid so an over-authorized
 * envelope cannot throw in `settle()` or drive the meter negative.
 */
export function onSettlementConfirmed(input: {
  streams: StreamStore;
  exposure: ExposureCounter;
  clock: Clock;
  streamId: string;
  nonce: string;
  amount: SmallestUnits;
}): void {
  const record = input.streams.get(input.streamId);
  if (record !== null && record.endReason === null) {
    const unpaid = record.meter.accruedUnpaid;
    const credit = input.amount > unpaid ? unpaid : input.amount;
    if (credit > 0n) {
      try {
        input.streams.recordSettle(input.streamId, credit, input.clock);
      } catch (err: unknown) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            nonce: input.nonce,
            streamId: input.streamId,
            amount: input.amount.toString(),
          },
          "settlement-hooks: recordSettle failed; exposure still released",
        );
      }
    }
  }
  input.exposure.release();
  logger.debug(
    {
      nonce: input.nonce,
      amount: input.amount.toString(),
      streamId: input.streamId,
    },
    "settlement confirmed: meter credited, exposure released",
  );
}

/**
 * Failed settlements do not credit the meter and do not release the
 * exposure slot. The slot stays counted toward `maxInFlightSettlements`
 * until a future retry confirms (P1) or the process restarts.
 */
export function onSettlementFailed(input: {
  nonce: string;
  classification: PaymentFailureClassification;
  detail?: string;
}): void {
  logger.warn(
    {
      nonce: input.nonce,
      classification: input.classification,
      detail: input.detail,
    },
    "settlement failed: exposure held as unrecovered",
  );
}

/**
 * Lost (timed-out) settlements are treated like failures: the funds
 * may or may not have moved, so the seller keeps the slot reserved
 * rather than pretending exposure cleared.
 */
export function onSettlementLost(input: { nonce: string }): void {
  logger.warn(
    { nonce: input.nonce },
    "settlement lost: exposure held as unrecovered; operator reconciliation required",
  );
}
