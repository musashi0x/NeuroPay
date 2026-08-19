/**
 * Tests for envelope parsing (5.5).
 *
 * Verified:
 *  - either `X-PAYMENT` or `PAYMENT-SIGNATURE` is accepted
 *  - both Permit2 dialects (`permit.from` and `permit2Authorization`) parse
 *  - malformed envelopes classify cleanly without throwing
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { Address } from "@neuro-pay/types";
import {
  extractEnvelope,
  parseEnvelope,
  parseEnvelopeFromHeaders,
} from "./envelope.js";

const FROM = "0x000000000000000000000000000000000000c0de" as Address;
const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const SIGNATURE = ("0x" + "11".repeat(65)) as `0x${string}`;
const HASH = ("0x" + "22".repeat(32)) as `0x${string}`;

function makeEnvelope(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

class HeaderBag {
  private readonly m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.m.get(name.toLowerCase()) ?? null;
  }
}

describe("envelope - X-PAYMENT / PAYMENT-SIGNATURE discrimination", () => {
  it("reads X-PAYMENT when present", () => {
    const payload = makeEnvelope({
      from: FROM,
      permit: { hash: HASH, signature: SIGNATURE, witness: {} },
    });
    const headers = new HeaderBag({ "X-PAYMENT": payload });
    const picked = extractEnvelope(headers);
    expect(picked.kind).toBe("ok");
    if (picked.kind === "ok") expect(picked.header).toBe("x-payment");
  });

  it("reads PAYMENT-SIGNATURE when X-PAYMENT is absent", () => {
    const payload = makeEnvelope({
      from: FROM,
      permit: { hash: HASH, signature: SIGNATURE, witness: {} },
    });
    const headers = new HeaderBag({ "PAYMENT-SIGNATURE": payload });
    const picked = extractEnvelope(headers);
    expect(picked.kind).toBe("ok");
    if (picked.kind === "ok") expect(picked.header).toBe("payment-signature");
  });

  it("returns 'multiple' when both headers are populated", () => {
    const payload = makeEnvelope({
      from: FROM,
      permit: { hash: HASH, signature: SIGNATURE },
    });
    const headers = new HeaderBag({
      "X-PAYMENT": payload,
      "PAYMENT-SIGNATURE": payload,
    });
    const picked = extractEnvelope(headers);
    expect(picked.kind).toBe("multiple");
  });

  it("returns 'missing' when no header carries the envelope", () => {
    const headers = new HeaderBag();
    const picked = extractEnvelope(headers);
    expect(picked.kind).toBe("missing");
  });
});

describe("envelope - permit.from dialect", () => {
  it("parses canonical {from, permit} shape", () => {
    const body = {
      from: FROM,
      permit: {
        hash: HASH,
        signature: SIGNATURE,
        witness: { payTo: PAY_TO, amount: "1000", token: TOKEN, chainId: 97 },
        nonce: "n1",
      },
    };
    const payload = makeEnvelope(body);
    const headers = new HeaderBag({ "X-PAYMENT": payload });
    const res = parseEnvelopeFromHeaders(headers);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.envelope.from).toBe(FROM);
    expect(res.envelope.signature).toBe(SIGNATURE);
    expect(res.envelope.nonce).toBe("n1");
  });

  it("falls back to witness.nonce when permit.nonce is absent", () => {
    const body = {
      from: FROM,
      permit: {
        hash: HASH,
        signature: SIGNATURE,
        witness: {
          payTo: PAY_TO,
          amount: "1000",
          token: TOKEN,
          chainId: 97,
          nonce: "witness-n",
        },
      },
    };
    const res = parseEnvelopeFromHeaders(
      new HeaderBag({ "X-PAYMENT": makeEnvelope(body) }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.envelope.nonce).toBe("witness-n");
  });
});

describe("envelope - permit2Authorization dialect", () => {
  it("parses the older {permit2Authorization: {from, permit}} shape", () => {
    const body = {
      permit2Authorization: {
        from: FROM,
        permit: {
          hash: HASH,
          signature: SIGNATURE,
          witness: { payTo: PAY_TO, amount: "2000", token: TOKEN, chainId: 97 },
        },
      },
    };
    const payload = makeEnvelope(body);
    const headers = new HeaderBag({ "X-PAYMENT": payload });
    const res = parseEnvelopeFromHeaders(headers);
    if (res.kind !== "ok") {
      console.log("p2a parse err:", JSON.stringify(res));
    }
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.envelope.from).toBe(FROM);
    expect(res.envelope.signature).toBe(SIGNATURE);
  });

  it("parses PAYMENT-SIGNATURE carrying the permit2Authorization dialect", () => {
    const body = {
      permit2Authorization: {
        from: FROM,
        permit: {
          hash: HASH,
          signature: SIGNATURE,
          witness: { payTo: PAY_TO, amount: "1", token: TOKEN, chainId: 97 },
        },
      },
    };
    const payload = makeEnvelope(body);
    const headers = new HeaderBag({ "PAYMENT-SIGNATURE": payload });
    const res = parseEnvelopeFromHeaders(headers);
    expect(res.kind).toBe("ok");
  });
});

describe("envelope - classification of malformed inputs", () => {
  it("flags an envelope with no signature", () => {
    const body = { from: FROM, permit: { hash: HASH } };
    const res = parseEnvelope(makeEnvelope(body), "x-payment");
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("missing-signature");
  });

  it("flags an envelope with no from and no permit", () => {
    const body = {};
    const res = parseEnvelope(makeEnvelope(body), "x-payment");
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("missing-from");
  });

  it("flags malformed base64", () => {
    const res = parseEnvelope("!!!not-base64!!!@#$", "x-payment");
    expect(res.kind).toBe("err");
    if (res.kind === "err") {
      // Either malformed-base64 or malformed-json depending on the platform's
      // tolerant base64 decoder; both are valid classifications.
      expect(["malformed-base64", "malformed-json"]).toContain(res.error.kind);
    }
  });
});
