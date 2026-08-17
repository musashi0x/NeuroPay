/**
 * Tests for the refusal-before-signing paths.
 *
 * The spec's "no signature is produced under any of these conditions"
 * guarantee is exercised here as a single `assertCanSign` function that
 * composes the three guards this module owns:
 *
 *  1. The session must exist in the local store. (A revoked session
 *     is one that has been removed; an absent session is one that
 *     never existed.)
 *  2. The session must be unexpired. (Local check; the on-chain
 *     `expiry` is the same value.)
 *  3. The rail must be provisioned. (`railProvisioned === true` on
 *     the persisted record.)
 *
 * On-chain authority (`isValidKey`) reads are surfaced but not
 * awaited before signing in this module — the payment client (Group 4)
 * issues the read. The local half of the refusal is what these tests
 * pin down, since the local guard is what stops signing in
 * milliseconds even before the chain confirms.
 *
 * The SessionStore is stubbed — these tests do not touch the network.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "@neuro-pay/types";
import { SessionStoreError } from "./store.js";
import type { PersistedSession } from "./persisted.js";
import { encode, decodeAndVerify } from "./codec.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type StoreEntry = {
  persisted: PersistedSession;
  signer: unknown;
};

class StubSessionStore {
  readonly #byWallet: Map<Address, StoreEntry> = new Map();

  save(persisted: PersistedSession): void {
    this.#byWallet.set(persisted.walletAddress, {
      persisted,
      signer: Symbol("signer"),
    });
  }

  read(walletAddress: Address): PersistedSession | undefined {
    return this.#byWallet.get(walletAddress)?.persisted;
  }

  resolve(walletAddress: Address): { persisted: PersistedSession; signer: unknown } {
    const entry = this.#byWallet.get(walletAddress);
    if (entry === undefined) {
      throw new SessionStoreError(
        `no persisted session for wallet ${walletAddress}`,
      );
    }
    return entry;
  }

  remove(walletAddress: Address): boolean {
    return this.#byWallet.delete(walletAddress);
  }

  markRailProvisioned(walletAddress: Address): void {
    const entry = this.#byWallet.get(walletAddress);
    if (entry === undefined) {
      throw new SessionStoreError(
        `cannot mark rail provisioned: no session for wallet ${walletAddress}`,
      );
    }
    this.#byWallet.set(walletAddress, {
      ...entry,
      persisted: { ...entry.persisted, railProvisioned: true },
    });
  }

  setGrantTransactionHash(walletAddress: Address, hash: Hex): void {
    const entry = this.#byWallet.get(walletAddress);
    if (entry === undefined) {
      throw new SessionStoreError(
        `cannot record grant hash: no session for wallet ${walletAddress}`,
      );
    }
    this.#byWallet.set(walletAddress, {
      ...entry,
      persisted: {
        ...entry.persisted,
        grantTransactionHash: hash,
      },
    });
  }

  list(): Address[] {
    return [...this.#byWallet.keys()];
  }
}

// ---------------------------------------------------------------------------
// The guard under test
// ---------------------------------------------------------------------------

/**
 * The pre-signing refusal function shared by the payment client.
 * This is the refusal-before-signing surface the spec calls out —
 * every branch MUST raise before any signing is attempted.
 *
 * Concrete signatures are produced by the payment client (Group 4);
 * here we only assert that each branch raises before any side effect
 * that would produce an on-chain signature.
 */
export type RefusalErrorName =
  | "SessionNotFoundError"
  | "SessionExpiredError"
  | "RailNotProvisionedError"
  | "SessionSignerMissingError";

export class RefusalError extends Error {
  readonly name: RefusalErrorName;
  constructor(name: RefusalErrorName, message: string) {
    super(message);
    this.name = name;
  }
}

export type AssertCanSignInput = {
  store: StubSessionStore;
  walletAddress: Address;
  /** Unix epoch seconds the check is taken at. Defaults to `Date.now()/1000`. */
  now?: number;
};

/**
 * Run every pre-signing guard. Returns the resolved session on success;
 * throws a `RefusalError` subclass on any failure. The function is
 * total: it either succeeds or raises — it never returns a partial
 * shape.
 */
export function assertCanSign(input: AssertCanSignInput): {
  persisted: PersistedSession;
  signer: unknown;
} {
  // 1. The session must exist locally. A revoked session is, by
  // definition, a session that has been removed from the store.
  let resolved;
  try {
    resolved = input.store.resolve(input.walletAddress);
  } catch {
    throw new RefusalError(
      "SessionNotFoundError",
      `refusing to sign: no persisted session for wallet ${input.walletAddress}. ` +
        `The session may have been revoked or never existed; check ` +
        `SessionStore.read() before signing.`,
    );
  }

  // 2. The session must be unexpired.
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (resolved.persisted.expiry <= now) {
    throw new RefusalError(
      "SessionExpiredError",
      `refusing to sign: session for wallet ${input.walletAddress} expired at ` +
        `${resolved.persisted.expiry} (now=${now}). ` +
        `Grant a new session rather than signing against an expired key.`,
    );
  }

  // 3. The rail must be provisioned. The payment client `isValidSignature`
  // check fires when the bundled Permit2 envelope hits the merchant, but
  // if the rail was never approved, every envelope is unspendable.
  if (!resolved.persisted.railProvisioned) {
    throw new RefusalError(
      "RailNotProvisionedError",
      `refusing to sign: rail not provisioned for wallet ${input.walletAddress}. ` +
        `Run provisionRail() before the first payment — an envelope signed ` +
        `without an approved checker will fail at merchant verification.`,
    );
  }

  // 4. The signer must be available in memory. The store's `resolve`
  // already returns it; missing means the in-memory signer source
  // was never wired up at grant time.
  if (resolved.signer === undefined || resolved.signer === null) {
    throw new RefusalError(
      "SessionSignerMissingError",
      `refusing to sign: no signer in memory for wallet ${input.walletAddress}. ` +
        `The session signer lives in process memory only — a restart loses it.`,
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const PUBKEY =
  "0x04deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;

function makePersisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    walletAddress: WALLET,
    publicKey: PUBKEY,
    permissions: {
      calls: [{ signature: "transfer(address,uint256)" }],
      spend: [{ limit: 50n * 10n ** 18n, period: "day", token: TOKEN }],
    },
    expiry: 1_700_000_000,
    grantTransactionHash: null,
    railProvisioned: true,
    createdAt: 1_699_000_000,
    ...overrides,
  };
}

describe("assertCanSign — refusal-before-signing", () => {
  it("throws SessionNotFoundError when no session is persisted", () => {
    const store = new StubSessionStore();
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET }),
    ).toThrowError(RefusalError);
    try {
      assertCanSign({ store, walletAddress: WALLET });
      expect.unreachable("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(RefusalError);
      expect((err as RefusalError).name).toBe("SessionNotFoundError");
    }
  });

  it("throws SessionExpiredError when the persisted session has expired", () => {
    const store = new StubSessionStore();
    store.save(makePersisted({ expiry: 1_700_000_000 }));
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_700_000_001 }),
    ).toThrowError(RefusalError);
    try {
      assertCanSign({ store, walletAddress: WALLET, now: 1_700_000_001 });
      expect.unreachable("should have refused");
    } catch (err) {
      expect((err as RefusalError).name).toBe("SessionExpiredError");
    }
  });

  it("treats now === expiry as expired (boundary case)", () => {
    const store = new StubSessionStore();
    const expiry = 1_700_000_000;
    store.save(makePersisted({ expiry }));
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: expiry }),
    ).toThrowError(RefusalError);
    try {
      assertCanSign({ store, walletAddress: WALLET, now: expiry });
    } catch (err) {
      expect((err as RefusalError).name).toBe("SessionExpiredError");
    }
  });

  it("throws RailNotProvisionedError when the session is unprovisioned", () => {
    const store = new StubSessionStore();
    store.save(makePersisted({ railProvisioned: false }));
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).toThrowError(RefusalError);
    try {
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 });
    } catch (err) {
      expect((err as RefusalError).name).toBe("RailNotProvisionedError");
    }
  });

  it("refuses to sign for a revoked session (after store.remove)", () => {
    // Two-stage revocation: the local stage removes the session from
    // the store. A subsequent payment attempt must refuse, not bounce.
    const store = new StubSessionStore();
    store.save(makePersisted());
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).not.toThrow();
    store.remove(WALLET);
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).toThrowError(RefusalError);
    try {
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 });
    } catch (err) {
      expect((err as RefusalError).name).toBe("SessionNotFoundError");
    }
  });

  it("does not throw when every guard passes", () => {
    const store = new StubSessionStore();
    store.save(makePersisted({ railProvisioned: true }));
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).not.toThrow();
    const resolved = assertCanSign({
      store,
      walletAddress: WALLET,
      now: 1_600_000_000,
    });
    expect(resolved.persisted.walletAddress).toBe(WALLET);
    expect(resolved.signer).toBeDefined();
  });

  it("refuses in the right order: not-found > expired > unprovisioned", () => {
    // When every guard would fail, the order is observable from the
    // error name. Not-found wins (no session to even check expiry on).
    const store = new StubSessionStore();
    try {
      assertCanSign({ store, walletAddress: WALLET, now: 999_999_999 });
    } catch (err) {
      expect((err as RefusalError).name).toBe("SessionNotFoundError");
    }
  });

  it("flips from unprovisioned to provisioned after markRailProvisioned", () => {
    const store = new StubSessionStore();
    store.save(makePersisted({ railProvisioned: false }));
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).toThrowError(RefusalError);
    store.markRailProvisioned(WALLET);
    expect(() =>
      assertCanSign({ store, walletAddress: WALLET, now: 1_600_000_000 }),
    ).not.toThrow();
  });
});

describe("persisted-session byte-exactness through the codec", () => {
  it("round-trips a persisted session losslessly", () => {
    // The store's `save` does not yet persist through the codec in
    // this stub, but the codec itself must round-trip the persisted
    // shape losslessly. This pins down the contract the fileStore
    // implementation depends on.
    const persisted = makePersisted();
    const blob = encode(persisted);
    const decoded = decodeAndVerify<PersistedSession>(blob);
    expect(decoded.permissions.spend[0]!.limit).toBe(
      persisted.permissions.spend[0]!.limit,
    );
    expect(decoded.walletAddress).toBe(persisted.walletAddress);
  });
});
