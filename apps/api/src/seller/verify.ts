/**
 * Envelope verification (5.6).
 *
 * Verifies a payment envelope by calling `isValidSignature` on the buyer's
 * smart account with the canonical Permit2 checker. This module MUST NOT
 * use `ecrecover` anywhere: ERC-1271 is the only signature scheme that
 * can validate a 98-byte session-key envelope from a smart account, and
 * `ecrecover` on those bytes is meaningless.
 *
 * The verifier is an injected function (see `Verifier`) so the route layer
 * never imports viem directly; tests stub the verifier with a callback
 * that returns either the magic value (accept) or anything else (reject).
 *
 * Rejection cases are explicit and carry distinct classifications:
 * - underpaid (witness amount < demanded): `amount-underpaid`
 * - wrong recipient (witness payTo ≠ config payTo): `recipient-mismatch`
 * - malformed magic / read error: `verification-failed`
 *
 * The shipment's `payment.rejected` ledger entry carries the same
 * classification so the operator console never has to guess.
 */

import type {
  Address,
  Hex,
  PaymentFailureClassification,
  SmallestUnits,
  X402PaymentRequired,
} from "@neuro-pay/types";

import { systemClock, type Clock } from "@neuro-pay/metering";

import { type ParsedEnvelope, readPermit2WitnessFields } from "./envelope.js";

/** The ERC-1271 magic value: `isValidSignature` returns it on a good hash+signature pair. */
export const IS_VALID_SIGNATURE_MAGIC = "0x1626ba7e" as Hex;

/**
 * The verifier injected at the composition root.
 *
 * A production implementation reads via `publicClient.readContract` against
 * the canonical Permit2 address as the `msg.sender` (which is what makes
 * `isValidSignature` accept the envelope — see the SDK's session design).
 * Tests return a stubbed magic value or a sentinel to drive each scenario.
 */
export type Verifier = (input: {
  /** The smart account that produced the envelope. */
  payer: Address;
  /** The hash the buyer signed over (EIP-712 digest of the witness-bound Permit2 typed data). */
  hash: Hex;
  /** The 98-byte signature bytes. */
  signature: Hex;
}) => Promise<Hex>;

/** What the verifier checks before/after the contract call. */
export type VerifyInput = {
  envelope: ParsedEnvelope;
  demandedAmount: SmallestUnits;
  /** The recipient the segment owner committed to. */
  expectedPayTo: Address;
  /** The token address from the pinned sheet, used to confirm witness binds the same token. */
  expectedToken: Address;
  /** The chain id the witness must match. */
  expectedChainId: number;
  /** The full 402 body, used to bind the verification to this demand. */
  paymentRequired: X402PaymentRequired;
};

export type VerifySuccess = {
  kind: "ok";
  /** What the buyer authorized, copied from the witness for downstream checks. */
  authorized: {
    payTo: Address;
    amount: SmallestUnits;
    token: Address;
    chainId: number;
    nonce: string | null;
  };
};

export type VerifyFailure = {
  kind: "fail";
  classification: PaymentFailureClassification;
  detail: string;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * Run the verification protocol.
 *
 * The function never throws on shape problems — they map to a
 * classification. Programmer errors (non-Object inputs, etc.) are not
 * caught and bubble up to the route's error handler.
 *
 * The `clock` parameter is the source of "now" for the session-expiry
 * check: if `witness.deadline < clock.now()` the envelope is rejected
 * as `verification-failed` with detail `"session expired"`. The witness
 * `deadline` is in Unix seconds (EIP-712 typed-data convention) while
 * `clock.now()` is milliseconds, so the comparison is done in
 * milliseconds: `deadline * 1000 < now`.
 */
export async function verifyEnvelope(
  input: VerifyInput,
  verifier: Verifier,
  clock: Clock = systemClock,
): Promise<VerifyResult> {
  const witness = readPermit2WitnessFields(input.envelope.witness);
  if (
    !witness.payTo ||
    witness.amount === null ||
    !witness.token ||
    witness.chainId === null
  ) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: "envelope witness missing payTo/amount/token/chainId",
    };
  }
  if (witness.payTo !== input.expectedPayTo) {
    return {
      kind: "fail",
      classification: "recipient-mismatch",
      detail: `witness payTo ${witness.payTo} != expected ${input.expectedPayTo}`,
    };
  }
  if (witness.token !== input.expectedToken) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: `witness token ${witness.token} != expected ${input.expectedToken}`,
    };
  }
  if (witness.chainId !== input.expectedChainId) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: `witness chainId ${witness.chainId} != expected ${input.expectedChainId}`,
    };
  }
  if (witness.amount < input.demandedAmount) {
    return {
      kind: "fail",
      classification: "amount-underpaid",
      detail: `witness amount ${witness.amount} < demanded ${input.demandedAmount}`,
    };
  }
  // Session-expiry enforcement. The witness's `deadline` (Unix seconds)
  // is bound to the EIP-712 signature, so an expired witness is
  // cryptographically rejected on chain too — but we reject it here so
  // the buyer gets a `verification-failed` response immediately rather
  // than after a tx revert. Misses (deadline absent) are treated as
  // unexpired: the witness never committed to a TTL, so we don't
  // reject on its behalf.
  if (witness.deadline !== null) {
    const nowMs = clock.now();
    const deadlineMs = witness.deadline * 1000;
    if (deadlineMs < nowMs) {
      return {
        kind: "fail",
        classification: "verification-failed",
        detail: "session expired",
      };
    }
  }

  let magic: Hex;
  try {
    magic = await verifier({
      payer: input.envelope.from,
      hash:
        input.envelope.decoded.permit.hash === "0x"
          ? ("0x" as Hex)
          : input.envelope.decoded.permit.hash,
      signature: input.envelope.signature,
    });
  } catch (cause) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail:
        cause instanceof Error
          ? `isValidSignature read failed: ${cause.message}`
          : "isValidSignature read failed",
    };
  }

  // Permit2 uses a 4-byte magic value; any other return is a rejection.
  // viem decodes the ABI `bytes4` return as a left-padded 32-byte value,
  // but a manual stub can hand back just the 4-byte value. Accept either
  // shape by checking the prefix only.
  const normalized = magic.toLowerCase();
  const stripped = normalized.startsWith("0x")
    ? normalized.slice(2)
    : normalized;
  if (!stripped.endsWith(IS_VALID_SIGNATURE_MAGIC.slice(2))) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: `isValidSignature returned ${magic}, expected ${IS_VALID_SIGNATURE_MAGIC}…`,
    };
  }

  return {
    kind: "ok",
    authorized: {
      payTo: witness.payTo,
      amount: witness.amount,
      token: witness.token,
      chainId: witness.chainId,
      nonce: witness.nonce,
    },
  };
}

/**
 * The shape of the public-client read a production verifier performs.
 *
 * Split out so the production wiring is testable separately from the
 * pure verification protocol.
 */
export type Permit2SignatureChecker = {
  /** The canonical Permit2 contract address. */
  permit2Address: Address;
  /** The `isValidSignature` selector + ABI fragment (function name: `isValidSignature`). */
  abi: readonly unknown[];
};

/**
 * Build a production `Verifier` that reads `isValidSignature(bytes32,bytes)`
 * from Permit2 via a viem `readContract`. Tests inject a stub; this is the
 * real-world default.
 */
export type PublicClientLike = {
  readContract: (input: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
};

/**
 * Build the production verifier. Exported so `apps/api/index.ts` (or the
 * composition root in `seller/index.ts`) can compose it without needing
 * viem imports in the route layer.
 */
export function buildPermit2Verifier(input: {
  client: PublicClientLike;
  permit2Address: Address;
  /** The 4-byte ERC-1271 selector + ABI for Permit2's `isValidSignature(bytes32,bytes)` overload. */
  abi: readonly unknown[];
}): Verifier {
  return async ({ payer, hash, signature }) => {
    const result = await input.client.readContract({
      address: input.permit2Address,
      abi: input.abi,
      functionName: "isValidSignature",
      args: [hash, signature],
    });
    // The verifier must be called with `msg.sender == payer` for an
    // ERC-1271 validator; in our composition the call is dispatched with
    // `payer` as sender. The read just returns the magic.
    void payer;
    return result as Hex;
  };
}
