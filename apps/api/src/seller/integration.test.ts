/**
 * Integration tests for the seller at the composition root.
 *
 * These tests cover P0 TODO 2 — every rejection path the verifier can
 * classify — by exercising the seller at the `nextSegment` boundary.
 * We never hit HTTP; the seller is HTTP-agnostic and tests are cleaner
 * against its typed seam.
 *
 * Envelopes are produced by the real buyer path (`signX402Payment` via
 * `signX402PaymentFor`), so a rejection here is a rejection of something
 * a buyer can actually send. Only the ERC-1271 read and the chain settler
 * are stubbed: a unit-test runner has no Permit2 deployment and no funded
 * settler EOA.
 *
 * Each rejection also has to leave an audit trail: a 402 that records
 * nothing tells an operator only that the buyer did not get a segment,
 * never why the seller refused. The classifications are computed either
 * way, so throwing them away is pure loss.
 *
 * Wrong-chain deserves a note. It is no longer a field comparison — the
 * chain id is never on the wire. A buyer that signs for another chain
 * produces a digest this seller does not recompute, so the stub verifier
 * models a real account by returning the magic only for the digest that
 * was actually signed.
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import type { Address, Hex } from "@neuro-pay/types";

import { createSeller, type Seller, type SellerOutcome } from "./index.js";
import { createInMemorySettler, type Settler } from "./settle.js";
import { IS_VALID_SIGNATURE_MAGIC, type Verifier } from "./verify.js";
import {
  CHAIN_ID,
  PAY_TO,
  SETTLER,
  TOKEN,
  headersFor,
  requirement,
  signRealEnvelope,
} from "./__fixtures__/real-envelope.js";

const WRONG_PAY_TO: Address = "0x000000000000000000000000000000000000bad1";
const WRONG_TOKEN: Address = "0x000000000000000000000000000000000000bad2";
const WRONG_SETTLER: Address = "0x000000000000000000000000000000000000bad3";

function freshLedger(): LedgerStore {
  return openLedgerStore({ storagePath: ":memory:" });
}

type BuildOpts = {
  verifier?: Verifier;
  settler?: Settler;
  store?: LedgerStore;
  chainId?: number;
  token?: Address;
  payTo?: Address;
  settlerAddress?: Address;
  metering?: {
    budgetMargin: number;
    settlementThreshold: bigint;
    tickIntervalSeconds: number;
    maxInFlightSettlements: number;
  };
};

function buildSeller(opts: BuildOpts = {}): {
  seller: Seller;
  store: LedgerStore;
} {
  const store = opts.store ?? freshLedger();
  const verifier: Verifier =
    opts.verifier ?? (async () => IS_VALID_SIGNATURE_MAGIC);
  const settler =
    opts.settler ?? createInMemorySettler({ defaultBehavior: "confirm" });
  const seller = createSeller({
    config: {
      metering: opts.metering ?? {
        budgetMargin: 0,
        settlementThreshold: 100n,
        tickIntervalSeconds: 60,
        maxInFlightSettlements: 2,
      },
      payTo: opts.payTo ?? PAY_TO,
      chainId: opts.chainId ?? CHAIN_ID,
      token: opts.token ?? TOKEN,
      tokenDecimals: 18,
      settlerAddress: opts.settlerAddress ?? SETTLER,
      maxSecondsPerSegment: 10,
      maxUnitsPerSegment: 10,
    },
    store,
    verifier,
    settler,
    initialPriceSheet: {
      perCall: 100n,
      perSecond: 10n,
      perUnit: 1n,
      unitName: "token",
    },
  });
  return { seller, store };
}

/**
 * Sign a real envelope and return its headers. `nonce` doubles as the
 * Permit2 nonce so each test gets a distinct idempotency key.
 */
async function realHeaders(
  nonce: bigint,
  overrides: Partial<Parameters<typeof requirement>[0]> = {},
) {
  const signed = await signRealEnvelope({
    permit2Nonce: nonce,
    requirement: requirement(overrides),
  });
  return { headers: headersFor(signed.header), signed };
}

function openStream(seller: Seller): string {
  seller.openStream({ requestUrl: "https://api.example/v1/streams" });
  return seller.inspectStreams()[0]!.id;
}

describe("seller integration — rejection paths", () => {
  it("rejects an envelope with the wrong recipient (witness.to mismatch)", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    const { headers } = await realHeaders(1001n, { payTo: WRONG_PAY_TO });

    const out = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("recipient-mismatch");
      expect(out.status).toBe(402);
    }
  });

  it("rejects an envelope with the wrong token", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    const { headers } = await realHeaders(1002n, { asset: WRONG_TOKEN });

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/token/i);
    }
  });

  it("rejects an envelope signed for a different settler", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    const { headers } = await realHeaders(1003n, {
      extra: {
        name: null,
        version: null,
        verifyingContract: null,
        spenderAddress: WRONG_SETTLER,
        assetTransferMethod: "permit2-exact",
      },
    });

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/spender/i);
    }
  });

  it("rejects an envelope signed for the wrong chain", async () => {
    // The buyer signs for BNB mainnet; this seller runs on chain 97 and so
    // recomputes a digest the buyer's account never signed. A real account
    // answers non-magic for a digest it did not sign — so does this stub.
    const signedForOtherChain = await signRealEnvelope({
      permit2Nonce: 1004n,
      requirement: requirement({ chainId: 56, network: "bsc" }),
    });
    const verifier: Verifier = async ({ hash }) =>
      hash === signedForOtherChain.digest
        ? IS_VALID_SIGNATURE_MAGIC
        : ("0x" as Hex);

    const { seller } = buildSeller({ verifier });
    const streamId = openStream(seller);

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers: headersFor(signedForOtherChain.header),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
    }
  });

  it("rejects an underpaid envelope", async () => {
    // Underpayment is only meaningful once the meter has accrued, so pay
    // one segment first. This assertion is possible at all only because
    // the demand now comes from the seller's meter — it used to be read
    // off the buyer's own witness, which made every payment self-
    // justifying and `amount-underpaid` unreachable here.
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    const url = `https://api.example/v1/streams/${streamId}/next`;

    const paid = await realHeaders(1005n);
    const first = await seller.nextSegment({
      streamId,
      headers: paid.headers,
      requestUrl: url,
    });
    expect(first.kind).toBe("delivered");

    const { headers } = await realHeaders(1006n, { maxAmountRequired: 1n });
    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: url,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("amount-underpaid");
    }
  });

  it("rejects an expired envelope (deadline < now)", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    // Signed an hour ago against a 60-second window.
    const signed = await signRealEnvelope({
      permit2Nonce: 1016n,
      now: Math.floor(Date.now() / 1000) - 3600,
    });

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers: headersFor(signed.header),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/expired/i);
    }
  });

  it("rejects an envelope after the session is revoked (kill switch)", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);
    seller.endAll("session-revoked");
    const { headers } = await realHeaders(1007n);

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("session-revoked");
      expect(out.status).toBe(402);
    }
  });

  it("rejects when the verifier returns a non-magic value", async () => {
    const rejectingVerifier: Verifier = async () =>
      ("0xdeadbeef" + "0".repeat(56)) as Hex;
    const { seller } = buildSeller({ verifier: rejectingVerifier });
    const streamId = openStream(seller);
    const { headers } = await realHeaders(1008n);

    const out: SellerOutcome = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
    }
  });
});

describe("seller integration — every rejection is audited", () => {
  /** All `payment.rejected` entries, oldest first. */
  async function rejections(store: LedgerStore) {
    const all = await store.entries();
    return all.filter((e) => e.event === "payment.rejected");
  }

  it("records the classification and the real nonce for a verified-envelope refusal", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);
    const signed = await signRealEnvelope({
      permit2Nonce: 3001n,
      requirement: requirement({ payTo: WRONG_PAY_TO }),
    });

    await seller.nextSegment({
      streamId,
      headers: headersFor(signed.header),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    const [entry, ...rest] = await rejections(store);
    expect(rest).toHaveLength(0);
    expect(entry?.classification).toBe("recipient-mismatch");
    expect(entry?.nonce).toBe(signed.nonce);
    expect(entry?.streamId).toBe(streamId);
    expect(entry?.detail).toContain(WRONG_PAY_TO);
  });

  it("records a malformed envelope with no nonce rather than inventing one", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);

    await seller.nextSegment({
      streamId,
      headers: headersFor("not-a-real-envelope"),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    const [entry] = await rejections(store);
    expect(entry?.classification).toBe("verification-failed");
    // A placeholder here would put a nonce no buyer ever sent into
    // `lookupByNonce`'s index.
    expect(entry?.nonce).toBeNull();
    expect(entry?.detail).toContain("envelope error");
  });

  it("records a revoked session before the envelope is even read", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);
    seller.endAll("session-revoked");
    const { headers } = await realHeaders(3002n);

    await seller.nextSegment({
      streamId,
      headers,
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    const [entry] = await rejections(store);
    expect(entry?.classification).toBe("session-revoked");
    expect(entry?.nonce).toBeNull();
  });

  it("records the demanded amount so an underpayment can be compared", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);
    const url = `https://api.example/v1/streams/${streamId}/next`;

    const paid = await realHeaders(3003n);
    await seller.nextSegment({
      streamId,
      headers: paid.headers,
      requestUrl: url,
    });

    const underpaid = await realHeaders(3004n, { maxAmountRequired: 1n });
    await seller.nextSegment({
      streamId,
      headers: underpaid.headers,
      requestUrl: url,
    });

    const [entry] = await rejections(store);
    expect(entry?.classification).toBe("amount-underpaid");
    // What the seller wanted, not what the buyer offered — the buyer's
    // figure is already in the detail string.
    expect(entry?.amount).toBeGreaterThan(1n);
  });

  it("writes nothing when the buyer simply has not paid yet", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);

    const out = await seller.nextSegment({
      streamId,
      headers: { get: () => null },
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    // Delivering on credit is the protocol working, not a refusal.
    // Auditing it as one would bury the real refusals in noise.
    expect(out.kind).toBe("delivered");
    expect(await rejections(store)).toHaveLength(0);
  });

  it("still answers the buyer when the audit write fails", async () => {
    // The rejection is the buyer's answer; the entry is the operator's
    // record. A ledger that cannot take the record must not cost the
    // answer, so the write is fire-and-forget and its failure is logged
    // rather than thrown.
    const underlying = freshLedger();
    let refusedWrites = 0;
    const store: LedgerStore = {
      ...underlying,
      append: async (entry) => {
        if (entry.event === "payment.rejected") {
          refusedWrites += 1;
          throw new Error("ledger is on fire");
        }
        return underlying.append(entry);
      },
    } as LedgerStore;

    const { seller } = buildSeller({ store });
    const streamId = openStream(seller);
    const signed = await signRealEnvelope({
      permit2Nonce: 3005n,
      requirement: requirement({ asset: WRONG_TOKEN }),
    });

    const out = await seller.nextSegment({
      streamId,
      headers: headersFor(signed.header),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });

    expect(refusedWrites).toBe(1);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.status).toBe(402);
    }
  });
});

describe("seller integration — threshold-or-tick, not pay-per-segment", () => {
  const url = (id: string) => `https://api.example/v1/streams/${id}/next`;
  const unpaid = { get: () => null };

  it("delivers on credit while nothing is owed yet", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);

    const out = await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });

    // The old behaviour was a 402 quoting `maxAmountRequired: "0"`,
    // which asked the buyer to sign for nothing and then settle it on
    // chain — one wasted signature and one zero-value transfer per
    // segment, the exact per-unit cost threshold-or-tick exists to
    // avoid.
    expect(out.kind).toBe("delivered");
  });

  it("demands payment once the accrual reaches the threshold", async () => {
    // One segment accrues 100 (perCall) + 10x10 (perSecond) + 1x10
    // (perUnit) = 210, well past the 100 threshold.
    const { seller } = buildSeller();
    const streamId = openStream(seller);

    const first = await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });
    expect(first.kind).toBe("delivered");

    const second = await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });
    expect(second.kind).toBe("payment-required");
    if (second.kind !== "payment-required") return;

    const demanded = second.body.accepts[0]?.maxAmountRequired;
    expect(demanded).toBe(210n);
  });

  it("never quotes a zero-amount 402", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);

    // Drive the stream well past the threshold and collect every 402.
    const quotes: bigint[] = [];
    for (let i = 0; i < 6; i += 1) {
      const out = await seller.nextSegment({
        streamId,
        headers: unpaid,
        requestUrl: url(streamId),
      });
      if (out.kind === "payment-required") {
        quotes.push(out.body.accepts[0]!.maxAmountRequired);
      }
    }

    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) expect(q).toBeGreaterThan(0n);
  });

  it("audits an unpaid delivery with a null nonce and a zero amount", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);

    await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });

    const entries = await store.entries();
    const delivered = entries.filter((e) => e.event === "segment.delivered");
    expect(delivered).toHaveLength(1);
    // Null rather than a placeholder: nothing was authorized, so there
    // is no nonce, and inventing one would put a key into the ledger no
    // buyer ever sent.
    expect(delivered[0]?.nonce).toBeNull();
    expect(delivered[0]?.amount).toBe(0n);
    expect(delivered[0]?.detail).toContain("on credit");
  });

  it("creates no settlement for a delivery nobody paid for", async () => {
    const { seller, store } = buildSeller();
    const streamId = openStream(seller);

    await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });
    await seller.drainSettlements();

    expect(await store.listIntents()).toHaveLength(0);
  });

  it("still holds the full exposure budget after delivering on credit", async () => {
    // Unpaid delivery takes no exposure slot: exposure bounds in-flight
    // settlements, and there is no settlement here. The credit is
    // bounded by the threshold instead.
    const { seller } = buildSeller();
    const streamId = openStream(seller);

    const before = seller.exposureStats().inFlight;
    await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });
    expect(seller.exposureStats().inFlight).toBe(before);
  });

  it("advances the sequence across credit and paid deliveries alike", async () => {
    const { seller } = buildSeller();
    const streamId = openStream(seller);

    const free = await seller.nextSegment({
      streamId,
      headers: unpaid,
      requestUrl: url(streamId),
    });
    expect(free.kind).toBe("delivered");
    const firstSeq =
      free.kind === "delivered"
        ? (free.body as { sequence: number }).sequence
        : -1;

    const { headers } = await realHeaders(4001n);
    const paid = await seller.nextSegment({
      streamId,
      headers,
      requestUrl: url(streamId),
    });
    expect(paid.kind).toBe("delivered");
    const secondSeq =
      paid.kind === "delivered"
        ? (paid.body as { sequence: number }).sequence
        : -1;

    expect(secondSeq).toBe(firstSeq + 1);
  });
});

describe("seller integration — the accepted path", () => {
  it("delivers a segment and threads the real authorization into settlement", async () => {
    const submitted: import("./settle.js").SettlementInput[] = [];
    const settler: Settler = {
      async submitSettle(input) {
        submitted.push(input);
        return { transactionHash: ("0x" + "ab".repeat(32)) as Hex };
      },
      async awaitConfirmation() {},
    };
    const { seller, store } = buildSeller({ settler });
    const streamId = openStream(seller);
    const signed = await signRealEnvelope({ permit2Nonce: 2001n });

    const out = await seller.nextSegment({
      streamId,
      headers: headersFor(signed.header),
      requestUrl: `https://api.example/v1/streams/${streamId}/next`,
    });
    expect(out.kind).toBe("delivered");
    await seller.drainSettlements();

    expect(submitted).toHaveLength(1);
    const input = submitted[0]!;
    expect(input.nonce).toBe(signed.nonce);
    expect(input.payer).toBe(signed.payer);
    expect(input.deadline).toBe(signed.deadline);
    // The three fields that used to be fabricated at the chain settler.
    expect(input.authorization?.signature).toBe(signed.signature);
    expect(input.authorization?.spender).toBe(SETTLER);
    expect(input.authorization?.witness).toEqual({
      to: PAY_TO,
      validAfter: "0",
    });

    // The outbox row has to be settleable on its own after a crash.
    const intent = await store.getIntent(signed.nonce);
    expect(intent?.authorization).toEqual({
      signature: signed.signature,
      spender: SETTLER,
      witness: { to: PAY_TO, validAfter: "0" },
    });
  });
});
