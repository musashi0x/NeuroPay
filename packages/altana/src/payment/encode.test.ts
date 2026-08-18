/**
 * Tests for the b402 dialect envelope encoder.
 *
 * The contract per the spec "b402 wire compatibility":
 *  - Both `permit + from` and `permit2Authorization` with nested `from`
 *    are emitted from a single signature.
 *  - The `resource` field is never null and falls back to the URL.
 *  - The header is base64-encoded JSON, decodable round-trip.
 */
import { describe, expect, it } from "vitest";
import {
  PERMIT2_REQUIREMENT,
  SIGNED_SDK_PAYLOAD,
  WALLET_ADDRESS,
} from "./__fixtures__/index.js";
import {
  base64JsonDecode,
  base64JsonEncode,
  encodeB402Envelope,
} from "./encode.js";

const PAYLOAD = SIGNED_SDK_PAYLOAD;
const REQ = PERMIT2_REQUIREMENT;
const RESOURCE_URL = "https://example.com/api/data";

describe("encodeB402Envelope — b402 dialect shape", () => {
  it("emits BOTH permit.from and permit2Authorization.from with the same signature", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );

    expect(env.decoded.payload.permit.from).toBe(WALLET_ADDRESS);
    expect(env.decoded.payload.permit2Authorization.from).toBe(WALLET_ADDRESS);
    expect(env.decoded.payload.permit.signature).toBe(
      env.decoded.payload.permit2Authorization.signature,
    );
  });

  it("carries the signature on the nested payload.signature field too", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.decoded.payload.signature).toBe(
      env.decoded.payload.permit.signature,
    );
  });

  it("sets the top-level from to the payer address", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.decoded.payload.from).toBe(WALLET_ADDRESS);
  });
});

describe("encodeB402Envelope — resource normalization", () => {
  it("uses the requirement's resource when present and non-empty", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.decoded.resource).toEqual({ url: REQ.resource });
  });

  it("falls back to the request URL when the requirement's resource is empty", () => {
    const req = { ...REQ, resource: "" };
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: req, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.decoded.resource).toEqual({ url: RESOURCE_URL });
  });

  it("resource is never null", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.decoded.resource).not.toBeNull();
    expect(env.decoded.resource.url).toBeTruthy();
  });
});

describe("encodeB402Envelope — header encoding", () => {
  it("produces a non-empty base64 header", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    expect(env.header).toBeTruthy();
    expect(env.header.length).toBeGreaterThan(0);
  });

  it("header round-trips back to the decoded envelope", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    const decoded = base64JsonDecode<{
      payload: {
        permit: { from: string; signature: string };
        permit2Authorization: { from: string; signature: string };
      };
      resource: { url: string };
    }>(env.header);
    expect(decoded.payload.permit.from).toBe(WALLET_ADDRESS);
    expect(decoded.payload.permit2Authorization.from).toBe(WALLET_ADDRESS);
    expect(decoded.resource.url).toBe(REQ.resource);
  });

  it("preserves the 98-byte envelope signature through encoding", () => {
    const env = encodeB402Envelope(
      { signedPayload: PAYLOAD, requirement: REQ, resourceUrl: RESOURCE_URL },
      WALLET_ADDRESS,
    );
    const sig = env.decoded.payload.permit.signature;
    // The base64 envelope carries the 98-byte hex signature, so the
    // "x402 merchant receives a 98-byte envelope" assertion is
    // verifiable by sampling the decoded payload.
    expect(sig.startsWith("0x")).toBe(true);
    const hexLen = (sig.length - 2) / 2;
    expect(hexLen).toBe(98);
  });
});

describe("base64JsonEncode / base64JsonDecode", () => {
  it("round-trips an object", () => {
    const obj = { a: 1, b: "two", c: [3, 4], d: { e: 5 } };
    const encoded = base64JsonEncode(obj);
    const decoded = base64JsonDecode(encoded);
    expect(decoded).toEqual(obj);
  });

  it("handles unicode safely", () => {
    const obj = { greeting: "héllo 👋" };
    const encoded = base64JsonEncode(obj);
    expect(base64JsonDecode(encoded)).toEqual(obj);
  });
});

describe("encodeB402Envelope — defensive", () => {
  it("throws when the SDK payload is missing a signature", () => {
    const payload = {
      ...PAYLOAD,
      payload: { ...PAYLOAD.payload },
    };
    delete (payload.payload as Record<string, unknown>)["signature"];
    expect(() =>
      encodeB402Envelope(
        { signedPayload: payload, requirement: REQ, resourceUrl: RESOURCE_URL },
        WALLET_ADDRESS,
      ),
    ).toThrowError(/missing a signature/);
  });

  it("throws when the signature is an empty string", () => {
    const payload = {
      ...PAYLOAD,
      payload: { ...PAYLOAD.payload, signature: "" },
    };
    expect(() =>
      encodeB402Envelope(
        { signedPayload: payload, requirement: REQ, resourceUrl: RESOURCE_URL },
        WALLET_ADDRESS,
      ),
    ).toThrowError(/missing a signature/);
  });
});
