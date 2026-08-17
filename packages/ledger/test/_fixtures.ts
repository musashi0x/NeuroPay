/**
 * Shared fixtures for ledger tests.
 *
 * The tests pass through real `node:sqlite` connections (`:memory:`),
 * so every test gets a clean ledger without touching the on-disk store.
 * The deterministic id generator makes append order reproducible and
 * the timestamp injector makes time-dependent assertions stable.
 */

import { openLedgerStore } from "../src/store.js";
import type { LedgerStore, LedgerStoreOptions } from "../src/store.js";

/**
 * A counter-based id generator. Each call returns `id-0001`, `id-0002`,
 * ... so snapshot tests have stable ids without depending on `crypto`.
 */
let counter = 0;
export function resetIdCounter(): void {
  counter = 0;
}

export function deterministicId(): string {
  counter += 1;
  return `id-${counter.toString().padStart(4, "0")}`;
}

/**
 * Build a fresh in-memory ledger with deterministic ids.
 *
 * `clock` defaults to a clock that starts at `2026-01-01T00:00:00.000Z`
 * and ticks 1 ms per call; tests that need explicit instants can pass
 * their own.
 */
export function newLedger(
  overrides: Partial<LedgerStoreOptions> = {},
): LedgerStore & { __clockMs: () => number } {
  // Start at a fixed epoch so `Date.parse` timestamps line up across
  // tests. Each `now()` call advances by 1 ms.
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const store = openLedgerStore({
    storagePath: ":memory:",
    clock: overrides.clock ?? (() => new Date(t++).toISOString()),
    randomId: overrides.randomId ?? deterministicId,
  });
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "__clockMs") return () => t;
      return Reflect.get(target, prop, receiver);
    },
  }) as LedgerStore & { __clockMs: () => number };
}

export const SAMPLE_TOKEN = "0x" + "ab".repeat(20) as `0x${string}`;
export const SAMPLE_SESSION_PUBKEY =
  ("0x" + "11".repeat(48)) as `0x${string}`;
export const SAMPLE_TX_HASH =
  "0x" + "22".repeat(32) as `0x${string}`;
export const SAMPLE_CHAIN_ID = 97;
export const SAMPLE_TOKEN_DECIMALS = 18;
