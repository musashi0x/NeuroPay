/**
 * Envelope verification (5.6).
 *
 * Verifies a payment envelope by calling `isValidSignature` on the buyer's
 * smart account with the canonical Permit2 checker. This module MUST NOT
 * use `ecrecover` anywhere: ERC-1271 is the only signature scheme that
 * can validate a 98-byte session-key envelope from a smart account, and
 * `ecrecover` on those bytes is meaningless.
 *
 * ## The digest is recomputed, never received
 *
 * The real b402 wire carries no EIP-712 hash — `signX402Payment` returns
 * the signature and the Permit2 struct, and nothing else. So the seller
 * rebuilds the typed data from the parsed permit plus its *own* chain id
 * and hashes it. This is not a convenience: a wire-supplied hash would
 * let a buyer hand over a digest that matches its signature while the
 * permit body says something else entirely.
 *
 * Recomputing also subsumes the old `wrong-chain` field check. The chain
 * id is never on the wire — it enters only through the EIP-712 domain the
 * signature covers — so a buyer that signed for chain 56 and paid a
 * chain-97 seller produces a digest the account will not validate, and
 * fails as `verification-failed`. There is no field to compare and no
 * need for one.
 *
 * The verifier is an injected function (see `Verifier`) so the route layer
 * never imports viem directly; tests stub the verifier with a callback
 * that returns either the magic value (accept) or anything else (reject).
 *
 * Rejection cases are explicit and carry distinct classifications:
 * - underpaid (permit amount < demanded): `amount-underpaid`
 * - wrong recipient (witness.to ≠ config payTo): `recipient-mismatch`
 * - wrong token / wrong spender / expired / bad magic: `verification-failed`
 */

import { permit2WitnessDigest } from "@neuro-pay/altana";

import type {
  Address,
  Hex,
  PaymentFailureClassification,
  SmallestUnits,
  X402PaymentRequired,
} from "@neuro-pay/types";

import { systemClock, type Clock } from "@neuro-pay/metering";

import { permitBindings, type ParsedEnvelope } from "./envelope.js";

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
  /** The digest the seller recomputed from the permit — never a wire value. */
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
  /** The token address from the pinned sheet, used to confirm the permit binds the same token. */
  expectedToken: Address;
  /** The chain id the digest is recomputed against. Local config, never the wire. */
  expectedChainId: number;
  /**
   * The settler EOA that will call `permitWitnessTransferFrom`. Permit2
   * binds the signed `spender` to that call's `msg.sender`, so a permit
   * naming anyone else is unsettleable here.
   */
  expectedSpender: Address;
  /** The full 402 body, used to bind the verification to this demand. */
  paymentRequired: X402PaymentRequired;
};

export type VerifySuccess = {
  kind: "ok";
  /** What the buyer authorized, copied from the permit for downstream checks. */
  authorized: {
    payTo: Address;
    amount: SmallestUnits;
    token: Address;
    chainId: number;
    nonce: string;
  };
  /** The digest the seller recomputed and the account validated. */
  digest: Hex;
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
 * The `clock` parameter is the source of "now" for the deadline check:
 * if `permit.deadline < clock.now()` the envelope is rejected as
 * `verification-failed` with detail `"session expired"`. The permit's
 * `deadline` is in Unix seconds (EIP-712 typed-data convention) while
 * `clock.now()` is milliseconds, so the comparison is done in
 * milliseconds: `deadline * 1000 < now`.
 */
export async function verifyEnvelope(
  input: VerifyInput,
  verifier: Verifier,
  clock: Clock = systemClock,
): Promise<VerifyResult> {
  const permit = input.envelope.permit;
  const bindings = permitBindings(permit);

  // A witness-less permit is the legacy plain-`permit2` rail. This seller
  // only ever quotes `permit2-exact`, whose whole point is that the
  // recipient is cryptographically bound — without it, a settler could
  // redirect the transfer.
  if (bindings.payTo === null) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail:
        "permit carries no witness; permit2-exact binds payTo in the witness",
    };
  }
  if (!sameAddress(bindings.payTo, input.expectedPayTo)) {
    return {
      kind: "fail",
      classification: "recipient-mismatch",
      detail: `witness to ${bindings.payTo} != expected ${input.expectedPayTo}`,
    };
  }
  if (!sameAddress(bindings.token, input.expectedToken)) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: `permit token ${bindings.token} != expected ${input.expectedToken}`,
    };
  }
  if (!sameAddress(permit.spender, input.expectedSpender)) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail:
        `permit spender ${permit.spender} != settler ${input.expectedSpender}; ` +
        `Permit2 requires the signed spender to equal msg.sender of the settlement call`,
    };
  }
  if (bindings.amount < input.demandedAmount) {
    return {
      kind: "fail",
      classification: "amount-underpaid",
      detail: `permit amount ${bindings.amount} < demanded ${input.demandedAmount}`,
    };
  }
  // Deadline enforcement. The deadline is bound to the EIP-712 signature,
  // so an expired permit is cryptographically rejected on chain too — but
  // we reject it here so the buyer gets a `verification-failed` response
  // immediately rather than after a tx revert.
  if (permit.deadline * 1000 < clock.now()) {
    return {
      kind: "fail",
      classification: "verification-failed",
      detail: "session expired",
    };
  }

  const digest = recomputePermit2Digest({
    permit,
    chainId: input.expectedChainId,
    witness: permit.witness!,
  });

  let magic: Hex;
  try {
    magic = await verifier({
      payer: input.envelope.from,
      hash: digest,
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
    digest,
    authorized: {
      payTo: bindings.payTo,
      amount: bindings.amount,
      token: bindings.token,
      chainId: input.expectedChainId,
      nonce: bindings.nonce,
    },
  };
}

/**
 * Rebuild the EIP-712 digest the buyer signed.
 *
 * Uses the SDK's own `buildPermit2WitnessTypedData` so the seller and the
 * buyer are provably hashing the same struct definition — if the SDK's
 * witness type ever changes, both sides move together instead of silently
 * disagreeing. `chainId` comes from local config; everything else comes
 * from the permit the buyer sent.
 */
export function recomputePermit2Digest(input: {
  permit: {
    permitted: { token: Address; amount: SmallestUnits };
    spender: Address;
    nonce: string;
    deadline: number;
  };
  witness: { to: Address; validAfter: string };
  chainId: number;
}): Hex {
  return permit2WitnessDigest({
    chainId: input.chainId,
    authorization: { ...input.permit, witness: input.witness },
  });
}

/** Addresses are compared case-insensitively; EIP-55 checksums vary by producer. */
function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
    /**
     * Sets `from` on the underlying `eth_call`. Load-bearing for
     * ERC-1271 against a session-key account — see
     * `buildPermit2Verifier`.
     */
    account?: Address;
  }) => Promise<unknown>;
};

/**
 * Build the production verifier. Exported so `apps/api/index.ts` (or the
 * composition root in `seller/index.ts`) can compose it without needing
 * viem imports in the route layer.
 */
/**
 * Build the production ERC-1271 verifier.
 *
 * ## The call target is the payer, not Permit2
 *
 * ERC-1271 is a method a *signer account* implements: the account is
 * asked whether a signature over a hash is one it considers its own.
 * Permit2 is the counterparty, not the signer — it has no
 * `isValidSignature` at all, and calling it there hits the fallback and
 * reverts with empty data. That was this function's original behaviour
 * and it rejected every real payment with `verification-failed`,
 * pointing the blame at the buyer's signature rather than at the
 * address being asked.
 *
 * Permit2 itself does exactly what this does when it settles: it calls
 * `IERC1271(owner).isValidSignature(...)` on the account. Checking the
 * same thing here, before delivering, is the entire point of the
 * pre-check.
 *
 * ## The caller has to be Permit2
 *
 * A session-key account does not answer ERC-1271 the same way for
 * everyone. The session's permissions allow calls *to Permit2*, so the
 * account validates against `msg.sender` and returns the magic value
 * only when Permit2 is asking. Measured against the live account with
 * one real signature: caller Permit2 returns `0x1626ba7e`, while the
 * default caller, the settler, and even the payer itself all return
 * `0xffffffff`.
 *
 * So the read carries `account: permit2Address`, which sets `from` on
 * the `eth_call`. Without it the pre-check disagrees with the chain and
 * refuses payments that settle perfectly well — verified by simulating
 * `permitWitnessTransferFrom` with the same signature on a fork, where
 * Permit2 accepts it.
 *
 * ## A revert means "no", not "broken"
 *
 * A conforming account returns a non-magic `bytes4` for a bad
 * signature, but real ones — the EIP-7702 account this runs against
 * included — revert with a typed error such as `InvalidSignature()`
 * instead. Letting that propagate would report a rejected signature as
 * an infrastructure failure, so a revert carrying data is folded back
 * into an ordinary non-magic answer and travels the normal rejection
 * path. A revert with *no* data is different: that is what an address
 * with no such function does, and it stays an error, because it means
 * the verifier is pointed somewhere wrong.
 */
export function buildPermit2Verifier(input: {
  client: PublicClientLike;
  /**
   * The caller the read impersonates, and the address the deployment
   * guard in `chain-verifier.ts` checks. Never the call target.
   */
  permit2Address: Address;
  /** ABI for the ERC-1271 `isValidSignature(bytes32,bytes)` method. */
  abi: readonly unknown[];
}): Verifier {
  return async ({ payer, hash, signature }) => {
    try {
      const result = await input.client.readContract({
        address: payer,
        abi: input.abi,
        functionName: "isValidSignature",
        args: [hash, signature],
        // Impersonate Permit2 for the read. This is what makes the
        // pre-check ask the same question settlement will.
        account: input.permit2Address,
      });
      return result as Hex;
    } catch (cause: unknown) {
      const revertData = extractRevertData(cause);
      if (revertData !== null && revertData !== "0x") {
        // The account executed and said no. Hand back something that is
        // not the magic value so the caller classifies it as a rejected
        // signature rather than a failed read.
        return revertData as Hex;
      }
      throw cause;
    }
  };
}

/**
 * Pull the revert payload out of a viem error, if it carries one.
 *
 * An empty payload and an absent one are reported the same way here
 * (`"0x"` and `null` respectively) but mean different things to the
 * caller, so they stay distinguishable.
 */
function extractRevertData(cause: unknown): string | null {
  let current: unknown = cause;
  for (
    let depth = 0;
    depth < 8 && current !== null && current !== undefined;
    depth += 1
  ) {
    const node = current as {
      data?: unknown;
      cause?: unknown;
      signature?: unknown;
    };
    if (typeof node.data === "string" && node.data.startsWith("0x")) {
      return node.data;
    }
    if (typeof node.signature === "string" && node.signature.startsWith("0x")) {
      return node.signature;
    }
    current = node.cause;
  }
  // viem renders a typed revert it cannot decode into the message; the
  // selector is still the account's answer.
  const message = cause instanceof Error ? cause.message : "";
  const match =
    /reverted with the following signature:\s*(0x[0-9a-fA-F]{8})/.exec(message);
  return match ? (match[1] as string) : null;
}
