/**
 * Tests for envelope verification (5.6).
 *
 * The happy path runs against a **real** signed envelope — the SDK's own
 * `signX402Payment` output, parsed by the seller's own parser — because
 * the previous synthetic fixtures agreed with the verifier and disagreed
 * with reality. Rejection cases mutate that real envelope one field at a
 * time.
 *
 * Verified:
 *  - ERC-1271 happy path: verifier returns the magic, envelope accepted
 *  - the seller recomputes exactly the digest the buyer signed
 *  - a wire-supplied `hash` is ignored (it does not exist on the wire)
 *  - underpaid amount → `amount-underpaid`
 *  - mismatched payTo → `recipient-mismatch`
 *  - mismatched token / spender / expired deadline → `verification-failed`
 *  - wrong chain: no field compare, the recomputed digest simply differs
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { Address, Hex, X402PaymentRequired } from "@neuro-pay/types";
import type { Clock } from "@neuro-pay/metering";
import { parseEnvelope, type ParsedEnvelope } from "./envelope.js";
import {
  IS_VALID_SIGNATURE_MAGIC,
  recomputePermit2Digest,
  verifyEnvelope,
  type Verifier,
} from "./verify.js";
import {
  CHAIN_ID,
  PAY_TO,
  SETTLER,
  TOKEN,
  requirement,
  signRealEnvelope,
} from "./__fixtures__/real-envelope.js";

const WRONG_PAY_TO = "0x000000000000000000000000000000000000beef" as Address;
const WRONG_TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const WRONG_SETTLER = "0x2222222222222222222222222222222222222222" as Address;

/** 2024-01-01T00:00:00Z. The fixtures sign relative to this. */
const NOW_SECONDS = 1_704_067_200;
const NOW_MS = NOW_SECONDS * 1000;
const testClock: Clock = { now: () => NOW_MS };

/** Parse a real signed header into the seller's envelope. */
async function realEnvelope(
  overrides: Parameters<typeof signRealEnvelope>[0] = {},
): Promise<{ envelope: ParsedEnvelope; digest: Hex; payer: Address }> {
  const signed = await signRealEnvelope({ now: NOW_SECONDS, ...overrides });
  const parsed = parseEnvelope(signed.header, "x-payment");
  if (parsed.kind !== "ok") {
    throw new Error(
      `real signed envelope failed to parse: ${JSON.stringify(parsed.error)}`,
    );
  }
  return {
    envelope: parsed.envelope,
    digest: signed.digest,
    payer: signed.payer,
  };
}

/** Re-encode a parsed envelope's JSON after mutating it, then re-parse. */
function reparse(raw: Record<string, unknown>): ParsedEnvelope {
  const payload = Buffer.from(JSON.stringify(raw), "utf8").toString("base64");
  const parsed = parseEnvelope(payload, "x-payment");
  if (parsed.kind !== "ok") {
    throw new Error(
      `mutated fixture failed to parse: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.envelope;
}

/** Deep-clone a parsed envelope's raw JSON so mutations do not leak. */
function rawOf(envelope: ParsedEnvelope): Record<string, unknown> {
  return JSON.parse(JSON.stringify(envelope.raw)) as Record<string, unknown>;
}

/** Reach into the decoded JSON's permit objects (both dialects). */
function permitsOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  const payload = raw["payload"] as Record<string, unknown>;
  return [payload["permit"], payload["permit2Authorization"]].filter(
    (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
  );
}

function mkPaymentRequired(): X402PaymentRequired {
  return { x402Version: 1, error: null, accepts: [requirement()] };
}

function stubVerifier(returnValue: Hex): Verifier {
  return async () => returnValue;
}

function baseInput(envelope: ParsedEnvelope) {
  return {
    envelope,
    demandedAmount: 1000n,
    expectedPayTo: PAY_TO,
    expectedToken: TOKEN,
    expectedChainId: CHAIN_ID,
    expectedSpender: SETTLER,
    paymentRequired: mkPaymentRequired(),
  };
}

describe("verify - ERC-1271 happy path", () => {
  it("accepts a real signed envelope when isValidSignature returns the magic", async () => {
    const { envelope } = await realEnvelope();
    const res = await verifyEnvelope(
      baseInput(envelope),
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind === "ok" ? "ok" : res.detail).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.authorized.payTo).toBe(PAY_TO);
    expect(res.authorized.amount).toBe(1000n);
    expect(res.authorized.token).toBe(TOKEN);
    expect(res.authorized.chainId).toBe(CHAIN_ID);
  });

  it("recomputes exactly the digest the buyer signed", async () => {
    const { envelope, digest } = await realEnvelope();
    let seen: Hex | null = null;
    await verifyEnvelope(
      baseInput(envelope),
      async ({ hash }) => {
        seen = hash;
        return IS_VALID_SIGNATURE_MAGIC;
      },
      testClock,
    );
    expect(seen).toBe(digest);
  });

  it("passes the payer and the wire signature to isValidSignature", async () => {
    const { envelope, payer } = await realEnvelope();
    let seen: { payer: Address; signature: Hex } | null = null;
    await verifyEnvelope(
      baseInput(envelope),
      async (input) => {
        seen = { payer: input.payer, signature: input.signature };
        return IS_VALID_SIGNATURE_MAGIC;
      },
      testClock,
    );
    expect(seen!.payer).toBe(payer);
    expect(seen!.signature).toBe(envelope.signature);
    // A session-key envelope is the 98-byte nested ERC-1271 blob, never a
    // bare 65-byte EOA signature.
    expect((seen!.signature.length - 2) / 2).toBeGreaterThan(65);
  });

  it("ignores a wire-supplied `hash` — the digest is always recomputed", async () => {
    const { envelope, digest } = await realEnvelope();
    const raw = rawOf(envelope);
    for (const permit of permitsOf(raw)) {
      permit["hash"] = "0x" + "ab".repeat(32);
    }
    const seen: Hex[] = [];
    await verifyEnvelope(
      baseInput(reparse(raw)),
      async ({ hash }) => {
        seen.push(hash);
        return IS_VALID_SIGNATURE_MAGIC;
      },
      testClock,
    );
    expect(seen[0]).toBe(digest);
  });
});

describe("verify - rejections", () => {
  it("rejects an underpaid permit", async () => {
    const { envelope } = await realEnvelope();
    const res = await verifyEnvelope(
      { ...baseInput(envelope), demandedAmount: 5000n },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("amount-underpaid");
    }
  });

  it("rejects a permit bound to the wrong recipient", async () => {
    const { envelope } = await realEnvelope({
      requirement: requirement({ payTo: WRONG_PAY_TO }),
    });
    const res = await verifyEnvelope(
      baseInput(envelope),
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("recipient-mismatch");
    }
  });

  it("rejects a permit on the wrong token", async () => {
    const { envelope } = await realEnvelope({
      requirement: requirement({ asset: WRONG_TOKEN }),
    });
    const res = await verifyEnvelope(
      baseInput(envelope),
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
      expect(res.detail).toContain("token");
    }
  });

  it("rejects a permit signed for a different settler", async () => {
    const { envelope } = await realEnvelope({
      requirement: requirement({
        extra: {
          name: null,
          version: null,
          verifyingContract: null,
          spenderAddress: WRONG_SETTLER,
          assetTransferMethod: "permit2-exact",
        },
      }),
    });
    const res = await verifyEnvelope(
      baseInput(envelope),
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
      expect(res.detail).toContain("spender");
    }
  });

  it("rejects an expired permit before calling the chain", async () => {
    const { envelope } = await realEnvelope();
    let called = false;
    const res = await verifyEnvelope(
      baseInput(envelope),
      async () => {
        called = true;
        return IS_VALID_SIGNATURE_MAGIC;
      },
      // One second past the 60s window the requirement quotes.
      { now: () => (NOW_SECONDS + 61) * 1000 },
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") expect(res.detail).toBe("session expired");
    expect(called).toBe(false);
  });

  it("rejects a witness-less (legacy plain permit2) envelope", async () => {
    const { envelope } = await realEnvelope();
    const raw = rawOf(envelope);
    for (const permit of permitsOf(raw)) delete permit["witness"];
    const res = await verifyEnvelope(
      baseInput(reparse(raw)),
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
      expect(res.detail).toContain("witness");
    }
  });

  it("rejects when isValidSignature returns anything but the magic", async () => {
    const { envelope } = await realEnvelope();
    const res = await verifyEnvelope(
      baseInput(envelope),
      stubVerifier("0xdeadbeef" as Hex),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
    }
  });

  it("classifies an isValidSignature read failure rather than throwing", async () => {
    const { envelope } = await realEnvelope();
    const res = await verifyEnvelope(
      baseInput(envelope),
      async () => {
        throw new Error("rpc down");
      },
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.detail).toContain("rpc down");
    }
  });
});

describe("verify - wrong chain is a digest mismatch, not a field compare", () => {
  it("produces a different digest when the seller's chain id differs", async () => {
    const { envelope, digest } = await realEnvelope();
    // Same permit, verified by a seller configured for BNB mainnet.
    const otherChainDigest = recomputePermit2Digest({
      permit: envelope.permit,
      witness: envelope.permit.witness!,
      chainId: 56,
    });
    expect(otherChainDigest).not.toBe(digest);
  });

  it("fails verification when the buyer signed for another chain", async () => {
    // The buyer signs for chain 56; the seller is configured for 97 and so
    // recomputes a digest the account would never have signed. There is no
    // chainId field on the wire to compare — the crypto is the check.
    const { envelope, digest } = await realEnvelope({
      requirement: requirement({ chainId: 56, network: "bsc" }),
    });
    const seen: Hex[] = [];
    const res = await verifyEnvelope(
      baseInput(envelope),
      async ({ hash }) => {
        seen.push(hash);
        // A real account rejects a digest it never signed.
        return hash === digest ? IS_VALID_SIGNATURE_MAGIC : ("0x" as Hex);
      },
      testClock,
    );
    expect(seen[0]).not.toBe(digest);
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
    }
  });
});
