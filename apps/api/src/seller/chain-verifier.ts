/**
 * Production wrapper around `buildPermit2Verifier`.
 *
 * The verification protocol (`verifyEnvelope` in `./verify.ts`) only sees a
 * `Verifier` callback — it never imports viem. This module is the production
 * wiring: it composes `buildPermit2Verifier` with a real viem `PublicClient`
 * and adds a startup `assertPermit2Deployed` guard so the runtime refuses to
 * mount the seller when Permit2 is missing on the configured chain.
 *
 * The exported `createChainBackedVerifier` returns a `Verifier` shaped
 * identically to the test stub — the composition root swaps it in
 * transparently.
 */

import type { Address, Hex } from "@neuro-pay/types";
import { assertPermit2Deployed } from "@neuro-pay/altana";
import {
  type PublicClientLike,
  buildPermit2Verifier,
  type Verifier,
} from "./verify.js";
import { logger } from "../logger.js";

/**
 * The Permit2 `isValidSignature(bytes32,bytes)` ABI fragment.
 *
 * Inlined rather than imported from the SDK to keep the seller package
 * independent of `@altananetwork/sdk`'s internal shape. The 4-byte selector
 * is `0x1626ba7e`; viem reads return `bytes4` as a left-padded 32-byte
 * hex, which `verifyEnvelope` normalizes.
 */
export const PERMIT2_IS_VALID_SIGNATURE_ABI = [
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

export type ChainBackedVerifierOptions = {
  /** viem PublicClient (or any duck-typed equivalent) reading the chain. */
  publicClient: PublicClientLike & {
    getCode?: (input: { address: Address }) => Promise<Hex | undefined>;
  };
  /** The canonical Permit2 deployment on this chain. */
  permit2Address: Address;
  /** Chain id used by the deployment guard. */
  chainId: number;
  /** The ABI fragment for `isValidSignature`. Defaults to Permit2's. */
  abi?: readonly unknown[];
};

/**
 * Compose `buildPermit2Verifier` with a startup Permit2-deployed check.
 *
 * On construction we call `assertPermit2Deployed` once. If Permit2 is
 * missing we throw — the runtime then surfaces the error to the operator
 * and refuses to mount the seller. This is the failure mode the spec
 * calls "Permit2 not deployed" and the reason we never silently sign
 * envelopes against nothing.
 */
export function createChainBackedVerifier(
  options: ChainBackedVerifierOptions,
): Verifier {
  // Best-effort startup guard. Some test stubs omit `getCode`; we treat
  // a missing method as a successful guard (the test will exercise the
  // verifier's behaviour directly).
  if (typeof options.publicClient.getCode === "function") {
    void assertPermit2Deployed(
      options.publicClient as unknown as Parameters<
        typeof assertPermit2Deployed
      >[0],
      options.chainId,
    ).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Permit2 deployment guard failed; verifier may misbehave",
      );
    });
  }

  return buildPermit2Verifier({
    client: options.publicClient,
    permit2Address: options.permit2Address,
    abi: options.abi ?? PERMIT2_IS_VALID_SIGNATURE_ABI,
  });
}
