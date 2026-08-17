/**
 * Byte-exact session codec.
 *
 * The Altana smart account matches a session against the exact
 * `permissions + expiry + publicKey` committed at grant time. A sloppy JSON
 * round-trip (bigint → number, reordered keys) silently breaks every
 * subsequent payment. We can't have that.
 *
 * The codec:
 *
 *  - Encodes every `bigint` with an explicit `{"$$bigint":"<decimal>"}` tag,
 *    so a JSON round-trip never loses precision.
 *  - Reorders every object's keys alphabetically before serialisation, so
 *    the byte output is independent of property insertion order.
 *  - On load, re-encodes the decoded value and compares against the stored
 *    blob. A mismatch is a hard failure, not a fallback.
 *
 * What the codec deliberately does NOT do:
 *
 *  - Accept a `number` and silently convert it. A 64-bit `bigint` that
 *    round-trips through `number` is the bug this codec exists to prevent.
 *  - Tolerate key reordering on load. The whole point of byte-exactness is
 *    that a corrupted or differently-encoded session fails loudly at load,
 *    not silently at the first payment.
 */

/** Internal marker used to distinguish a bigint from any other JSON value. */
const BIGINT_TAG = "$$bigint" as const;

/** A `bigint` encoded for JSON transport. */
export type EncodedBigint = { [BIGINT_TAG]: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEncodedBigint(value: unknown): value is EncodedBigint {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value[BIGINT_TAG] === "string"
  );
}

/**
 * Walk a value and rewrite it: every object gets its keys sorted; every
 * `bigint` becomes a tagged envelope; everything else passes through.
 *
 * Arrays preserve their order — the codec is stable on lists of
 * permissions, where reordering would silently change the on-chain
 * commitment.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { [BIGINT_TAG]: value.toString() } satisfies EncodedBigint;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** Raised when a session blob is corrupted or differently encoded. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

function decodeValue(value: unknown): unknown {
  if (isEncodedBigint(value)) {
    const raw = value[BIGINT_TAG];
    try {
      return BigInt(raw);
    } catch {
      throw new CodecError(`bigint tag is not a valid decimal: ${raw}`);
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeValue(entry));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = decodeValue(entry);
    }
    return out;
  }
  return value;
}

/**
 * Encode a session (or any value with the same constraints) to a
 * canonical UTF-8 string. Two structurally-equal values with different key
 * ordering produce identical output; bigints survive a round-trip.
 */
export function encode(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Decode a session blob into its runtime shape.
 *
 * Throws `CodecError` if the blob is not valid JSON or contains a
 * malformed bigint tag.
 */
export function decode(blob: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch (err) {
    throw new CodecError(
      `session blob is not valid JSON: ${(err as Error).message}`,
    );
  }
  return decodeValue(parsed);
}

/**
 * Load a session from its canonical blob, verifying that re-encoding the
 * decoded value produces the same bytes.
 *
 * This is the load-time hard-fail. A blob whose decoded form has had a
 * field added, removed, reordered, or had a bigint silently coerced to a
 * number will not re-encode identically, and that mismatch is a fatal
 * `CodecError` rather than a soft warning.
 *
 * Callers are expected to let the error propagate and kill the process —
 * using a session whose on-chain commitment is unknown is worse than
 * refusing to start.
 */
export function decodeAndVerify<T>(blob: string): T {
  const decoded = decode(blob) as T;
  const reencoded = encode(decoded);
  if (reencoded !== blob) {
    throw new CodecError(
      "session blob failed byte-exact verification: re-encoding the " +
        "decoded value does not match the stored blob. The session record " +
        "has been corrupted or was written by a different encoder; refusing " +
        "to sign against it.",
    );
  }
  return decoded;
}
