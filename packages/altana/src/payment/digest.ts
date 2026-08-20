/**
 * Permit2 digest and witness encoding — the one place the b402 witness
 * struct is defined for both sides of the wire.
 *
 * The buyer signs a `PermitWitnessTransferFrom` whose witness is
 * `Witness(address to,uint256 validAfter)`. Three consumers need to agree
 * on that struct byte-for-byte:
 *
 *  1. the buyer, which signs the typed data (via the SDK);
 *  2. the seller's verifier, which must **recompute** the digest because
 *     the wire never carries it;
 *  3. the settler, which passes the witness *struct hash* and the EIP-712
 *     *type string* to `Permit2.permitWitnessTransferFrom`, where Permit2
 *     rebuilds the digest a third time and checks it against the
 *     signature.
 *
 * Any disagreement between the three produces a signature mismatch and an
 * unconditional revert, so they all derive from the constants here and
 * from the SDK's own `buildPermit2WitnessTypedData`.
 */

import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  type Hex as ViemHex,
} from "viem";
import { buildPermit2WitnessTypedData } from "@altananetwork/sdk";

import type { Address, Hex, SmallestUnits } from "@neuro-pay/types";

/** The witness struct's EIP-712 type, verbatim from the x402ExactPermit2Proxy. */
export const WITNESS_TYPE = "Witness(address to,uint256 validAfter)";

/**
 * The `witnessTypeString` argument `permitWitnessTransferFrom` expects.
 *
 * Permit2 builds the full type by concatenating its own stub —
 * `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,`
 * — with this string, so it must open by naming the witness member, close
 * the parent struct's parameter list, and then append every referenced
 * struct definition in EIP-712 order (alphabetical: TokenPermissions,
 * then Witness).
 */
export const WITNESS_TYPE_STRING =
  "Witness witness)TokenPermissions(address token,uint256 amount)" +
  WITNESS_TYPE;

/** `keccak256("Witness(address to,uint256 validAfter)")`. */
export const WITNESS_TYPEHASH: Hex = keccak256(toHex(WITNESS_TYPE)) as Hex;

/** The Permit2 struct as it travels on the wire and into settlement. */
export type Permit2WitnessAuthorization = {
  permitted: { token: Address; amount: SmallestUnits };
  spender: Address;
  /** uint256, decimal string. */
  nonce: string;
  /** Unix seconds. */
  deadline: number;
  witness: { to: Address; validAfter: string };
};

/**
 * Recompute the EIP-712 digest the buyer signed.
 *
 * `chainId` is the verifier's own configured chain, never a wire value —
 * the chain is bound only through the EIP-712 domain, so recomputing with
 * the local chain id is precisely what makes a wrong-chain payment fail
 * the signature check.
 */
export function permit2WitnessDigest(input: {
  authorization: Permit2WitnessAuthorization;
  chainId: number;
}): Hex {
  const { authorization: a } = input;
  return hashTypedData(
    buildPermit2WitnessTypedData({
      chainId: input.chainId,
      token: a.permitted.token,
      amount: a.permitted.amount,
      spender: a.spender,
      nonce: BigInt(a.nonce),
      deadline: BigInt(a.deadline),
      to: a.witness.to,
      validAfter: BigInt(a.witness.validAfter),
    }),
  ) as Hex;
}

/**
 * The witness struct hash `permitWitnessTransferFrom` takes as its
 * `witness` argument: `keccak256(abi.encode(WITNESS_TYPEHASH, to,
 * validAfter))`.
 *
 * This is the struct hash, not the full digest — Permit2 nests it inside
 * the `PermitWitnessTransferFrom` hash itself.
 */
export function hashPermit2Witness(witness: {
  to: Address;
  validAfter: string;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [
        WITNESS_TYPEHASH as ViemHex,
        witness.to as ViemHex,
        BigInt(witness.validAfter),
      ],
    ),
  ) as Hex;
}
