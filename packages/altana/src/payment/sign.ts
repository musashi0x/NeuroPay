/**
 * Payment signing.
 *
 * This module wraps the SDK's `signX402Payment` so the payment client
 * gets a uniform signed-payload interface regardless of the rail. The
 * SDK has already produced the typed-data digest, called the session
 * key, and produced the nested ERC-1271 envelope by the time this
 * module is done with it.
 *
 * What this module owns:
 *  - Calling the SDK with the requirement shape the SDK understands
 *    (a real-b402 merchant sends `extra.assetTransferMethod =
 *    "permit2-exact"`; the SDK's requirement type is wider than the
 *    typed `X402Requirement` here, and we bridge the two).
 *  - Time and randomness injection so tests can pin `now` and
 *    `permit2Nonce` without monkey-patching the SDK.
 *  - Returning the signed payload alongside the base64 header.
 *
 * What this module deliberately does NOT own:
 *  - The b402 dialect envelope shape. That lives in `encode.ts`.
 *  - The pre-sign policy. That lives in `policy.ts`.
 *  - The selection logic. That lives in `select.ts`.
 *
 * The separation is so a test of one piece can stub the rest without
 * hitting the network or the SDK.
 */

import type { X402Requirement } from "@neuro-pay/types";
import type {
  SignX402Options,
  Session,
  X402PaymentPayload,
} from "@altananetwork/sdk";
import { signX402Payment } from "@altananetwork/sdk";
import { encodeB402Envelope, type B402Envelope } from "./encode.js";
import type { Address } from "@neuro-pay/types";

/**
 * Inputs to `signX402PaymentFor`.
 *
 * `session` is the live SDK session — carries the wallet address and
 * the (in-memory) signer. `requirement` is the normalized
 * `X402Requirement` produced by `select.ts`. `resourceUrl` is the
 * request URL, used as the resource fallback (b402 requires
 * non-null). `now` is the Unix-seconds clock used for `validBefore`
 * derivation; defaults to wall clock.
 *
 * `permit2Nonce` and `eip3009Nonce` are exposed for replay control in
 * tests; production lets them default to random.
 */
export type SignForRequirementInput = {
  session: Session;
  requirement: X402Requirement;
  resourceUrl: string;
  now?: number;
  permit2Nonce?: bigint;
  eip3009Nonce?: string;
  /** Payer address — the smart-account wallet. Carried so the b402 envelope's `from` is set. */
  payerAddress: Address;
};

/**
 * The result of a sign operation.
 *
 * `header` is the base64 envelope to attach to both `X-PAYMENT` and
 * `PAYMENT-SIGNATURE`. `payload` is the decoded payload the SDK
 * produced — kept so the request layer can re-classify a 4xx retry
 * (see `maybeRethrowAsEoaOnly`). `envelope` is the full b402
 * envelope, for tests and for callers that want the decoded shape.
 */
export type SignForRequirementResult = {
  header: string;
  payload: X402PaymentPayload;
  envelope: B402Envelope;
};

/**
 * Sign the requirement via the session key.
 *
 * Steps:
 *  1. Project the typed `X402Requirement` into the SDK's requirement
 *     shape. The SDK's `extra.assetTransferMethod` is the rail
 *     selector on real b402; we set it from our typed `rail`.
 *  2. Call `signX402Payment` with the time/randomness overrides.
 *  3. Re-encode the envelope in the b402 dialect via `encodeB402Envelope`.
 *
 * Returns `{ header, payload, envelope }`. Throws on SDK failure —
 * the caller decides whether that is an EOA-only-facilitator case
 * (a known textual pattern in the SDK's error) or a real signing
 * failure.
 */
export async function signX402PaymentFor(
  input: SignForRequirementInput,
): Promise<SignForRequirementResult> {
  const sdkRequirement = toSdkRequirement(input.requirement);

  const signOptions: SignX402Options = {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.permit2Nonce !== undefined
      ? { permit2Nonce: input.permit2Nonce }
      : {}),
    ...(input.eip3009Nonce !== undefined
      ? { eip3009Nonce: input.eip3009Nonce as `0x${string}` }
      : {}),
  };

  const { header: sdkHeader, payload } = await signX402Payment(
    input.session,
    sdkRequirement,
    signOptions,
  );

  // The SDK produced a header from its own shape, but we want the b402
  // dialect envelope — both `permit + from` and
  // `permit2Authorization` with nested `from`, the `from` field, and
  // the resource normalization. We re-encode here.
  const envelope = encodeB402Envelope(
    {
      signedPayload: payload,
      requirement: input.requirement,
      resourceUrl: input.resourceUrl,
    },
    input.payerAddress,
  );

  // Touch sdkHeader so the noUnusedLocals / noUnusedParameters
  // lints don't complain — the SDK's encoding is the baseline we
  // proved with, even though we re-encode for the b402 dialect.
  void sdkHeader;

  return { header: envelope.header, payload, envelope };
}

/**
 * Project the typed `X402Requirement` into the SDK's `X402Requirement`
 * shape.
 *
 * The two are not identical: the typed version is the strict subset
 * this package deals in (`scheme`, `rail`, `chainId`, …), and the SDK
 * version is the wire shape (`extra.assetTransferMethod`,
 * `extra.spenderAddress`, …). The bridge is one-way: the SDK accepts
 * the typed shape's fields plus an `extra` object whose keys are
 * rail-specific.
 *
 * The `resource` field is normalized to a bare URL string, matching
 * the SDK's preferred input shape. `extra.name` and `extra.version`
 * are only required for the eip3009 rail (the token's EIP-712
 * domain), and we leave them as the typed value carried them.
 */
function toSdkRequirement(
  requirement: X402Requirement,
): Parameters<typeof signX402Payment>[1] {
  const method = requirement.rail === "permit2" ? "permit2-exact" : "eip3009";
  return {
    scheme: "exact",
    network:
      requirement.network && requirement.network.length > 0
        ? requirement.network
        : `eip155:${requirement.chainId}`,
    asset: requirement.asset,
    maxAmountRequired: requirement.maxAmountRequired.toString(),
    payTo: requirement.payTo,
    resource: requirement.resource,
    mimeType: requirement.mimeType,
    extra: {
      ...(requirement.extra?.name !== null &&
      requirement.extra?.name !== undefined
        ? { name: requirement.extra.name }
        : {}),
      ...(requirement.extra?.version !== null &&
      requirement.extra?.version !== undefined
        ? { version: requirement.extra.version }
        : {}),
      assetTransferMethod: method,
      ...(requirement.rail === "permit2"
        ? { spenderAddress: requirement.payTo }
        : {}),
    },
  };
}
