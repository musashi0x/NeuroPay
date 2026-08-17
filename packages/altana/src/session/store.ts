/**
 * Persistent store for the local half of a session.
 *
 * The store is keyed by the smart-account wallet address. One wallet ⇒ one
 * active session (a second grant overwrites the first — the on-chain cap
 * does not stack).
 *
 * What the store writes:
 *
 *  - Every public field of `PersistedSession` goes through the byte-exact
 *    codec, so a load-time re-encode-and-compare catches any drift.
 *
 * What the store deliberately does NOT write:
 *
 *  - The signer, in any form. The store exposes a `signerFor` lookup that
 *    is satisfied by an injected signer source; in production that source
 *    holds the signer in process memory only, generated at grant time.
 *  - Anything that even smells like a private key — no `_privateKey`
 *    property, no derivation, no fallback. A persisted session is
 *    revocation-only; the private half must be re-derived from whatever
 *    generated it (today: an in-memory map; later: a keychain handle).
 *
 * File-based persistence is opt-in via `fileStorePath`. Without it the
 * store is in-memory, which is what unit tests and the operator script's
 * single-process use want.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "@neuro-pay/types";
import { CodecError, decodeAndVerify, encode } from "./codec.js";
import type { PersistedSession } from "./persisted.js";

/** Raised on store-level violations (missing session, bad input). */
export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreError";
  }
}

/**
 * Source of the in-memory session signer.
 *
 * Production: holds the signer generated at `grantSession` time, so the
 * payment client can sign without a re-prompt. Tests: return any
 * `signer`-shaped object — the store never inspects its fields.
 */
export type SignerSource = (walletAddress: Address) => unknown;

/** No-op signer source — every lookup returns `undefined`. */
export const NO_SIGNER_SOURCE: SignerSource = () => undefined;

export type SessionStoreOptions = {
  /** File to persist the store to. Omit for an in-memory store. */
  fileStorePath?: string;
  /**
   * Source for the in-memory signer. Omit to disable payment-time
   * signing — every revocation / authority check still works.
   */
  signerSource?: SignerSource;
};

/** A snapshot of what's currently persisted, with the live signer if any. */
export type ResolvedSession = {
  persisted: PersistedSession;
  /** Live signer from `signerSource`, or `undefined` if not registered. */
  signer: unknown;
};

export class SessionStore {
  readonly #fileStorePath: string | undefined;
  readonly #signerSource: SignerSource;
  /**
   * In-memory cache of the persisted sessions, keyed by wallet address.
   * Mirrors disk when a `fileStorePath` is set; the source of truth in
   * memory either way.
   */
  readonly #byWallet: Map<Address, PersistedSession> = new Map();

  constructor(options: SessionStoreOptions = {}) {
    this.#fileStorePath = options.fileStorePath;
    this.#signerSource = options.signerSource ?? NO_SIGNER_SOURCE;
    if (this.#fileStorePath !== undefined) {
      this.#loadFromDisk();
    }
  }

  /** Where the store writes its blob. `undefined` when in-memory only. */
  get fileStorePath(): string | undefined {
    return this.#fileStorePath;
  }

  /**
   * Save a session.
   *
   * On a `fileStorePath`-backed store, the on-disk blob is the canonical
   * form: the encoded blob is re-decoded and re-encoded byte-exact before
   * being flushed, so a load round-trip is verified at write time too.
   */
  save(persisted: PersistedSession): void {
    this.#byWallet.set(persisted.walletAddress, persisted);
    if (this.#fileStorePath !== undefined) {
      this.#flushToDisk();
    }
  }

  /**
   * Read a session by wallet address.
   *
   * Returns `undefined` if there is no record. Never throws for "not found"
   * — only for corruption.
   */
  read(walletAddress: Address): PersistedSession | undefined {
    return this.#byWallet.get(walletAddress);
  }

  /**
   * Read a session with its live signer attached.
   *
   * The signer side comes from `signerSource`; the persisted side comes
   * from the store. Throws if there is no persisted record — callers that
   * need the unprovisioned case should `read()` first.
   */
  resolve(walletAddress: Address): ResolvedSession {
    const persisted = this.read(walletAddress);
    if (persisted === undefined) {
      throw new SessionStoreError(
        `no persisted session for wallet ${walletAddress}`,
      );
    }
    return { persisted, signer: this.#signerSource(walletAddress) };
  }

  /**
   * Remove a session from the store.
   *
   * Idempotent — returns `true` if a record was removed, `false` if there
   * was nothing to remove. This is the first stage of a two-stage
   * revocation: removing locally stops signing in milliseconds, ahead of
   * the on-chain `revokeSession` confirmation.
   */
  remove(walletAddress: Address): boolean {
    const had = this.#byWallet.delete(walletAddress);
    if (had && this.#fileStorePath !== undefined) {
      this.#flushToDisk();
    }
    return had;
  }

  /**
   * Mark a session's rail as provisioned.
   *
   * The rail record is part of the persisted session — the payment client
   * asserts `railProvisioned === true` before any signing, so this flag
   * has to be durable, not just in-memory.
   */
  markRailProvisioned(walletAddress: Address): void {
    const existing = this.#byWallet.get(walletAddress);
    if (existing === undefined) {
      throw new SessionStoreError(
        `cannot mark rail provisioned: no session for wallet ${walletAddress}`,
      );
    }
    const next: PersistedSession = { ...existing, railProvisioned: true };
    this.#byWallet.set(walletAddress, next);
    if (this.#fileStorePath !== undefined) {
      this.#flushToDisk();
    }
  }

  /**
   * Record a `grantTransactionHash` after the relay confirms.
   *
   * A grant's `transactionHash` may arrive after the SDK has already
   * returned a `Session`, so the operator script wires it through this
   * setter. Setting the same value twice is a no-op.
   */
  setGrantTransactionHash(
    walletAddress: Address,
    grantTransactionHash: string,
  ): void {
    const existing = this.#byWallet.get(walletAddress);
    if (existing === undefined) {
      throw new SessionStoreError(
        `cannot record grant hash: no session for wallet ${walletAddress}`,
      );
    }
    const next: PersistedSession = {
      ...existing,
      grantTransactionHash:
        grantTransactionHash as PersistedSession["grantTransactionHash"],
    };
    this.#byWallet.set(walletAddress, next);
    if (this.#fileStorePath !== undefined) {
      this.#flushToDisk();
    }
  }

  /** The wallet addresses currently in the store. Diagnostic. */
  list(): Address[] {
    return [...this.#byWallet.keys()];
  }

  #flushToDisk(): void {
    if (this.#fileStorePath === undefined) return;
    const path = this.#fileStorePath;
    const snapshot: Record<Address, PersistedSession> = Object.fromEntries(
      this.#byWallet,
    );
    const blob = encode(snapshot);
    // Round-trip the blob we just wrote. A drift here means the encoder
    // changed shape since this snapshot was assembled; we'd rather fail
    // a write than leave the disk in a state that fails on load.
    decodeAndVerify(blob);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blob, { encoding: "utf8" });
  }

  #loadFromDisk(): void {
    const path = this.#fileStorePath;
    if (path === undefined || !existsSync(path)) return;
    let blob: string;
    try {
      blob = readFileSync(path, { encoding: "utf8" });
    } catch (err) {
      throw new SessionStoreError(
        `cannot read session store at ${path}: ${(err as Error).message}`,
      );
    }
    let parsed: Record<Address, PersistedSession>;
    try {
      parsed = decodeAndVerify<Record<Address, PersistedSession>>(blob);
    } catch (err) {
      if (err instanceof CodecError) {
        throw new SessionStoreError(
          `session store at ${path} failed byte-exact verification: ` +
            `${err.message}. Refusing to load — the store has been corrupted ` +
            `or was written by a different encoder.`,
        );
      }
      throw err;
    }
    for (const [walletAddress, persisted] of Object.entries(parsed)) {
      this.#byWallet.set(walletAddress as Address, persisted);
    }
  }
}
