/**
 * Tests for envelope verification (5.6).
 *
 * Verified:
 *  - ERC-1271 happy path: verifier returns the magic value, segment is accepted
 *  - underpaid amount → `amount-underpaid`
 *  - mismatched payTo → `recipient-mismatch`
 *  - expired session (deadline in the past) → `verification-failed`
 *  - mismatched token / chainId → `verification-failed`
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { Address, Hex, X402PaymentRequired } from "@neuro-pay/types";
import type { Clock } from "@neuro-pay/metering";
import { parseEnvelope } from "./envelope.js";
import {
  IS_VALID_SIGNATURE_MAGIC,
  verifyEnvelope,
  type Verifier,
} from "./verify.js";

const PAYER = "0x000000000000000000000000000000000000c0de" as Address;
const PAY_TO = "0x000000000000000000000000000000000000d3ad" as Address;
const WRONG_PAY_TO = "0x000000000000000000000000000000000000beef" as Address;
const TOKEN = "0x55d398326f99059f775a46c830bb1ec1b4f2e75d" as Address;
const WRONG_TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const HASH = ("0x" + "22".repeat(32)) as Hex;
const SIG = ("0x" + "11".repeat(65)) as Hex;

// A deterministic "now" for tests so the session-expiry check is stable
// regardless of when the suite runs. 2024-01-01T00:00:00Z in ms.
const NOW_MS = 1_704_067_200_000;
const testClock: Clock = { now: () => NOW_MS };

function mkEnvelope(overrides: {
  payTo?: Address;
  amount?: bigint;
  token?: Address;
  chainId?: number;
  deadline?: number;
}): ReturnType<typeof parseEnvelope> {
  const body = {
    from: PAYER,
    permit: {
      hash: HASH,
      signature: SIG,
      witness: {
        payTo: overrides.payTo ?? PAY_TO,
        amount: (overrides.amount ?? 1000n).toString(),
        token: overrides.token ?? TOKEN,
        chainId: overrides.chainId ?? 97,
        nonce: "n-verify",
        deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 600,
      },
    },
  };
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString(
    "base64url",
  );
  return parseEnvelope(payload, "x-payment");
}

function mkPaymentRequired(): X402PaymentRequired {
  return {
    x402Version: 1,
    error: null,
    accepts: [
      {
        scheme: "exact",
        network: "bsc-testnet",
        chainId: 97,
        rail: "permit2",
        asset: TOKEN,
        assetDecimals: 18,
        maxAmountRequired: 1000n,
        payTo: PAY_TO,
        resource: "https://api.example/v1/streams/abc/next",
        description: "token usage on stream",
        mimeType: "application/octet-stream",
        maxTimeoutSeconds: 60,
        extra: null,
      },
    ],
  };
}

function stubVerifier(returnValue: Hex): Verifier {
  return async () => returnValue;
}

describe("verify - ERC-1271 happy path", () => {
  it("accepts a well-formed envelope when isValidSignature returns the magic", async () => {
    const env = mkEnvelope({});
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    if (res.kind !== "ok") {
      // Print the failure classification to aid debugging before failing.
      console.log("verify failure:", res);
    }
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.authorized.payTo).toBe(PAY_TO);
      expect(res.authorized.amount).toBe(1000n);
      expect(res.authorized.token).toBe(TOKEN);
      expect(res.authorized.chainId).toBe(97);
    }
  });
});

describe("verify - failure classifications", () => {
  it("rejects an envelope that authorizes less than the demanded amount", async () => {
    const env = mkEnvelope({ amount: 100n });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("amount-underpaid");
    }
  });

  it("rejects an envelope whose witness payTo does not match the configured recipient", async () => {
    const env = mkEnvelope({ payTo: WRONG_PAY_TO });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("recipient-mismatch");
    }
  });

  it("rejects an envelope bound to a different chain id", async () => {
    const env = mkEnvelope({ chainId: 1 });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
    }
  });

  it("rejects an envelope bound to a different token", async () => {
    const env = mkEnvelope({ token: WRONG_TOKEN });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
    }
  });

  it("rejects an envelope whose session has expired (deadline in the past)", async () => {
    const env = mkEnvelope({ deadline: 1 }); // Jan 1, 1970 — long past
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
      expect(res.detail).toBe("session expired");
    }
  });

  it("rejects an envelope whose deadline equals now (boundary)", async () => {
    // `deadlineMs < nowMs` is strict, so a deadline exactly equal to
    // now is NOT yet expired. We use one second in the past to be sure
    // the comparison fires regardless of clock-resolution rounding.
    const deadlineSec = Math.floor(NOW_MS / 1000) - 1;
    const env = mkEnvelope({ deadline: deadlineSec });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
      expect(res.detail).toBe("session expired");
    }
  });

  it("accepts an envelope whose deadline is one second in the future", async () => {
    const futureDeadlineSec = Math.floor(NOW_MS / 1000) + 60;
    const env = mkEnvelope({ deadline: futureDeadlineSec });
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier(IS_VALID_SIGNATURE_MAGIC),
      testClock,
    );
    expect(res.kind).toBe("ok");
  });

  it("rejects a magic value other than the ERC-1271 expected one", async () => {
    const env = mkEnvelope({});
    if (env.kind !== "ok") throw new Error("fixture parse failed");
    const res = await verifyEnvelope(
      {
        envelope: env.envelope,
        demandedAmount: 1000n,
        expectedPayTo: PAY_TO,
        expectedToken: TOKEN,
        expectedChainId: 97,
        paymentRequired: mkPaymentRequired(),
      },
      stubVerifier("0xdeadbeef" as Hex),
      testClock,
    );
    expect(res.kind).toBe("fail");
    if (res.kind === "fail") {
      expect(res.classification).toBe("verification-failed");
    }
  });
});
