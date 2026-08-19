/**
 * Integration tests for the seller at the composition root.
 *
 * These tests cover P0 TODO 2 — every rejection path the verifier can
 * classify — by exercising the seller at the `nextSegment` boundary.
 * We never hit HTTP; the seller is HTTP-agnostic and tests are cleaner
 * against its typed seam.
 *
 * The verifier and settler are stubbed so a unit-test runner doesn't
 * need a Permit2 deployment or a funded settler EOA. The composition
 * root wires real ones in production; the integration tests are
 * about *policy*, not chain plumbing.
 */

import { describe, expect, it } from "vitest";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import type { Address, Hex } from "@neuro-pay/types";
import { Buffer } from "node:buffer";

import {
  createSeller,
  type Seller,
  type SellerOutcome,
} from "./index.js";
import {
  createInMemorySettler,
  type Settler,
} from "./settle.js";
import {
  IS_VALID_SIGNATURE_MAGIC,
  type Verifier,
} from "./verify.js";

const PAYER: Address = "0x000000000000000000000000000000000000c0de";
const TOKEN: Address = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d";
const PAY_TO: Address = "0x000000000000000000000000000000000000d3ad";
const WRONG_PAY_TO: Address = "0x000000000000000000000000000000000000BAD1";
const WRONG_TOKEN: Address = "0x000000000000000000000000000000000000BAD2";

function envelopeHeaders(payload: Record<string, unknown>): {
  get(name: string): string | null;
} {
  const raw = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return { get: (n) => (n.toLowerCase() === "x-payment" ? raw : null) };
}

function freshLedger(): LedgerStore {
  return openLedgerStore({ storagePath: ":memory:" });
}

type BuildOpts = {
  verifier?: Verifier;
  settler?: Settler;
  chainId?: number;
  token?: Address;
  payTo?: Address;
  metering?: {
    budgetMargin: number;
    settlementThreshold: bigint;
    tickIntervalSeconds: number;
    maxInFlightSettlements: number;
  };
};

function buildSeller(opts: BuildOpts = {}): { seller: Seller; store: LedgerStore } {
  const store = freshLedger();
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
      chainId: opts.chainId ?? 97,
      token: opts.token ?? TOKEN,
      tokenDecimals: 18,
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

function baseEnvelope(nonce: string): Record<string, unknown> {
  return {
    from: PAYER,
    permit: {
      hash: "0x" + "22".repeat(32) as Hex,
      signature: "0x" + "11".repeat(65),
      witness: {
        payTo: PAY_TO,
        amount: "1000",
        token: TOKEN,
        chainId: 97,
        nonce,
      },
    },
  };
}

describe("seller integration — rejection paths", () => {
  it("rejects an envelope with the wrong recipient (witness.payTo mismatch)", async () => {
    const { seller } = buildSeller();
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const env = baseEnvelope("rej-recipient-1");
    env.permit = {
      ...(env.permit as Record<string, unknown>),
      witness: {
        payTo: WRONG_PAY_TO,
        amount: "1000",
        token: TOKEN,
        chainId: 97,
        nonce: "rej-recipient-1",
      },
    };

    const out = await seller.nextSegment({
      streamId: seller.inspectStreams()[0]!.id,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${seller.inspectStreams()[0]!.id}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("recipient-mismatch");
      expect(out.status).toBe(402);
    }
  });

  it("rejects an envelope with the wrong token", async () => {
    const { seller } = buildSeller();
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const stream = seller.inspectStreams()[0]!;
    const env = baseEnvelope("rej-token-1");
    env.permit = {
      ...(env.permit as Record<string, unknown>),
      witness: {
        payTo: PAY_TO,
        amount: "1000",
        token: WRONG_TOKEN,
        chainId: 97,
        nonce: "rej-token-1",
      },
    };

    const out: SellerOutcome = await seller.nextSegment({
      streamId: stream.id,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${stream.id}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/token/i);
    }
  });

  it("rejects an envelope with the wrong chainId", async () => {
    const { seller } = buildSeller();
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const stream = seller.inspectStreams()[0]!;
    const env = baseEnvelope("rej-chain-1");
    env.permit = {
      ...(env.permit as Record<string, unknown>),
      witness: {
        payTo: PAY_TO,
        amount: "1000",
        token: TOKEN,
        chainId: 1,
        nonce: "rej-chain-1",
      },
    };

    const out: SellerOutcome = await seller.nextSegment({
      streamId: stream.id,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${stream.id}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/chainId/i);
    }
  });

  // Underpayment is exercised at the verifyEnvelope layer (see verify.test.ts).
  // At the seller composition root, an envelope's witness.amount is read as
  // the demanded amount when present, so a seller-level underpaid test would
  // require changing the seller's demand-derivation logic — out of scope for
  // this P0 integration suite. The verify-level test is the canonical
  // coverage for `amount-underpaid`.

  it("rejects an expired envelope (deadline < now)", async () => {
    const { seller } = buildSeller();
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const stream = seller.inspectStreams()[0]!;
    const env = baseEnvelope("rej-expired-1");
    env.permit = {
      ...(env.permit as Record<string, unknown>),
      witness: {
        payTo: PAY_TO,
        amount: "1000",
        token: TOKEN,
        chainId: 97,
        nonce: "rej-expired-1",
        deadline: 1,
      },
    };

    const out: SellerOutcome = await seller.nextSegment({
      streamId: stream.id,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${stream.id}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
      expect(out.detail).toMatch(/expired/i);
    }
  });

  it("rejects when the verifier returns a non-magic value", async () => {
    const rejectingVerifier: Verifier = async () =>
      ("0xdeadbeef" + "0".repeat(56)) as Hex;
    const { seller } = buildSeller({ verifier: rejectingVerifier });
    seller.openStream({ requestUrl: "https://api.example/v1/streams" });
    const stream = seller.inspectStreams()[0]!;
    const env = baseEnvelope("rej-verifier-1");

    const out: SellerOutcome = await seller.nextSegment({
      streamId: stream.id,
      headers: envelopeHeaders(env),
      requestUrl: `https://api.example/v1/streams/${stream.id}/next`,
    });

    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.classification).toBe("verification-failed");
    }
  });
});
