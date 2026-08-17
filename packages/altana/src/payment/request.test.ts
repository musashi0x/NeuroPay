/**
 * Tests for the request layer (the fetch wrapper).
 *
 * The contract:
 *  - Non-402 responses pass through untouched (no signature produced).
 *  - 402 bodies are parsed, selected, signed, and the retry carries
 *    both `X-PAYMENT` and `PAYMENT-SIGNATURE` headers with the same
 *    base64 envelope.
 *  - A merchant rejection that matches the EOA-only-facilitator
 *    patterns is re-classified, not reported as a generic
 *    verification failure.
 *  - A merchant rejection whose body text doesn't match is reported
 *    as `verification-failed`.
 *  - A 402 body that doesn't parse is a `verification-failed` failure.
 *
 * The SDK is mocked because the real `signX402Payment` requires a
 * live session key. We mock the SDK module's `signX402Payment` so
 * `signX402PaymentFor` runs end-to-end against the mocked shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Note: select.ts imports PaymentFailureError from `./errors.js` for
// re-export, but the runtime path is via the module. The mock above
// affects only the SDK, so the public API surface is unchanged.

import {
  fetchWithX402,
  normalizePaymentRequired,
  parsePaymentRequired,
} from "./request.js";
import { PaymentFailureError } from "./errors.js";
import {
  HEALTHY_BUDGET,
  PAYMENT_REQUIRED_BODY,
  PERMITTED_TOKEN,
  WALLET_ADDRESS,
  makeSession,
} from "./__fixtures__/index.js";

const URL = "https://example.com/api/data";

const happyContext = {
  payment: {
    session: makeSession(),
    walletAddress: WALLET_ADDRESS,
    chainId: 56,
    permittedTokens: new Set([PERMITTED_TOKEN]),
    budget: HEALTHY_BUDGET,
    tolerance: 0,
    railProvisioned: true,
    // 2100-01-01 — far enough in the future that the session is alive
    // regardless of the wall clock the test runs under. The dedicated
    // session-expired test below overrides this with a past timestamp.
    expiresAt: 4_102_444_800,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a `Response` shape from a body and status. */
function makeResponse(body: unknown, status: number): Response {
  const text =
    typeof body === "string"
      ? body
      : JSON.stringify(body, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchWithX402 — pass-through", () => {
  it("returns a 200 response untouched, with no payment", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ data: "ok" }, 200));
    const result = await fetchWithX402(URL, {
      ...happyContext,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.payment).toBeUndefined();
    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a 404 unchanged (no signature produced)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse("not found", 404));
    const result = await fetchWithX402(URL, {
      ...happyContext,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.payment).toBeUndefined();
    expect(result.response.status).toBe(404);
  });
});

describe("fetchWithX402 — 402 happy path", () => {
  it("pays a 402, retries with both X-PAYMENT and PAYMENT-SIGNATURE, returns the retry response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(PAYMENT_REQUIRED_BODY, 402))
      .mockResolvedValueOnce(makeResponse({ ok: true }, 200));

    const result = await fetchWithX402(URL, {
      ...happyContext,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The retry was made.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryCall = fetchImpl.mock.calls[1]!;
    const retryInit = retryCall[1] as RequestInit;
    const headers = retryInit.headers as Headers;
    expect(headers.get("X-PAYMENT")).toBeTruthy();
    expect(headers.get("PAYMENT-SIGNATURE")).toBeTruthy();
    // Same base64 envelope under both headers.
    expect(headers.get("X-PAYMENT")).toBe(headers.get("PAYMENT-SIGNATURE"));

    // The result carries the retry response and the payment metadata.
    expect(result.response.status).toBe(200);
    expect(result.payment).toBeDefined();
    expect(result.payment?.requirement).toBeDefined();
    expect(result.payment?.header).toBe(headers.get("X-PAYMENT"));
  });
});

describe("fetchWithX402 — 4xx re-classification", () => {
  it("re-throws as eoa-only-facilitator when the merchant body matches ecrecover patterns", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(PAYMENT_REQUIRED_BODY, 402))
      .mockResolvedValueOnce(
        makeResponse("ecrecover: invalid signature length", 400),
      );

    try {
      await fetchWithX402(URL, {
        ...happyContext,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "eoa-only-facilitator",
      );
    }
  });

  it("re-throws as verification-failed when the 4xx body is not an EOA-only pattern", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(PAYMENT_REQUIRED_BODY, 402))
      .mockResolvedValueOnce(makeResponse("payment rejected", 402));

    try {
      await fetchWithX402(URL, {
        ...happyContext,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "verification-failed",
      );
    }
  });
});

describe("fetchWithX402 — 402 body parsing", () => {
  it("classification verification-failed when the body is not JSON", async () => {
    const response = new Response("not json {", { status: 402 });
    try {
      await parsePaymentRequired(response);
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "verification-failed",
      );
    }
  });

  it("classification verification-failed when x402Version is missing", () => {
    try {
      normalizePaymentRequired({ accepts: [] });
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "verification-failed",
      );
    }
  });

  it("classification verification-failed when accepts is not an array", () => {
    try {
      normalizePaymentRequired({ x402Version: 2, accepts: "not-an-array" });
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "verification-failed",
      );
    }
  });

  it("normalizes a valid 402 body", () => {
    const out = normalizePaymentRequired(PAYMENT_REQUIRED_BODY);
    expect(out.x402Version).toBe(2);
    expect(out.accepts).toHaveLength(1);
    expect(out.error).toBeNull();
  });
});

describe("fetchWithX402 — policy runs before signing", () => {
  it("does NOT sign when the session is expired", async () => {
    const { signX402Payment } = await import("@altananetwork/sdk");
    const fetchImpl = vi.fn(async () =>
      makeResponse(PAYMENT_REQUIRED_BODY, 402),
    );

    try {
      await fetchWithX402(URL, {
        ...happyContext,
        payment: {
          ...happyContext.payment,
          expiresAt: 1_500_000_000, // long past
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect.fail("expected PaymentFailureError");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentFailureError);
      expect((err as PaymentFailureError).classification).toBe(
        "session-expired",
      );
    }

    // The SDK's signX402Payment was never called — the policy refused
    // before signing. (fetchImpl was called once for the initial 402.)
    expect(signX402Payment).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
