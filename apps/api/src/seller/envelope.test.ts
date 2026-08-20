/**
 * Tests for envelope parsing (5.5).
 *
 * The parsing tests run against a **real** `signX402Payment` envelope.
 * The previous suite asserted a shape nobody produces — top-level `from`,
 * a `permit.hash`, a flat witness carrying `payTo`/`token`/`chainId` — and
 * every one of those assumptions was wrong on the wire.
 *
 * Verified:
 *  - either `X-PAYMENT` or `PAYMENT-SIGNATURE` is accepted; identical
 *    payloads on both are not an ambiguity, differing ones are
 *  - the real SDK envelope parses, with the whole Permit2 struct intact
 *  - the `permit2Authorization` sibling parses on its own
 *  - a flattened (non-SDK) envelope still parses
 *  - malformed envelopes classify cleanly without throwing
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { Address } from "@neuro-pay/types";
import {
  extractEnvelope,
  parseEnvelope,
  parseEnvelopeFromHeaders,
  permitBindings,
} from "./envelope.js";
import {
  PAY_TO,
  SETTLER,
  TOKEN,
  headersFor,
  signRealEnvelope,
} from "./__fixtures__/real-envelope.js";

const FROM = "0x000000000000000000000000000000000000c0de" as Address;
const SIGNATURE = ("0x" + "11".repeat(65)) as `0x${string}`;
const NOW_SECONDS = 1_704_067_200;

function makeEnvelope(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** A minimal hand-built permit, for the malformed-input cases only. */
function permitBody(overrides: Record<string, unknown> = {}) {
  return {
    permitted: { token: TOKEN, amount: "1000" },
    spender: SETTLER,
    nonce: "424242",
    deadline: "1704070800",
    witness: { to: PAY_TO, validAfter: "0" },
    ...overrides,
  };
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
  it("reads X-PAYMENT when present", async () => {
    const { header } = await signRealEnvelope({ now: NOW_SECONDS });
    const picked = extractEnvelope(new HeaderBag({ "X-PAYMENT": header }));
    expect(picked.kind).toBe("ok");
    if (picked.kind === "ok") expect(picked.header).toBe("x-payment");
  });

  it("reads PAYMENT-SIGNATURE when X-PAYMENT is absent", async () => {
    const { header } = await signRealEnvelope({ now: NOW_SECONDS });
    const picked = extractEnvelope(
      new HeaderBag({ "PAYMENT-SIGNATURE": header }),
    );
    expect(picked.kind).toBe("ok");
    if (picked.kind === "ok") expect(picked.header).toBe("payment-signature");
  });

  it("accepts both headers when they carry the identical payload — the compliant b402 buyer sends both for facilitator compatibility", async () => {
    const { header } = await signRealEnvelope({ now: NOW_SECONDS });
    const picked = extractEnvelope(
      new HeaderBag({ "X-PAYMENT": header, "PAYMENT-SIGNATURE": header }),
    );
    expect(picked.kind).toBe("ok");
    if (picked.kind === "ok") {
      expect(picked.header).toBe("x-payment");
      expect(picked.payload).toBe(header);
    }
  });

  it("returns 'multiple' when both headers carry different payloads", async () => {
    const a = await signRealEnvelope({ now: NOW_SECONDS });
    const b = await signRealEnvelope({ now: NOW_SECONDS, permit2Nonce: 7n });
    const picked = extractEnvelope(
      new HeaderBag({ "X-PAYMENT": a.header, "PAYMENT-SIGNATURE": b.header }),
    );
    expect(picked.kind).toBe("multiple");
  });

  it("returns 'missing' when no header carries the envelope", () => {
    expect(extractEnvelope(new HeaderBag()).kind).toBe("missing");
  });
});

describe("envelope - the real SDK wire shape", () => {
  it("parses a real signed envelope with the whole Permit2 struct intact", async () => {
    const signed = await signRealEnvelope({ now: NOW_SECONDS });
    const res = parseEnvelopeFromHeaders(headersFor(signed.header));
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    const { envelope } = res;
    expect(envelope.from).toBe(signed.payer);
    expect(envelope.signature).toBe(signed.signature);
    expect(envelope.nonce).toBe(signed.nonce);
    expect(envelope.permit.permitted.token).toBe(TOKEN);
    expect(envelope.permit.permitted.amount).toBe(1000n);
    expect(envelope.permit.spender).toBe(SETTLER);
    expect(envelope.permit.deadline).toBe(signed.deadline);
    expect(envelope.permit.witness).toEqual({ to: PAY_TO, validAfter: "0" });
  });

  it("carries a 98-byte nested ERC-1271 signature, not a 65-byte EOA one", async () => {
    const signed = await signRealEnvelope({ now: NOW_SECONDS });
    const res = parseEnvelope(signed.header, "x-payment");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect((res.envelope.signature.length - 2) / 2).toBe(98);
  });

  it("reads bindings from where the wire actually puts them", async () => {
    const signed = await signRealEnvelope({ now: NOW_SECONDS });
    const res = parseEnvelope(signed.header, "x-payment");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // payTo comes from witness.to; token/amount from permit.permitted.
    expect(permitBindings(res.envelope.permit)).toEqual({
      payTo: PAY_TO,
      amount: 1000n,
      token: TOKEN,
      nonce: signed.nonce,
      deadline: signed.deadline,
    });
  });

  it("parses the permit2Authorization sibling on its own", async () => {
    const signed = await signRealEnvelope({ now: NOW_SECONDS });
    const raw = JSON.parse(
      Buffer.from(signed.header, "base64").toString("utf8"),
    ) as { payload: Record<string, unknown> };
    // A merchant dialect that ships only the canonical b402 key.
    delete raw.payload["permit"];
    const res = parseEnvelope(makeEnvelope(raw), "x-payment");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.envelope.permit.spender).toBe(SETTLER);
    expect(res.envelope.signature).toBe(signed.signature);
  });

  it("parses a flattened envelope from a non-SDK buyer", () => {
    const res = parseEnvelope(
      makeEnvelope({ from: FROM, signature: SIGNATURE, permit: permitBody() }),
      "x-payment",
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.envelope.from).toBe(FROM);
    expect(res.envelope.permit.spender).toBe(SETTLER);
  });

  it("normalizes a hex nonce to the same decimal key as its decimal spelling", () => {
    const hex = parseEnvelope(
      makeEnvelope({
        from: FROM,
        signature: SIGNATURE,
        permit: permitBody({ nonce: "0x1e240" }),
      }),
      "x-payment",
    );
    const dec = parseEnvelope(
      makeEnvelope({
        from: FROM,
        signature: SIGNATURE,
        permit: permitBody({ nonce: "123456" }),
      }),
      "x-payment",
    );
    expect(hex.kind).toBe("ok");
    expect(dec.kind).toBe("ok");
    if (hex.kind !== "ok" || dec.kind !== "ok") return;
    expect(hex.envelope.nonce).toBe(dec.envelope.nonce);
  });
});

describe("envelope - classification of malformed inputs", () => {
  it("flags an envelope with no signature", () => {
    const res = parseEnvelope(
      makeEnvelope({ from: FROM, permit: permitBody() }),
      "x-payment",
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("missing-signature");
  });

  it("flags an envelope with no from and no permit", () => {
    const res = parseEnvelope(makeEnvelope({}), "x-payment");
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("missing-from");
  });

  it("flags a from with no permit", () => {
    const res = parseEnvelope(makeEnvelope({ from: FROM }), "x-payment");
    expect(res.kind).toBe("err");
    if (res.kind === "err") expect(res.error.kind).toBe("missing-permit");
  });

  it("flags a permit missing its permitted token/amount pair", () => {
    const permit = permitBody();
    delete (permit as Record<string, unknown>)["permitted"];
    const res = parseEnvelope(
      makeEnvelope({ from: FROM, signature: SIGNATURE, permit }),
      "x-payment",
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") {
      expect(res.error.kind).toBe("malformed-permit");
      if (res.error.kind !== "malformed-permit") return;
      expect(res.error.cause).toContain("permitted");
    }
  });

  it("flags a permit missing its spender", () => {
    const permit = permitBody();
    delete (permit as Record<string, unknown>)["spender"];
    const res = parseEnvelope(
      makeEnvelope({ from: FROM, signature: SIGNATURE, permit }),
      "x-payment",
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") {
      expect(res.error.kind).toBe("malformed-permit");
      if (res.error.kind !== "malformed-permit") return;
      expect(res.error.cause).toContain("spender");
    }
  });

  it("flags a permit whose deadline would lose precision as a number", () => {
    const res = parseEnvelope(
      makeEnvelope({
        from: FROM,
        signature: SIGNATURE,
        permit: permitBody({ nonce: "1", deadline: (2n ** 200n).toString(10) }),
      }),
      "x-payment",
    );
    expect(res.kind).toBe("err");
    if (res.kind === "err") {
      expect(res.error.kind).toBe("malformed-permit");
      if (res.error.kind !== "malformed-permit") return;
      expect(res.error.cause).toContain("deadline");
    }
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
