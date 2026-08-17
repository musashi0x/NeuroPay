/**
 * Tests for the signing wrapper.
 *
 * The contract:
 *  - The signed envelope is the 98-byte nested ERC-1271 envelope, NOT
 *    a 65-byte EOA signature.
 *  - The envelope is the b402 dialect (both `permit + from` and
 *    `permit2Authorization` with nested `from`).
 *  - The SDK's `signX402Payment` is the actual signer; this module
 *    just wires inputs and re-encodes the output.
 *
 * The SDK is mocked because the real `signX402Payment` requires a
 * live session key. The mock returns the canonical 98-byte envelope
 * the SDK is expected to produce, so the test asserts on the
 * wrapper's wiring — not on the SDK's parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK before importing the module under test. The mock
// returns a payload whose `payload.signature` is the 98-byte nested
// ERC-1271 envelope — the same shape the real SDK produces.
vi.mock("@altananetwork/sdk", () => ({
  signX402Payment: vi.fn(async () => ({
    header: "sdk-encoded-base64",
    payload: {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      accepted: {},
      resource: { url: "https://example.com/api/data" },
      payload: {
        signature:
          "0xa1b2" +
          "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff" +
          "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" +
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      },
    },
  })),
}));

import { signX402PaymentFor } from "./sign.js";
import {
  NESTED_ERC1271_BYTES,
  PERMIT2_REQUIREMENT,
  WALLET_ADDRESS,
  makeSession,
} from "./__fixtures__/index.js";

const REQ = PERMIT2_REQUIREMENT;
const URL = "https://example.com/api/data";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signX402PaymentFor — b402 envelope wiring", () => {
  it("produces a header carrying the SDK's 98-byte envelope", async () => {
    const result = await signX402PaymentFor({
      session: makeSession(),
      requirement: REQ,
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });

    expect(result.header).toBeTruthy();
    // The base64 header decodes to JSON; the signature survives in
    // decoded.payload. We don't re-stringify at this layer — the
    // b402 dialect is in the `envelope` field.
    expect(result.envelope).toBeDefined();
  });

  it("the encoded envelope is the 98-byte nested ERC-1271 envelope, NOT a 65-byte EOA signature", async () => {
    const result = await signX402PaymentFor({
      session: REQ ? makeSession() : makeSession(),
      requirement: REQ,
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });

    const sig = result.envelope.decoded.payload.permit.signature;
    expect(sig.startsWith("0x")).toBe(true);
    const hexLen = (sig.length - 2) / 2;
    // The 98-byte envelope is the whole point of the b402 dialect:
    // a 65-byte EOA signature would decode to garbage via ecrecover.
    expect(hexLen).toBe(NESTED_ERC1271_BYTES);
    expect(hexLen).not.toBe(65);
  });

  it("emits both permit.from and permit2Authorization.from with the same signature", async () => {
    const result = await signX402PaymentFor({
      session: makeSession(),
      requirement: REQ,
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });

    const p = result.envelope.decoded.payload.permit;
    const p2 = result.envelope.decoded.payload.permit2Authorization;
    expect(p.from).toBe(WALLET_ADDRESS);
    expect(p2.from).toBe(WALLET_ADDRESS);
    expect(p.signature).toBe(p2.signature);
  });

  it("the resource is normalized (never null)", async () => {
    const result = await signX402PaymentFor({
      session: makeSession(),
      requirement: { ...REQ, resource: "" },
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });
    expect(result.envelope.decoded.resource.url).toBe(URL);
  });

  it("passes rail, network, and asset through to the SDK", async () => {
    const { signX402Payment } = await import("@altananetwork/sdk");
    await signX402PaymentFor({
      session: makeSession(),
      requirement: REQ,
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
      now: 1_700_000_000,
      permit2Nonce: 12345n,
    });

    expect(signX402Payment).toHaveBeenCalledTimes(1);
    const args = (signX402Payment as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // args[1] is the SDK requirement shape.
    const sdkReq = args[1];
    expect(sdkReq.scheme).toBe("exact");
    expect(sdkReq.network).toBe(REQ.network);
    expect(sdkReq.asset).toBe(REQ.asset);
    expect(sdkReq.extra.assetTransferMethod).toBe("permit2-exact");
    expect(sdkReq.extra.spenderAddress).toBe(REQ.payTo);
    // args[2] is the sign options.
    expect(args[2]!.now).toBe(1_700_000_000);
    expect(args[2]!.permit2Nonce).toBe(12345n);
  });

  it("selects eip3009 assetTransferMethod when the rail is eip3009", async () => {
    const { signX402Payment } = await import("@altananetwork/sdk");
    await signX402PaymentFor({
      session: makeSession(),
      requirement: { ...REQ, rail: "eip3009" },
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });

    const args = (signX402Payment as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1].extra.assetTransferMethod).toBe("eip3009");
    // eip3009 doesn't carry a spenderAddress.
    expect(args[1].extra.spenderAddress).toBeUndefined();
  });

  it("returns the SDK payload alongside the envelope for re-classification", async () => {
    const result = await signX402PaymentFor({
      session: makeSession(),
      requirement: REQ,
      resourceUrl: URL,
      payerAddress: WALLET_ADDRESS,
    });
    expect(result.payload).toBeDefined();
    expect(result.payload.x402Version).toBe(2);
    expect(result.payload.scheme).toBe("exact");
  });
});
