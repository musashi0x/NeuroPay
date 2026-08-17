/**
 * Failure classification for x402 payment attempts.
 *
 * Every payment failure has exactly one classification. The set is
 * deliberately closed: callers pattern-match on `classification`, not on
 * message text. New categories are added by editing the union, not by
 * reusing a generic `signing-failed` bucket — that's the failure this
 * module exists to prevent, because a generic failure on a
 * real-b402-merchant rejection looks like a bug in our signing.
 *
 * ## Why `eoa-only-facilitator` is its own classification
 *
 * Real b402 merchants sometimes verify with `ecrecover`, which decodes a
 * 65-byte EOA signature. Our session-key envelope is 98 bytes (the nested
 * ERC-1271 envelope: `innerSig ‖ keyHash ‖ prehash`), so `ecrecover`
 * returns garbage and the merchant rejects it. The signature is
 * perfectly valid — the verifier just can't read it. Reporting this as a
 * generic payment failure would let a real bug in our signing hide
 * behind a merchant quirk, and the operator would chase the wrong cause
 * for hours. Naming it explicitly makes the answer to "why did payment N
 * fail" a single word instead of a log dive.
 *
 * ## Mapping to the typed ledger
 *
 * `PaymentFailureClassification` in `@neuro-pay/types` carries the same
 * union minus the buyer-side-only categories (no-payable-option,
 * wrong-chain-only, unpermitted-token, budget-exhausted,
 * overcharge-beyond-tolerance, session-expired, session-revoked,
 * session-unprovisioned, stream-would-outlive-session). Those live on the
 * buyer side and never reach a seller's ledger; the rest do. This module
 * uses the buyer-side subset; the seller-side set is defined in
 * `packages/types/src/ledger.ts`.
 */

import type { PaymentFailureClassification } from "@neuro-pay/types";

/**
 * A union of every buyer-side classification the payment client can emit.
 *
 * Subset of the typed `PaymentFailureClassification` covering the cases a
 * payment client can encounter before (or at) submission: a missing or
 * unsuitable requirement, a local refusal, an expired session, an
 * unprovisioned rail, or a merchant rejection distinguishable from our
 * own signing failures.
 *
 * The seller-side classifications (`amount-underpaid`, `recipient-mismatch`,
 * `verification-failed`, `duplicate-nonce`, `settlement-reverted`,
 * `settler-out-of-gas`, `exposure-limit-reached`) are not reachable from
 * this package and are deliberately absent.
 */
export type BuyerPaymentFailure =
  | "no-payable-option"
  | "wrong-chain-only"
  | "unpermitted-token"
  | "budget-exhausted"
  | "overcharge-beyond-tolerance"
  | "session-expired"
  | "session-revoked"
  | "session-unprovisioned"
  | "stream-would-outlive-session"
  | "eoa-only-facilitator"
  | "verification-failed";

/** Type guard: is a string one of the buyer-side failure categories? */
export function isBuyerPaymentFailure(
  value: string,
): value is BuyerPaymentFailure {
  return BUYER_PAYMENT_FAILURES.has(value as BuyerPaymentFailure);
}

const BUYER_PAYMENT_FAILURES: ReadonlySet<BuyerPaymentFailure> = new Set([
  "no-payable-option",
  "wrong-chain-only",
  "unpermitted-token",
  "budget-exhausted",
  "overcharge-beyond-tolerance",
  "session-expired",
  "session-revoked",
  "session-unprovisioned",
  "stream-would-outlive-session",
  "eoa-only-facilitator",
  "verification-failed",
]);

/**
 * Base class for every payment-failure the client emits.
 *
 * Carries the `classification` discriminator up front so a caller never
 * has to read the message to decide what to do. Subclasses exist for
 * each classification so `try { ... } catch (err) { switch (err.classification) }`
 * reads at the call site without further casting.
 *
 * The class is exported but never thrown directly — `throw new PaymentFailureError(...)`
 * is always accompanied by a `classification`. `cause` is the original
 * error when one exists (e.g. an SDK rejection), and is preserved so the
 * underlying stack survives even when the classification abstracts it
 * away.
 */
export class PaymentFailureError extends Error {
  readonly classification: BuyerPaymentFailure;
  /** Optional structured detail for the operator (amounts, addresses, etc.). */
  readonly detail: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    classification: BuyerPaymentFailure,
    message: string,
    options?: {
      detail?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, causeToOptions(options?.cause));
    this.name = "PaymentFailureError";
    this.classification = classification;
    this.detail = options?.detail ?? {};
    // `cause` is declared `override` because `Error.cause` exists;
    // assign explicitly so the field is enumerable on this prototype.
    this.cause = options?.cause;
  }
}

function causeToOptions(
  cause: unknown,
): { cause: unknown } | undefined {
  // Error's constructor takes options with `cause`; passing `undefined`
  // would still set cause to undefined on the base, which we then
  // overwrite. Pass nothing when no cause to avoid an empty options bag.
  return cause === undefined ? undefined : { cause };
}

/**
 * Detect the EOA-only-facilitator case from a thrown error message.
 *
 * SDK and merchant rejections land here as opaque `Error` instances. The
 * textual patterns below are stable across the b402 merchants we have
 * seen reject smart-account envelopes — `ecrecover` returns an
 * all-zero address when handed a non-65-byte payload, and the merchant
 * then says so in language the call site can pattern-match.
 *
 * Adding a new pattern is fine; adding a generic catch-all is not —
 * the whole point of this classification is that it is *distinct*.
 */
export function looksLikeEoaOnlyFacilitator(err: unknown): boolean {
  const text = errorText(err);
  if (text === "") return false;
  return EOA_FACILITATOR_PATTERNS.some((pattern) => pattern.test(text));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

const EOA_FACILITATOR_PATTERNS: readonly RegExp[] = [
  /ecrecover/i,
  /invalid signature length/i,
  /signature length is 65/i,
  /expected 65[- ]byte signature/i,
  /recovered address is 0x0+/i,
  /signer recovered to zero address/i,
];

/**
 * Re-export the typed classification so callers do not need a second
 * import to map a buyer-side error back to a ledger entry.
 */
export type { PaymentFailureClassification };

/**
 * Subtype narrowing helper: is this classification one this package can
 * emit (vs. a seller-side classification that would never come from a
 * payment client)?
 */
export function isPaymentClientClassification(
  value: string,
): value is BuyerPaymentFailure {
  return isBuyerPaymentFailure(value);
}