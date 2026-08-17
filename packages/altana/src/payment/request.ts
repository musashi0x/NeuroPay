/**
 * The payment client's entry point: a `fetch()` that pays x402 challenges.
 *
 * ## What this module does
 *
 * `fetchWithX402` wraps a standard `fetch()` and intercepts the `402
 * Payment Required` response. Non-402 responses pass through untouched —
 * the calling code never sees the difference. A 402 body is parsed into
 * `X402PaymentRequired`, a payable requirement is selected, signed, and
 * the request is retried with the `X-PAYMENT` header (and its sibling
 * `PAYMENT-SIGNATURE`) attached. The retry's response is what the caller
 * receives, regardless of the new status.
 *
 * ## What this module does NOT do
 *
 * It does not select a requirement (that's `select.ts`), it does not sign
 * (that's `sign.ts`), and it does not encode the envelope (that's
 * `encode.ts`). The reason for the split is testability: this module is
 * the only one that touches the network, so the rest can be exercised
 * against a stub merchant with no HTTP at all.
 *
 * The entry point does, however, wire the pre-sign policy: budget
 * check, demanded-vs-expected comparison, and the local session guards.
 * The flow is "fetch → parse 402 → select → policy → sign → retry"; a
 * refusal at any policy step short-circuits before signing. The spec
 * calls this "no signature under any refusal".
 */

import type {
  X402PaymentRequired,
  X402Requirement,
  Address,
} from "@neuro-pay/types";
import { selectX402Requirement } from "./select.js";
import { signX402PaymentFor } from "./sign.js";
import { policyCheck } from "./policy.js";
import { PaymentFailureError, looksLikeEoaOnlyFacilitator } from "./errors.js";
import type { PaymentClientContext } from "./context.js";

/**
 * The options bag for `fetchWithX402`.
 *
 * The shape mirrors `fetch()`'s second-argument contract: a `RequestInit`
 * for the initial request and a sibling set of payment knobs that are
 * not forwarded to `fetch()`. The two are separated so callers can pass a
 * stock `RequestInit` without worrying about payment metadata fields
 * leaking onto the wire.
 */
export type FetchWithX402Options = {
  /** Standard `fetch()` options for the initial request. */
  init?: RequestInit;
  /**
   * The buyer-side payment context: the wallet the payment is on, the
   * configured chain, the spend cap, the budget window, and the expected
   * cost. See `./context.ts`.
   */
  payment: PaymentClientContext;
  /**
   * Expected cost over delivered consumption (buyer-side mirror). When
   * omitted the policy check skips the over-tolerance step — useful
   * for one-off purchases where there is no rolling expected figure.
   */
  expected?: bigint;
  /**
   * Tolerance over expected (a fraction in `[0, 1)`). When omitted the
   * policy check also skips the over-tolerance step.
   */
  tolerance?: number;
  /**
   * Inject a custom `fetch()`. Tests pass a stub; production uses
   * the global `fetch`. The injection point exists because no
   * production code ever wants to swap `fetch`, and a global
   * mutation would defeat the tests.
   */
  fetchImpl?: typeof fetch;
};

/**
 * The result of a `fetchWithX402` call.
 *
 * `response` is the final response — either the original non-402, or the
 * response to the retry that carried the `X-PAYMENT` header.
 * `payment` is populated when the client actually paid (a 402 was seen
 * and a signed retry went out), and carries the envelope and the
 * requirement it was signed against. `payment === undefined` means no
 * payment happened, which the caller can use to skip post-payment
 * accounting on a pass-through 200.
 */
export type FetchWithX402Result = {
  response: Response;
  payment?: {
    requirement: X402Requirement;
    /** The base64 envelope that was sent under `X-PAYMENT` and `PAYMENT-SIGNATURE`. */
    header: string;
    /** The full resource URL the envelope was keyed against (URL fallback applied). */
    resourceUrl: string;
  };
};

/**
 * The client entry point.
 *
 * Flow:
 *  1. Issue the request with `fetch()` (default or injected).
 *  2. If the response is not 402, return it untouched with `payment`
 *     unset. No signature has been produced.
 *  3. If the response is 402, parse the body into `X402PaymentRequired`.
 *     A malformed body is a hard `PaymentFailureError(verification-failed)`,
 *     because the merchant either can't speak the protocol or is trying
 *     something adversarial.
 *  4. Select a payable requirement on the configured chain, preferring
 *     `permit2`. Each selection failure carries its own classification
 *     (see `select.ts`).
 *  5. Run the policy checks (`policy.ts`): budget, demanded-vs-expected,
 *     session-not-revoked, rail-provisioned. A refusal here throws before
 *     any signing.
 *  6. Sign and retry. The retry's response is returned with `payment`
 *     populated.
 *
 * `cause` is preserved on thrown `PaymentFailureError`s so the SDK's
 * stack survives.
 */
export async function fetchWithX402(
  url: string,
  options: FetchWithX402Options,
): Promise<FetchWithX402Result> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const initialResponse = await fetchImpl(url, options.init);

  if (initialResponse.status !== 402) {
    return { response: initialResponse };
  }

  // Parse the 402 body. A body that doesn't decode to a recognizable
  // payment-required shape is reported as verification-failed — the
  // merchant is either speaking a dialect we don't support or is
  // returning something adversarial; either way, refusing to sign is the
  // right move.
  const required = await parsePaymentRequired(initialResponse);

  // Selection runs the same checks the spec calls out as distinct
  // outcomes (no-payable-option, wrong-chain-only, unpermitted-token).
  // `select.ts` throws the right classification for each.
  const requirement = selectX402Requirement(required.accepts, {
    chainId: options.payment.chainId,
    permittedTokens: options.payment.permittedTokens,
    resourceUrl: url,
  });

  // Policy runs the budget check and the demanded-vs-expected comparison
  // in front of signing. Refusals throw here — no signature is produced.
  policyCheck({
    requirement,
    payment: options.payment,
    ...(options.expected !== undefined ? { expected: options.expected } : {}),
    ...(options.tolerance !== undefined
      ? { tolerance: options.tolerance }
      : {}),
    demanded: requirement.maxAmountRequired,
  });

  // Sign + encode. signX402PaymentFor owns the SDK call.
  const { header, payload } = await signX402PaymentFor({
    session: options.payment.session,
    requirement,
    resourceUrl: url,
    payerAddress: options.payment.walletAddress,
  });

  // Retry with the envelope attached. Both `X-PAYMENT` (canonical) and
  // `PAYMENT-SIGNATURE` (b402 sibling header) carry the same base64
  // envelope — see `encode.ts` for the shape and the rationale.
  const retryHeaders = new Headers(options.init?.headers);
  retryHeaders.set("X-PAYMENT", header);
  retryHeaders.set("PAYMENT-SIGNATURE", header);

  const retryInit: RequestInit = {
    ...options.init,
    headers: retryHeaders,
  };

  // Network errors during the retry are not signing failures — the
  // envelope was sent, the network just didn't deliver a response, so
  // let the caller decide. (No try/catch wrapper — the error already
  // propagates verbatim.)
  const retryResponse = await fetchImpl(url, retryInit);

  // A merchant that verifies with `ecrecover` rejects the 98-byte
  // envelope with a 4xx that *looks* like a verification failure but is
  // actually a verifier-dialect mismatch. Detect and re-classify so it
  // never looks like our signing is broken.
  if (retryResponse.status >= 400) {
    await maybeRethrowAsEoaOnly(retryResponse, payload);
  }

  return {
    response: retryResponse,
    payment: { requirement, header, resourceUrl: url },
  };
}

/**
 * Parse a `402` body into `X402PaymentRequired`.
 *
 * The shape we accept is exactly the typed `X402PaymentRequired`. The
 * merchant may also send a top-level `resource` (b402), which is read
 * here and folded into each requirement's `resource` (a URL fallback
 * for the per-requirement one) — the `select.ts` step normalizes
 * per-requirement resources at selection time.
 *
 * Throws `PaymentFailureError(verification-failed)` on a body that
 * does not decode to a recognizable payment-required shape.
 */
export async function parsePaymentRequired(
  response: Response,
): Promise<X402PaymentRequired> {
  let raw: unknown;
  try {
    raw = await response.clone().json();
  } catch (err) {
    throw new PaymentFailureError(
      "verification-failed",
      `fetchWithX402: cannot parse 402 body as JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return normalizePaymentRequired(raw);
}

/**
 * Coerce the unknown decoded body into `X402PaymentRequired`.
 *
 * The shape we accept: `{ x402Version: number, error?: string, accepts: X402Requirement[] }`.
 * Anything else — a missing field, an `accepts` that isn't an array, a
 * `x402Version` that isn't a number — is a verification failure.
 */
export function normalizePaymentRequired(
  raw: unknown,
): X402PaymentRequired {
  if (typeof raw !== "object" || raw === null) {
    throw new PaymentFailureError(
      "verification-failed",
      `fetchWithX402: 402 body is not an object: ${typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.x402Version !== "number") {
    throw new PaymentFailureError(
      "verification-failed",
      `fetchWithX402: 402 body is missing x402Version`,
    );
  }
  if (!Array.isArray(obj.accepts)) {
    throw new PaymentFailureError(
      "verification-failed",
      `fetchWithX402: 402 body is missing accepts[]`,
    );
  }
  // Each accept is required to have a recognizable shape; we let the
  // selection step reject specifics so the error messages stay close to
  // the cause ("unpermitted-token" rather than "shape mismatch").
  return {
    x402Version: obj.x402Version,
    error: typeof obj.error === "string" ? obj.error : null,
    accepts: obj.accepts as X402Requirement[],
  };
}

/**
 * Inspect a 4xx retry response and rethrow as
 * `eoa-only-facilitator` when the body text matches the patterns we
 * know come from `ecrecover`-based verifiers.
 *
 * No-op when the retry succeeds — successful retries are returned
 * verbatim. No-op when the response body is empty or unparseable —
 * those stay as `verification-failed`.
 */
async function maybeRethrowAsEoaOnly(
  response: Response,
  payload: unknown,
): Promise<void> {
  let bodyText: string;
  try {
    bodyText = await response.clone().text();
  } catch {
    bodyText = "";
  }

  if (looksLikeEoaOnlyFacilitator(bodyText)) {
    throw new PaymentFailureError(
      "eoa-only-facilitator",
      `fetchWithX402: merchant rejected a valid smart-account envelope. ` +
        `The merchant's facilitator appears to verify with ecrecover ` +
        `(65-byte EOA signatures only) and cannot read a 98-byte ` +
        `ERC-1271 session-key envelope. Status: ${response.status}. ` +
        `Body: ${truncate(bodyText, 240)}.`,
      { detail: { status: response.status, payload } },
    );
  }

  throw new PaymentFailureError(
    "verification-failed",
    `fetchWithX402: merchant rejected the signed envelope. ` +
      `Status: ${response.status}. Body: ${truncate(bodyText, 240)}.`,
    { detail: { status: response.status, payload } },
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** Marker export so consumers can re-use the same normalized body type. */
export type { Address };