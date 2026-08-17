/**
 * 6.7 — no ledger entry may carry private key material.
 *
 * The ledger is the one artefact of this system that is meant to be
 * durable, exported, and read by humans. A session private key that
 * lands in it is not a logging bug that scrolls away — it is a
 * spendable secret sitting in a file that outlives the process. So the
 * check runs on the write path, not only in review, and rejects the
 * entry rather than sanitising it: a caller that tried to persist key
 * material has a bug that silently redacting would hide.
 *
 * The shape-based heuristics live in `./secrets.js` and are tested here
 * through the public event-recording surface so a regression in the
 * public path is what trips the test, not an internal one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KeyMaterialRejectedError,
  recordAccrual,
  recordPaymentDemanded,
  recordPaymentRefused,
  recordPaymentSigned,
  recordPaymentVerified,
  recordSegmentDelivered,
  recordSessionGranted,
  recordSessionRevoked,
  recordSettlementFailed,
  recordSettlementSubmitted,
  recordStreamEnded,
  recordStreamOpened,
} from "../src/index.js";
import {
  SAMPLE_CHAIN_ID,
  SAMPLE_SESSION_PUBKEY,
  SAMPLE_TOKEN,
  SAMPLE_TOKEN_DECIMALS,
  SAMPLE_TX_HASH,
  newLedger,
  resetIdCounter,
} from "./_fixtures.js";
import type { LedgerStore } from "../src/store.js";

/**
 * A 32-byte private key in hex. Same length as a settlement tx hash,
 * which is exactly the trap the exempt-field trick in `./secrets.js`
 * exists to navigate.
 */
const PRIVATE_KEY_HEX = ("0x" + "59".repeat(32)) as `0x${string}`;

/**
 * Twelve lowercase English words: the canonical shape of a BIP-39 seed
 * phrase. Putting it in `detail` would reconstruct every key under it.
 */
const SEED_PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("secret-leak guard", () => {
  let store: LedgerStore;
  let ctx: {
    streamId: string;
    sessionPublicKey: typeof SAMPLE_SESSION_PUBKEY;
    chainId: number;
    token: typeof SAMPLE_TOKEN;
    tokenDecimals: number;
  };

  beforeEach(() => {
    resetIdCounter();
    store = newLedger();
    ctx = {
      streamId: "stream-1",
      sessionPublicKey: SAMPLE_SESSION_PUBKEY,
      chainId: SAMPLE_CHAIN_ID,
      token: SAMPLE_TOKEN,
      tokenDecimals: SAMPLE_TOKEN_DECIMALS,
    };
  });

  afterEach(() => {
    store.close();
  });

  it("rejects a 64-hex string in `detail` (private-key shape)", async () => {
    await expect(
      recordStreamOpened({
        store,
        ctx,
        detail: `uploader key=${PRIVATE_KEY_HEX}`,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);

    await expect(
      recordStreamOpened({
        store,
        ctx,
        detail: PRIVATE_KEY_HEX.slice(2), // un-prefixed form, same length
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("rejects a 64-hex string passed as `nonce`", async () => {
    await expect(
      recordPaymentDemanded({
        store,
        ctx,
        amount: 1n,
        nonce: PRIVATE_KEY_HEX,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("rejects a 64-hex string passed as `streamId`", async () => {
    await expect(
      recordAccrual({
        store,
        ctx: { ...ctx, streamId: PRIVATE_KEY_HEX },
        amount: 100n,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("rejects a BIP-39 mnemonic in `detail`", async () => {
    await expect(
      recordAccrual({ store, ctx, amount: 1n, detail: SEED_PHRASE }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("rejects a labelled `privateKey=` fragment", async () => {
    await expect(
      recordSegmentDelivered({
        store,
        ctx,
        amount: 1n,
        nonce: "0x01",
        secondsDelivered: 0,
        unitsDelivered: 0,
        detail: "privateKey=anything-truncated-base64-KEK",
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("rejects a labelled `secret_key` and `mnemonic` fragment in detail", async () => {
    await expect(
      recordPaymentRefused({
        store,
        ctx,
        amount: 1n,
        classification: "eoa-only-facilitator",
        detail: "secret_key = oops",
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);

    await expect(
      recordPaymentRefused({
        store,
        ctx,
        amount: 1n,
        classification: "verification-failed",
        detail: "Mnemonic provided for recovery",
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("does not reject a 32-byte transaction hash (exempt field)", async () => {
    // Settlement events frequently carry the hash. The hex shape is
    // indistinguishable from a private key, but the field is exempt.
    // This confirms the exempt pass works end-to-end through the
    // event helpers, not just inside the guard.
    await expect(
      recordSettlementSubmitted({
        store,
        ctx,
        amount: 1n,
        nonce: "0x99",
        transactionHash: SAMPLE_TX_HASH,
      }),
    ).resolves.toMatchObject({ transactionHash: SAMPLE_TX_HASH });

    await expect(
      recordSettlementFailed({
        store,
        ctx,
        amount: 1n,
        nonce: "0x99",
        classification: "settler-out-of-gas",
        transactionHash: SAMPLE_TX_HASH,
      }),
    ).resolves.toMatchObject({ transactionHash: SAMPLE_TX_HASH });
  });

  it("accepts `0x` (placeholder) and a real 32-byte hash, rejects other lengths", async () => {
    // `0x` is the documented placeholder for "not yet submitted".
    await expect(
      recordPaymentSigned({
        store,
        ctx,
        amount: 1n,
        nonce: "0xaa",
      }),
    ).resolves.toBeDefined();

    // A 31-byte hex value is between the address (20 byte) and the
    // hash (32 byte), and must not be accepted as a transactionHash.
    const shortHash = ("0x" + "11".repeat(31)) as `0x${string}`;
    await expect(
      recordSettlementSubmitted({
        store,
        ctx,
        amount: 1n,
        nonce: "0xab",
        transactionHash: shortHash,
      }),
    ).rejects.toThrow(/transactionHash/);
  });

  it("accepts normal-looking detail with embedded hex that is too short", async () => {
    // An address (20 bytes, 40 hex digits) is shorter than the 64-hex
    // private-key shape, so it must not trip the guard.
    await expect(
      recordStreamEnded({
        store,
        ctx,
        reason: "completed",
        detail: `paid to ${SAMPLE_TOKEN}`,
      }),
    ).resolves.toBeDefined();

    // A 33-byte value (66 hex digits, e.g. compressed pubkey) is longer
    // than the 64-hex private-key shape; still under the regex bounds
    // because the regex requires *exactly* 64 hex digits.
    const compressed = ("0x" + "33".repeat(33)) as `0x${string}`;
    await expect(
      recordStreamEnded({
        store,
        ctx,
        reason: "completed",
        detail: `compressed=${compressed}`,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects key-shaped values inside session-lifecycle helpers too", async () => {
    // `recordSessionGranted` / `recordSessionRevoked` are not stream-
    // scoped but their `detail` field is still scanned, because the
    // operator could copy-paste anything into it.
    await expect(
      recordSessionGranted({
        store,
        sessionPublicKey: SAMPLE_SESSION_PUBKEY,
        transactionHash: SAMPLE_TX_HASH,
        chainId: SAMPLE_CHAIN_ID,
        token: SAMPLE_TOKEN,
        tokenDecimals: SAMPLE_TOKEN_DECIMALS,
        detail: `tip: sign with ${PRIVATE_KEY_HEX}`,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);

    await expect(
      recordSessionRevoked({
        store,
        sessionPublicKey: SAMPLE_SESSION_PUBKEY,
        chainId: SAMPLE_CHAIN_ID,
        token: SAMPLE_TOKEN,
        tokenDecimals: SAMPLE_TOKEN_DECIMALS,
        stage: "local",
        detail: SEED_PHRASE,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);
  });

  it("refused write does not produce a row", async () => {
    await expect(
      recordPaymentVerified({
        store,
        ctx,
        amount: 1n,
        nonce: "0x0a",
        detail: `seed=${SEED_PHRASE}`,
      }),
    ).rejects.toBeInstanceOf(KeyMaterialRejectedError);

    const entries = await store.entries();
    expect(entries).toHaveLength(0);
  });

  it("does not reject an entry whose every field is benign", async () => {
    await expect(
      recordStreamOpened({
        store,
        ctx,
        amount: 1n,
        detail: "stream opened by buyer-42 at /v1/streams",
      }),
    ).resolves.toMatchObject({ event: "stream.opened" });
    await expect(
      recordPaymentVerified({
        store,
        ctx,
        amount: 1n,
        nonce: "0x05",
      }),
    ).resolves.toMatchObject({ event: "payment.verified" });
  });
});
