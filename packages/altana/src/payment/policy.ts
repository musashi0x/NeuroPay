/**
 * The pre-sign policy: every refusal that fires before a signature is
 * produced runs here.
 *
 * The ordering is intentional. The cheapest checks run first:
 *  1. Session expiry — the cheapest check; a session past its `expiry`
 *     can never sign anything useful, and refusing here costs nothing.
 *  2. Rail provisioned — a flat boolean check; an unprovisioned rail
 *     means the envelope is unspendable regardless of what we sign.
 *  3. Budget — the local ceiling, which is the tighter bound; we never
 *     let a payment slip past the local budget to hit the on-chain cap.
 *  4. Demanded-vs-expected — the disagreement check; an over-tolerance
 *     demand is refused even when the budget would otherwise admit it.
 *
 * Each check throws `PaymentFailureError` with a distinct classification,
 * so the call site's `catch` branches on `err.classification` without
 * reading the message. None of these checks produces a signature — the
 * function returns `void` on success, and the caller proceeds to
 * `signX402PaymentFor`.
 */

import { compareToExpected, preSignCheck } from "@neuro-pay/metering";
import type { X402Requirement } from "@neuro-pay/types";
import { PaymentFailureError } from "./errors.js";
import type { PaymentClientContext } from "./context.js";

/**
 * Inputs to `policyCheck`.
 *
 * `requirement` is the selected requirement (already passed the
 * selection step, so its chain and token are valid). `expected` and
 * `tolerance` are the buyer-side mirror numbers; either can be
 * `undefined` to skip the over-tolerance check (useful for one-off
 * purchases with no rolling expected figure).
 */
export type PolicyCheckInput = {
  requirement: X402Requirement;
  payment: PaymentClientContext;
  expected?: bigint;
  tolerance?: number;
  demanded: bigint;
};

/**
 * Run every pre-sign check.
 *
 * Throws `PaymentFailureError` on the first refusal. Returns `void`
 * on success — the absence of an exception is the contract.
 */
export function policyCheck(input: PolicyCheckInput): void {
  // 1. Session expiry. The session is dead the instant `now >= expiresAt`;
  // refusing here stops the signing path immediately. We use the
  // injectable clock when present so tests can pin "now" without
  // touching `Date.now`.
  const nowSeconds = input.payment.now
    ? input.payment.now()
    : Math.floor(Date.now() / 1000);
  if (input.payment.expiresAt <= nowSeconds) {
    throw new PaymentFailureError(
      "session-expired",
      `policyCheck: session expired at ${input.payment.expiresAt} (now=${nowSeconds}). ` +
        `Refusing to sign; grant a new session rather than signing against an expired key.`,
      {
        detail: {
          expiresAt: input.payment.expiresAt,
          now: nowSeconds,
          walletAddress: input.payment.walletAddress,
        },
      },
    );
  }

  // 2. Rail provisioned. The payment client itself refuses to sign when
  // the rail flag is false — every envelope against an unprovisioned
  // rail is unspendable, and the merchant verification failure looks
  // indistinguishable from a bad signature. Better to refuse explicitly.
  if (!input.payment.railProvisioned) {
    throw new PaymentFailureError(
      "session-unprovisioned",
      `policyCheck: rail not provisioned for wallet ${input.payment.walletAddress}. ` +
        `Run provisionRail() before the first payment — an envelope signed ` +
        `without an approved checker will fail at merchant verification.`,
      {
        detail: {
          walletAddress: input.payment.walletAddress,
        },
      },
    );
  }

  // 3. Budget. The local ceiling is checked first because it is the
  // tighter bound; the on-chain cap is checked as a backstop in case
  // the local limit drifted above the cap. Both come from
  // `@neuro-pay/metering`'s `preSignCheck`, which returns the same
  // refusal-reason vocabulary we map onto our classification.
  const budgetResult = preSignCheck({
    state: input.payment.budget,
    amount: input.demanded,
  });
  if (!budgetResult.ok) {
    const classification =
      budgetResult.reason === "over-local-budget"
        ? "budget-exhausted"
        : budgetResult.reason === "over-on-chain-cap"
          ? "budget-exhausted"
          : "budget-exhausted";
    throw new PaymentFailureError(
      classification,
      `policyCheck: budget refuses the payment (${budgetResult.reason}). ` +
        `Demanded ${input.demanded} smallest units against a window whose ` +
        `localRemaining is ${input.payment.budget.localRemaining} of ` +
        `${input.payment.budget.localLimit}. Refusing to sign — the on-chain ` +
        `cap would revert after delivery.`,
      {
        detail: {
          reason: budgetResult.reason,
          demanded: input.demanded,
          localLimit: input.payment.budget.localLimit,
          localRemaining: input.payment.budget.localRemaining,
          onChainCap: input.payment.budget.onChainCap,
          onChainRemaining: input.payment.budget.onChainRemaining,
        },
      },
    );
  }

  // 4. Demanded-vs-expected. Skip when the caller didn't supply both
  // halves — the typical case is the very first payment where the
  // buyer has no rolling expected figure yet.
  if (input.expected !== undefined && input.tolerance !== undefined) {
    const comparison = compareToExpected(
      input.expected,
      input.demanded,
      input.tolerance,
    );
    if (!comparison.ok) {
      throw new PaymentFailureError(
        "overcharge-beyond-tolerance",
        `policyCheck: seller's demand exceeds the buyer's expectation beyond ` +
          `tolerance. Demanded: ${comparison.demanded}. Expected: ${comparison.expected}. ` +
          `Difference: ${comparison.difference}. Tolerance: ${input.tolerance}. ` +
          `Refusing to sign; this is the disagreement the buyer-side mirror ` +
          `is designed to catch.`,
        {
          detail: {
            demanded: comparison.demanded,
            expected: comparison.expected,
            difference: comparison.difference,
            tolerance: input.tolerance,
          },
        },
      );
    }
  }
}
