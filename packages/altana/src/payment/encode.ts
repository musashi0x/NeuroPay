/**
 * The b402 dialect envelope.
 *
 * The b402 wire shape is the same signature under two field names —
 * `permit + from` (the legacy / sample shape) and `permit2Authorization`
 * with `from` nested (the canonical b402 shape) — plus the envelope's
 * top-level `resource` field, which a b402 merchant echoes back from
 * the 402 body, normalized from the requirement, with a URL fallback
 * when the requirement omits it.
 *
 * ## Why both dialects
 *
 * Real b402 merchants have shipped against both field names. Real
 * CoinMarketCap answers "Unsupported x402 payload" without the
 * `permit2Authorization` field; some sample merchants answer
 * "payment header resource is null" without `permit`. Producing both
 * fields from one signature means the same envelope is accepted by
 * either dialect — exactly what the spec calls "no second code path".
 *
 * ## Why both headers
 *
 * Real b402 facilitators sometimes read `X-PAYMENT` and sometimes
 * `PAYMENT-SIGNATURE`. We send both with the same base64 payload so
 * either path picks it up.
 *
 * ## Why a non-65-byte signature
 *
 * The session key signature is the nested ERC-1271 envelope
 * (`innerSig ‖ keyHash ‖ prehash`), exactly 98 bytes. A bare 65-byte
 * EOA signature would decode to garbage via `ecrecover`, which is
 * exactly the failure mode the EOA-only-facilitator classification
 * exists to flag.
 */

import type { Address, X402Requirement } from "@neuro-pay/types";
import type { X402PaymentPayload } from "@altananetwork/sdk";
import { signX402Payment } from "@altananetwork/sdk";

/**
 * Inputs to `encodeB402Envelope`.
 *
 * `signedPayload` is the raw signed `X402PaymentPayload` the SDK
 * returned. `requirement` is the requirement that was signed; the
 * envelope mirrors it. `resourceUrl` is the URL fallback when the
 * requirement's own `resource` is empty.
 */
export type EncodeB402Input = {
  signedPayload: X402PaymentPayload;
  requirement: X402Requirement;
  resourceUrl: string;
};

/**
 * The b402 envelope.
 *
 * The payload, base64-encoded, is what `X-PAYMENT` and
 * `PAYMENT-SIGNATURE` carry. The decoded payload mirrors the
 * `X402PaymentPayload` with the b402 dialect fields populated:
 *
 *  - `payload.from` — the smart-account wallet (the "from").
 *  - `payload.permit` — same shape as `permit2Authorization` for legacy
 *    merchants that read it.
 *  - `payload.permit2Authorization.from` — nested `from` for canonical
 *    b402 readers.
 *  - `payload.payload.signature` — the nested ERC-1271 envelope.
 *
 * The function returns the decoded envelope plus its base64 wire
 * encoding. Tests assert on the decoded envelope; the request layer
 * attaches the base64 to both headers.
 */
export type B402Envelope = {
  /** The decoded payload — what a merchant's JSON parser sees. */
  decoded: X402PaymentPayload & {
    payload: {
      from: Address;
      permit: {
        from: Address;
        signature: string;
      };
      permit2Authorization: {
        from: Address;
        signature: string;
      };
      signature: string;
    };
    resource: { url: string; description?: string; mimeType?: string };
  };
  /** The base64 encoding — what `X-PAYMENT` / `PAYMENT-SIGNATURE` carry. */
  header: string;
};

/**
 * Encode the signed SDK payload into the b402 dialect envelope.
 *
 * Steps:
 *  1. Normalize `resource` to a non-null object form with `url`
 *     non-empty — required by b402 merchants, who reject an absent
 *     or empty resource with "payment header resource is null".
 *  2. Project the SDK's `payload` (which carries `signature` plus the
 *     typed-data fields the rail needs) into the b402 shape — both
 *     `permit + from` and `permit2Authorization` with nested `from`.
 *  3. Set `from` to the requirement's payTo — actually, to the
 *     smart-account wallet. Wait — that's wrong: `from` is the *payer*,
 *     not the recipient. The smart-account wallet is the payer.
 *     The wallet address comes from the input; the recipient is the
 *     requirement's `payTo`. We wire `from = walletAddress`.
 *  4. Re-base64 the JSON payload for the headers.
 *
 * The signature is propagated from the SDK payload unchanged — it's
 * already the nested ERC-1271 envelope by the time it reaches here.
 */
export function encodeB402Envelope(
  input: EncodeB402Input,
  payerAddress: Address,
): B402Envelope {
  const signature = extractSignature(input.signedPayload);
  const resource = pickResource(input.requirement, input.resourceUrl);

  const decoded: B402Envelope["decoded"] = {
    ...input.signedPayload,
    payload: {
      ...(input.signedPayload.payload as Record<string, unknown>),
      from: payerAddress,
      permit: {
        from: payerAddress,
        signature,
      },
      permit2Authorization: {
        from: payerAddress,
        signature,
      },
      signature,
    },
    resource,
  };

  // Re-base64 the JSON. The SDK already produced a base64 header;
  // we re-encode here because we have added fields the SDK did not
  // emit (the b402 dialect fields) and the headers must carry the
  // version of the payload that includes them.
  const header = base64JsonEncode(decoded);

  return { decoded, header };
}

/**
 * Extract the signature string from the SDK payload.
 *
 * The SDK puts the signature at `payload.payload.signature` (nested
 * one level) for both rails. We extract defensively so a future SDK
 * shape change does not silently break encoding — a missing
 * signature is a programmer error and gets a loud failure.
 */
function extractSignature(payload: X402PaymentPayload): string {
  const inner = payload.payload as Record<string, unknown>;
  const signature = inner["signature"];
  if (typeof signature !== "string" || signature.length === 0) {
    throw new Error(
      `encodeB402Envelope: signed payload is missing a signature; ` +
        `the SDK returned an envelope we cannot encode.`,
    );
  }
  return signature;
}

/**
 * Pick the resource field the envelope carries.
 *
 * The requirement's `resource` wins when it is a non-empty string;
 * otherwise the request URL is used. b402 merchants reject an empty
 * resource with "payment header resource is null", so the fallback
 * is non-negotiable.
 *
 * The output shape mirrors the SDK's `X402Resource`: `{ url,
 * description?, mimeType? }`. A bare URL becomes `{ url }`.
 */
function pickResource(
  requirement: X402Requirement,
  resourceUrl: string,
): { url: string; description?: string; mimeType?: string } {
  if (requirement.resource && requirement.resource.length > 0) {
    return { url: requirement.resource };
  }
  return { url: resourceUrl };
}

/**
 * Base64-encode a JSON payload using the same encoding the SDK
 * applies, so the wire form is stable across both producers.
 *
 * Re-implemented locally so we don't depend on the SDK's internal
 * `encodeXPaymentHeader` (which is an internal export and the test
 * file should not import internals).
 */
export function base64JsonEncode(value: unknown): string {
  const json = JSON.stringify(value);
  // Buffer is available in Node; we use it here rather than a global
  // btoa because the payload may contain unicode characters and btoa
  // requires Latin-1 input.
  return Buffer.from(json, "utf8").toString("base64");
}

/**
 * Decode a base64 envelope back to its JSON payload — used by tests
 * and by the seller-side parser. Symmetric to `base64JsonEncode`.
 */
export function base64JsonDecode<T>(encoded: string): T {
  const json = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(json) as T;
}

/**
 * Re-export `signX402Payment` so callers can import the entire
 * signing surface from `./sign.ts` without reaching into the SDK.
 */
export { signX402Payment };