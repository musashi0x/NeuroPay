/**
 * Envelope parsing (5.5).
 *
 * Accept either header (`X-PAYMENT` or `PAYMENT-SIGNATURE`) and either
 * Permit2 dialect: the seller supports b402's two sibling shapes, which
 * have the same witness binding but differ in which key carries the
 * payload.
 *
 * `X-PAYMENT` and `PAYMENT-SIGNATURE` carry the same base64url-encoded
 * JSON envelope — the b402 dialect puts the envelope next to `permit`
 * and `from`, while the older Coinbase dialect wraps it under
 * `permit2Authorization`. The verifier calls `isValidSignature` against
 * either, so the parser here normalizes both to a single shape the
 * rest of the seller can deal with.
 */

import { Buffer } from "node:buffer";

import type { Address, Hex, X402PaymentRequired } from "@neuro-pay/types";

/** The header names we accept (case-insensitive at the HTTP layer). */
export const HEADER_NAMES = ["x-payment", "payment-signature"] as const;

export type EnvelopeHeader = (typeof HEADER_NAMES)[number];

/**
 * A base64url-encoded string. We don't decode in here; the verifier does,
 * so a malformed envelope is rejected at the parsing layer with a
 * distinct error from "valid base64 but wrong signature".
 */
export type Base64Url = string;

/**
 * The shape of the b402 sibling-shape authorization.
 *
 * Nested alongside `permit` and `from`, this is the canonical b402 dialect.
 */
export type Permit2Authorization = {
  /** The smart-account / EOA paying for the segment. */
  from: Address;
  /** Permit2 authorization payload — typed-data hash + witness + signature. */
  permit: {
    /** The hash the buyer signed (EIP-712 digest). */
    hash: Hex;
    /** The witness payload bound to the permit (carries payTo + amount). */
    witness: unknown;
    /** The signature bytes (98-byte ERC-1271 envelope on a smart account). */
    signature: Hex;
  };
  /** Optional sibling Permit2Authorization (newer b402 dialects). */
  permit2Authorization?: unknown;
};

/**
 * The normalized envelope shape the verifier consumes. Carries the raw
 * header bytes (so the verifier can hand them straight to `isValidSignature`)
 * along with the parsed fields.
 */
export type ParsedEnvelope = {
  /** Which header this envelope arrived on. */
  header: EnvelopeHeader;
  /** The raw envelope, base64url-encoded. */
  payload: Base64Url;
  /** Decoded JSON of the envelope. */
  decoded: Permit2Authorization;
  /** The payer's smart-account / EOA `from` address. */
  from: Address;
  /** Authorization nonce; the idempotency key the buyer is committing to. */
  nonce: string | null;
  /** Bound witness (used to verify payTo + amount match). */
  witness: unknown;
  /** Signature bytes as hex. */
  signature: Hex;
};

export type ParseEnvelopeError =
  | { kind: "missing" }
  | { kind: "multiple" }
  | { kind: "malformed-base64"; cause: string }
  | { kind: "malformed-json"; cause: string }
  | { kind: "missing-from"; cause: string }
  | { kind: "missing-permit"; cause: string }
  | { kind: "missing-signature"; cause: string };

export type ParseEnvelopeResult =
  | { kind: "ok"; envelope: ParsedEnvelope }
  | { kind: "err"; error: ParseEnvelopeError };

export type ExtractEnvelopeResult =
  | { kind: "missing" }
  | { kind: "ok"; payload: Base64Url; header: EnvelopeHeader }
  | { kind: "multiple"; headers: EnvelopeHeader[] };

/**
 * Read the envelope from a Hono-style header bag. Tries `X-PAYMENT` first,
 * then `PAYMENT-SIGNATURE`; returns `multiple` only when both carry
 * non-empty values (a buyer picking both is an error).
 */
export function extractEnvelope(headers: {
  get(name: string): string | null;
}): ExtractEnvelopeResult {
  const candidates: { payload: Base64Url; header: EnvelopeHeader }[] = [];
  for (const name of HEADER_NAMES) {
    const value = headers.get(name);
    if (value && value.length > 0) {
      candidates.push({
        payload: value,
        header: name as EnvelopeHeader,
      });
    }
  }
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length > 1) {
    return { kind: "multiple", headers: candidates.map((c) => c.header) };
  }
  const only = candidates[0]!;
  return { kind: "ok", payload: only.payload, header: only.header };
}

/**
 * The combined parse-and-classify entry point. Used by the route layer:
 * returns a `ParseEnvelopeResult` and never throws on shape problems.
 */
export function parseEnvelopeFromHeaders(headers: {
  get(name: string): string | null;
}): ParseEnvelopeResult {
  const picked = extractEnvelope(headers);
  if (picked.kind === "missing") {
    return { kind: "err", error: { kind: "missing" } };
  }
  if (picked.kind === "multiple") {
    return { kind: "err", error: { kind: "multiple" } };
  }
  return parseEnvelope(picked.payload, picked.header);
}

/**
 * Parse a base64url envelope payload. Tolerates both Permit2 dialects by
 * accepting `permit` OR `permit2Authorization` as the carrier of the
 * inner authorization.
 */
export function parseEnvelope(
  payload: Base64Url,
  header: EnvelopeHeader,
): ParseEnvelopeResult {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64url");
  } catch (cause) {
    return {
      kind: "err",
      error: {
        kind: "malformed-base64",
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
  if (bytes.length === 0 && payload.length > 0) {
    return {
      kind: "err",
      error: { kind: "malformed-base64", cause: "empty payload after decode" },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    return {
      kind: "err",
      error: {
        kind: "malformed-json",
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
  if (!isObject(raw)) {
    return {
      kind: "err",
      error: { kind: "missing-from", cause: "envelope is not a JSON object" },
    };
  }

  // Prefer the canonical `permit` + sibling `from` (newer b402); fall
  // back to `permit2Authorization` (older dialects).
  const from =
    readAddress(raw, "from") ?? readAddress(raw, "permit2Authorization.from");
  const permit =
    readObject(raw, "permit") ??
    readObject(raw, "permit2Authorization.permit") ??
    readObject(raw, "permit2Authorization");

  if (!from) {
    return {
      kind: "err",
      error: { kind: "missing-from", cause: "envelope had no `from` field" },
    };
  }
  if (!permit) {
    return {
      kind: "err",
      error: {
        kind: "missing-permit",
        cause: "envelope had no `permit` or `permit2Authorization` field",
      },
    };
  }
  const signature = readHex(permit, "signature");
  if (!signature) {
    return {
      kind: "err",
      error: {
        kind: "missing-signature",
        cause: "permit.signature missing or not hex",
      },
    };
  }
  const hash = readHex(permit, "hash");
  const witness = permit.witness ?? null;

  const decoded: Permit2Authorization = {
    from,
    permit: {
      hash: hash ?? "0x",
      witness,
      signature,
    },
  };
  const nonce = readString(permit, "nonce") ?? readString(raw, "nonce");

  return {
    kind: "ok",
    envelope: {
      header,
      payload,
      decoded,
      from,
      nonce,
      witness,
      signature,
    },
  };
}

/**
 * Extract the witness's bound `payTo` and `amount` if the envelope is
 * a Permit2 witness transfer. Returns `null` if the envelope is not a
 * recognizable Permit2 envelope.
 */
export function readPermit2WitnessFields(witness: unknown): {
  payTo: Address | null;
  amount: SmallestUnits | null;
  token: Address | null;
  chainId: number | null;
  nonce: string | null;
  deadline: number | null;
} {
  const empty = {
    payTo: null,
    amount: null,
    token: null,
    chainId: null,
    nonce: null,
    deadline: null,
  };
  if (!isObject(witness)) return empty;
  const candidate: Record<string, unknown> = witness;
  const token =
    readAddress(candidate, "token") ?? readAddress(candidate, "asset");
  const payTo = readAddress(candidate, "payTo") ?? readAddress(candidate, "to");
  const amount =
    readBigint(candidate, "amount") ?? readBigint(candidate, "maxAmount");
  const chainId = readNumber(candidate, "chainId");
  const nonce = readString(candidate, "nonce");
  const deadline =
    readNumber(candidate, "deadline") ?? readNumber(candidate, "validUntil");
  return {
    payTo,
    amount,
    token,
    chainId,
    nonce,
    deadline,
  };
}

/**
 * Format `witness` as a structured log entry. Useful for troubleshooting
 * without dumping arbitrary user data.
 */
export function witnessSummary(input: {
  witness: unknown;
  payTo: Address;
  amount: SmallestUnits;
}): Record<string, unknown> {
  return {
    payTo: input.payTo,
    amount: input.amount.toString(10),
    witnessShape: input.witness === null ? "null" : typeof input.witness,
  };
}

/**
 * Convert a `402` requirement into a `paymentRequirements` field a buyer
 * expects back on the envelope. Specifically used by the verifier, which
 * signs over the requirements blob to bind the payment to this demand.
 */
export function paymentRequirementsField(
  required: X402PaymentRequired,
): string {
  // The buyer embeds the JSON-stringified requirement as the witness
  // payload; we return the canonical string so byte-equal requirements
  // hash to the same witness.
  return JSON.stringify(required);
}

// --- tiny parser helpers (kept local; never reach beyond this module)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(
  parent: Record<string, unknown>,
  dottedPath: string,
): Record<string, unknown> | null {
  const segments = dottedPath.split(".");
  let cursor: unknown = parent;
  for (const segment of segments) {
    if (!isObject(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return null;
  }
  return isObject(cursor) ? cursor : null;
}

function readString(
  parent: Record<string, unknown>,
  key: string,
): string | null {
  const value = parent[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(
  parent: Record<string, unknown>,
  key: string,
): number | null {
  const value = parent[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBigint(
  parent: Record<string, unknown>,
  key: string,
): SmallestUnits | null {
  const value = parent[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value) as SmallestUnits;
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value) as SmallestUnits;
  }
  return null;
}

function readAddress(
  parent: Record<string, unknown>,
  key: string,
): Address | null {
  const value = readPath(parent, key);
  if (typeof value !== "string") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value as Address;
}

/**
 * Traverse a dotted path through a JSON-like object. Used so callers can
 * write `readAddress(raw, "permit2Authorization.from")` consistently with
 * `readObject(raw, "permit2Authorization.permit")`.
 */
function readPath(
  parent: Record<string, unknown>,
  dottedPath: string,
): unknown {
  const segments = dottedPath.split(".");
  let cursor: unknown = parent;
  for (const segment of segments) {
    if (!isObject(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function readHex(parent: Record<string, unknown>, key: string): Hex | null {
  const value = parent[key];
  if (typeof value !== "string") return null;
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return null;
  if (value.length % 2 !== 0) return null;
  return value as Hex;
}

type SmallestUnits = import("@neuro-pay/types").SmallestUnits;
