/**
 * The write-time guard that keeps private key material out of the ledger.
 *
 * The ledger is the one artefact of this system that is meant to be durable,
 * exported, and read by humans. A session private key that lands in it is not
 * a logging bug that scrolls away — it is a spendable secret sitting in a file
 * that outlives the process. So the check runs on the write path, not only in
 * review, and rejects the entry rather than sanitising it: a caller that tried
 * to persist key material has a bug that silently redacting would hide.
 */

/**
 * Field of a ledger entry that is exempt from the 32-byte-hex heuristic.
 *
 * A settlement transaction hash is 32 bytes, so it is *structurally
 * indistinguishable* from a secp256k1 private key — the heuristic cannot tell
 * them apart and would reject every real settlement. The exemption is by field
 * name only, and `store.ts` separately requires the exempt field to be exactly
 * `0x` + 64 hex, so the hole is one field wide and shaped like a hash.
 */
export const KEY_MATERIAL_EXEMPT_FIELDS = ["transactionHash"] as const;

/**
 * A run of exactly 64 hex digits, optionally `0x`-prefixed, not embedded in a
 * longer hex run.
 *
 * 32 bytes is the size of a secp256k1 private key. The "not embedded" bounds
 * are what let real values through: a 20-byte address (40 digits) is too
 * short, and a 33- or 65-byte public key (66 or 130 digits) is too long, so
 * neither matches even though both are `0x` hex.
 */
const PRIVATE_KEY_SHAPE =
  /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

/**
 * A BIP-39-shaped mnemonic: 12, 15, 18, 21, or 24 lowercase words.
 *
 * A seed phrase reconstructs every key under it, so it is key material even
 * though it carries no hex at all.
 */
const MNEMONIC_SHAPE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;

/**
 * A field or JSON key that announces itself as a secret.
 *
 * Catches labelled key material whose *value* does not match either shape
 * above — a truncated key, a base64 key, a keystore fragment — which matters
 * most for the free-form `detail` field.
 *
 * Two patterns, intentionally separated:
 * 1. A label followed by `:` or `=` (a JSON key, a `key=…` fragment).
 * 2. A standalone bare label standing alone in prose (e.g. "Mnemonic
 *    provided for recovery"). The label alone is enough — the operator
 *    writing it was about to follow it with sensitive content.
 *
 * The standalone match is word-bounded and case-insensitive, and uses a
 * negative lookahead to skip substrings inside longer words (so a comment
 * containing "mnemonics" still trips, while "mnemotechnic" does not).
 */
const LABELLED_SECRET_ASSIGNED =
  /["']?(?:private[_-]?key|secret[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase|keystore)["']?\s*[:=]/i;
const LABELLED_SECRET_BARE =
  /\b(?:private[_-]?key|secret[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase|keystore)\b(?![-_a-z])/i;

/** Which heuristic a value tripped, for an error message a human can act on. */
export type KeyMaterialShape =
  | "private-key-hex"
  | "mnemonic"
  | "labelled-secret";

/**
 * Report which key-material heuristic `value` trips, or null if it trips none.
 *
 * Deliberately shape-based rather than value-based: there is no list of known
 * keys to compare against, and by the time there were it would be too late.
 */
export function detectKeyMaterial(value: string): KeyMaterialShape | null {
  if (LABELLED_SECRET_ASSIGNED.test(value)) return "labelled-secret";
  if (LABELLED_SECRET_BARE.test(value)) return "labelled-secret";
  if (PRIVATE_KEY_SHAPE.test(value)) return "private-key-hex";
  if (MNEMONIC_SHAPE.test(value)) return "mnemonic";
  return null;
}

/** Thrown when a write would have persisted something shaped like a secret. */
export class KeyMaterialRejectedError extends Error {
  constructor(
    readonly field: string,
    readonly shape: KeyMaterialShape,
  ) {
    super(
      `refusing to append ledger entry: field "${field}" looks like key material (${shape}). ` +
        `The ledger stores the session public key, never the private half.`,
    );
    this.name = "KeyMaterialRejectedError";
  }
}

/**
 * Throw if any non-exempt string field of `candidate` looks like key material.
 *
 * Walks the record's own string values only; the ledger entry shape is flat,
 * so there is no nesting to recurse into.
 */
export function assertNoKeyMaterial(candidate: Record<string, unknown>): void {
  const exempt = new Set<string>(KEY_MATERIAL_EXEMPT_FIELDS);

  for (const [field, value] of Object.entries(candidate)) {
    if (typeof value !== "string" || exempt.has(field)) continue;

    const shape = detectKeyMaterial(value);
    if (shape !== null) throw new KeyMaterialRejectedError(field, shape);
  }
}
