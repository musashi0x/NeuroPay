/**
 * Envelope parsing (5.5).
 *
 * Accept either header (`X-PAYMENT` or `PAYMENT-SIGNATURE`) and normalize
 * the b402 payload into one typed Permit2 authorization the rest of the
 * seller can deal with.
 *
 * ## The wire shape this parses
 *
 * `@altananetwork/sdk`'s `signX402Payment` (permit2-exact rail) base64s
 * this JSON into both headers:
 *
 * ```jsonc
 * {
 *   "x402Version": 1, "scheme": "exact", "network": "eip155:97",
 *   "accepted": { … }, "resource": { "url": "…" },
 *   "payload": {
 *     "signature": "0x…",       // 98-byte nested ERC-1271 envelope
 *     "from": "0x…",            // the payer
 *     "permit": {
 *       "permitted": { "token": "0x…", "amount": "1000" },
 *       "spender": "0x…",       // must equal msg.sender at settle time
 *       "nonce": "…", "deadline": "…",
 *       "witness": { "to": "0x…", "validAfter": "0" }
 *     },
 *     "permit2Authorization": { …same, plus "from" }
 *   }
 * }
 * ```
 *
 * Three things are conspicuously absent and drive the design here:
 *
 *  - **No EIP-712 digest.** The buyer never transmits the hash it signed,
 *    so the verifier recomputes it (see `verify.ts`). This parser does not
 *    read, and must never read, a wire-supplied `hash`.
 *  - **No `chainId`.** The chain is bound implicitly through the EIP-712
 *    domain the signature covers, so it cannot be compared as a field.
 *  - **No flat witness.** `token` and `amount` live under
 *    `permit.permitted`, and the recipient is `witness.to`.
 *
 * The `payload.*` nesting is canonical; the same keys are also accepted at
 * the envelope root so a non-SDK buyer that flattens them still parses.
 */

import { Buffer } from "node:buffer";

import type {
  Address,
  Hex,
  SmallestUnits,
  X402PaymentRequired,
} from "@neuro-pay/types";

/** The header names we accept (case-insensitive at the HTTP layer). */
export const HEADER_NAMES = ["x-payment", "payment-signature"] as const;

export type EnvelopeHeader = (typeof HEADER_NAMES)[number];

/**
 * A base64 (or base64url) encoded string. Node decodes either alphabet
 * with the same call, so the two dialects need no branch here.
 */
export type Base64Url = string;

/**
 * The B402 witness struct: `Witness(address to,uint256 validAfter)`, taken
 * verbatim from the x402ExactPermit2Proxy's bytecode. `validAfter` stays a
 * decimal string because it is a uint256 on the wire and is re-encoded as
 * one when the settler hashes the struct.
 */
export type Permit2Witness = {
  to: Address;
  validAfter: string;
};

/**
 * The Permit2 `PermitWitnessTransferFrom` struct the buyer signed.
 *
 * Every field is an input to `Permit2.permitWitnessTransferFrom`, which
 * recomputes the signed digest from exactly these values and checks it
 * against the signature. None of them can be dropped, defaulted, or
 * fabricated downstream.
 */
export type Permit2Permit = {
  permitted: { token: Address; amount: SmallestUnits };
  /** The address that will call `permitWitnessTransferFrom` — the settler EOA. */
  spender: Address;
  /** uint256 nonce, decimal string. Doubles as the seller's idempotency key. */
  nonce: string;
  /** Unix seconds after which the authorization is dead. */
  deadline: number;
  witness: Permit2Witness | null;
};

/**
 * The normalized envelope the verifier consumes. Carries the raw header
 * bytes alongside the parsed authorization.
 */
export type ParsedEnvelope = {
  /** Which header this envelope arrived on. */
  header: EnvelopeHeader;
  /** The raw envelope, base64-encoded. */
  payload: Base64Url;
  /** The whole decoded JSON, kept for logging and for `accepted` echo checks. */
  raw: Record<string, unknown>;
  /** The payer's smart-account `from` address. */
  from: Address;
  /** Authorization nonce; the idempotency key the buyer is committing to. */
  nonce: string;
  /** The full signed Permit2 struct. */
  permit: Permit2Permit;
  /** Signature bytes as hex — the 98-byte nested ERC-1271 envelope. */
  signature: Hex;
};

export type ParseEnvelopeError =
  | { kind: "missing" }
  | { kind: "multiple" }
  | { kind: "malformed-base64"; cause: string }
  | { kind: "malformed-json"; cause: string }
  | { kind: "missing-from"; cause: string }
  | { kind: "missing-permit"; cause: string }
  | { kind: "malformed-permit"; cause: string }
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
 * then `PAYMENT-SIGNATURE`.
 *
 * A compliant b402 buyer sends both headers carrying the identical
 * base64url payload (see the module docstring) for facilitator
 * compatibility — that is not an ambiguity, and picks `X-PAYMENT` as the
 * canonical header. `multiple` is reserved for headers that disagree:
 * two different payloads is a real ambiguity the parser cannot resolve.
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
  const distinctPayloads = new Set(candidates.map((c) => c.payload));
  if (distinctPayloads.size > 1) {
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
 * Parse a base64 envelope payload into the normalized authorization.
 *
 * Looks under `payload.*` first (where the SDK puts everything), then at
 * the envelope root, then under `permit2Authorization` — in each case
 * accepting `permit` or `permit2Authorization` as the carrier, since the
 * SDK emits both with identical contents.
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

  // The SDK's inner payload. Absent only for a buyer that flattened the
  // envelope, in which case the root doubles as the inner object.
  const inner = readObject(raw, "payload") ?? raw;

  const from =
    readAddress(inner, "from") ??
    readAddress(inner, "permit2Authorization.from") ??
    readAddress(inner, "permit.from") ??
    readAddress(raw, "from");
  if (!from) {
    return {
      kind: "err",
      error: {
        kind: "missing-from",
        cause: "envelope had no `payload.from` or `from` field",
      },
    };
  }

  const permitObject =
    readObject(inner, "permit") ?? readObject(inner, "permit2Authorization");
  if (!permitObject) {
    return {
      kind: "err",
      error: {
        kind: "missing-permit",
        cause: "envelope had no `permit` or `permit2Authorization` object",
      },
    };
  }

  // The SDK puts the signature next to the permit, not inside it; a
  // merged b402 envelope carries it in both places. Either is accepted.
  const signature =
    readHex(inner, "signature") ?? readHex(permitObject, "signature");
  if (!signature) {
    return {
      kind: "err",
      error: {
        kind: "missing-signature",
        cause: "envelope had no hex `signature`",
      },
    };
  }

  const permit = readPermit(permitObject);
  if (permit.kind === "err") {
    return { kind: "err", error: permit.error };
  }

  return {
    kind: "ok",
    envelope: {
      header,
      payload,
      raw,
      from,
      nonce: permit.value.nonce,
      permit: permit.value,
      signature,
    },
  };
}

/**
 * Read the Permit2 struct out of the wire object.
 *
 * Every field is required except `witness`: the legacy plain-`permit2`
 * rail signs a bare `PermitTransferFrom` with no witness at all, and
 * that shape is still parseable even though this seller only quotes
 * `permit2-exact`. The verifier is what refuses a witness-less permit,
 * so the classification lands as a verification failure rather than a
 * parse failure.
 */
function readPermit(
  source: Record<string, unknown>,
):
  | { kind: "ok"; value: Permit2Permit }
  | { kind: "err"; error: ParseEnvelopeError } {
  const permitted = readObject(source, "permitted");
  const token = permitted ? readAddress(permitted, "token") : null;
  const amount = permitted ? readBigint(permitted, "amount") : null;
  if (!permitted || !token || amount === null) {
    return {
      kind: "err",
      error: {
        kind: "malformed-permit",
        cause: "permit.permitted missing a token/amount pair",
      },
    };
  }

  const spender = readAddress(source, "spender");
  if (!spender) {
    return {
      kind: "err",
      error: {
        kind: "malformed-permit",
        cause: "permit.spender missing or not an address",
      },
    };
  }

  const nonce = readUint256String(source, "nonce");
  if (nonce === null) {
    return {
      kind: "err",
      error: {
        kind: "malformed-permit",
        cause: "permit.nonce missing or not a uint256",
      },
    };
  }

  const deadline = readUnixSeconds(source, "deadline");
  if (deadline === null) {
    return {
      kind: "err",
      error: {
        kind: "malformed-permit",
        cause: "permit.deadline missing or not a Unix-seconds integer",
      },
    };
  }

  return {
    kind: "ok",
    value: {
      permitted: { token, amount },
      spender,
      nonce,
      deadline,
      witness: readWitness(source),
    },
  };
}

/**
 * Read the `Witness(address to,uint256 validAfter)` struct. Returns
 * `null` when the permit carries no witness (the non-exact rail) or
 * when the witness is present but unreadable — the verifier treats both
 * the same way, since neither can produce a matching digest.
 */
function readWitness(source: Record<string, unknown>): Permit2Witness | null {
  const witness = readObject(source, "witness");
  if (!witness) return null;
  const to = readAddress(witness, "to");
  if (!to) return null;
  const validAfter = readUint256String(witness, "validAfter") ?? "0";
  return { to, validAfter };
}

/**
 * The buyer's bindings, read from where the real wire actually puts
 * them: token and amount under `permit.permitted`, recipient under
 * `witness.to`.
 *
 * Deliberately no `chainId` — it is never transmitted. The chain is
 * bound through the EIP-712 domain the signature covers, so a
 * wrong-chain payment is caught by the recomputed-digest check in
 * `verify.ts`, not by comparing a field here.
 */
export function permitBindings(permit: Permit2Permit): {
  payTo: Address | null;
  amount: SmallestUnits;
  token: Address;
  nonce: string;
  deadline: number;
} {
  return {
    payTo: permit.witness?.to ?? null,
    amount: permit.permitted.amount,
    token: permit.permitted.token,
    nonce: permit.nonce,
    deadline: permit.deadline,
  };
}

/**
 * Format a permit as a structured log entry. Useful for troubleshooting
 * without dumping arbitrary user data.
 */
export function permitSummary(permit: Permit2Permit): Record<string, unknown> {
  return {
    token: permit.permitted.token,
    amount: permit.permitted.amount.toString(10),
    spender: permit.spender,
    nonce: permit.nonce,
    deadline: permit.deadline,
    payTo: permit.witness?.to ?? null,
    hasWitness: permit.witness !== null,
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
  return JSON.stringify(required, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString(10) : value,
  );
}

// --- tiny parser helpers (kept local; never reach beyond this module)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(
  parent: Record<string, unknown>,
  dottedPath: string,
): Record<string, unknown> | null {
  const cursor = readPath(parent, dottedPath);
  return isObject(cursor) ? cursor : null;
}

/**
 * Read a uint256 that travels as a decimal or `0x` string. Returns the
 * canonical decimal form so two spellings of the same nonce are one
 * idempotency key.
 */
function readUint256String(
  parent: Record<string, unknown>,
  key: string,
): string | null {
  const value = parent[key];
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString(10);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = BigInt(value);
    return parsed < 0n ? null : parsed.toString(10);
  } catch {
    return null;
  }
}

/**
 * Read a Unix-seconds timestamp that travels as a uint256 string.
 * Rejects values past `Number.MAX_SAFE_INTEGER`, which would lose
 * precision the moment they were compared against a clock.
 */
function readUnixSeconds(
  parent: Record<string, unknown>,
  key: string,
): number | null {
  const asString = readUint256String(parent, key);
  if (asString === null) return null;
  const asBigint = BigInt(asString);
  if (asBigint > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(asBigint);
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
