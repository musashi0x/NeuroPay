/**
 * Production settler: drives `Permit2.permitWitnessTransferFrom` via viem.
 *
 * The in-memory settler in `settle.ts` is what the composition root
 * currently injects, which is fine for tests but does not exercise the
 * chain path. This module is the chain-backed equivalent that the runtime
 * wires in once `SETTLER_PRIVATE_KEY` and `RPC_URL` are both configured.
 *
 * The settler conforms to the same `Settler` interface as the in-memory
 * one, so the rest of the seller is untouched:
 *
 *   submitSettle(input) => { transactionHash }
 *   awaitConfirmation(hash) => void / throws SettlementRevertedError
 *
 * On submit it records `payment.settlement.submitted`; on confirm it
 * records `payment.settlement.confirmed`; on revert/throw it records
 * `payment.settlement.failed`; on timeout it records
 * `payment.settlement.lost`. The matching `settlement.*` accounting
 * entry that the exposure module consumes is recorded by the
 * `SettlementQueue` in `settle.ts`; this module emits the
 * `payment.settlement.*` audit pair so an operator that wants to grep
 * "the chain path wrote this" has a single namespace.
 */

import type {
  Address,
  Hex,
  PaymentFailureClassification,
  SmallestUnits,
} from "@neuro-pay/types";
import type { EventContext, LedgerStore } from "@neuro-pay/ledger";
import {
  recordPaymentSettlementConfirmed,
  recordPaymentSettlementFailed,
  recordPaymentSettlementLost,
  recordPaymentSettlementSubmitted,
} from "@neuro-pay/ledger";
import { hashPermit2Witness, WITNESS_TYPE_STRING } from "@neuro-pay/altana";
import { logger } from "../logger.js";
import {
  type SettlementInput,
  type SettlementSubmitted,
  type Settler,
  SettlerOutOfGasError,
  SettlementLostError,
  SettlementRevertedError,
  SettlementUnsettleableError,
} from "./settle.js";

/** The Permit2 ABI fragment for `permitWitnessTransferFrom`. */
export const PERMIT2_PERMIT_WITNESS_TRANSFER_FROM_ABI = [
  {
    name: "permitWitnessTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "transferDetails",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "requestedAmount", type: "uint256" },
        ],
      },
      { name: "owner", type: "address" },
      { name: "witness", type: "bytes32" },
      { name: "witnessTypeString", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** The minimal viem WalletClient surface this settler uses. */
export type WalletClientLike = {
  writeContract: (input: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Promise<Hex>;
};

/** The minimal viem PublicClient surface this settler uses. */
export type PublicClientLikeForSettler = {
  getTransactionReceipt: (input: { hash: Hex }) => Promise<{
    status: "success" | "reverted" | undefined;
    blockNumber?: bigint;
    transactionHash?: Hex;
  } | null>;
  getBlock?: (input: { blockNumber?: bigint }) => Promise<{
    timestamp?: bigint;
  } | null>;
};

export type ChainBackedSettlerOptions = {
  walletClient: WalletClientLike;
  publicClient: PublicClientLikeForSettler;
  /**
   * The EOA this settler submits from. Permit2 checks the signed
   * `spender` against `msg.sender`, so this must be the same address the
   * seller advertised in the 402's `extra.spenderAddress`.
   */
  settlerAddress: Address;
  permit2Address: Address;
  chainId: number;
  ledger: LedgerStore;
  lostTxTimeoutMs?: number;
  pollIntervalMs?: number;
  permit2Abi?: readonly unknown[];
};

type PendingSettlement = {
  amount: SmallestUnits;
  streamId: string;
  nonce: string;
  deadline: number | null;
  sessionPublicKey: Hex | null;
  token: Address;
  tokenDecimals: number;
};

/**
 * Build a chain-backed `Settler`.
 */
export function createChainBackedSettler(
  options: ChainBackedSettlerOptions,
): Settler {
  const lostTxTimeoutMs = options.lostTxTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const permit2Abi =
    options.permit2Abi ?? PERMIT2_PERMIT_WITNESS_TRANSFER_FROM_ABI;

  const pending = new Map<Hex, PendingSettlement>();

  return {
    async submitSettle(input: SettlementInput): Promise<SettlementSubmitted> {
      // Permit2 recomputes the signed digest from these exact arguments
      // and checks it against the signature, so there is nothing here we
      // are allowed to invent. An intent without an authorization is one
      // the seller could not have verified (or a legacy outbox row from
      // before the column existed) — refusing loudly beats submitting a
      // transaction that is guaranteed to revert and burn gas.
      const authorization = input.authorization ?? null;
      if (!authorization) {
        throw new SettlementUnsettleableError(
          `chain settler: settlement intent ${input.nonce} carries no buyer ` +
            `authorization (signature/spender/witness). Permit2 would revert.`,
        );
      }
      if (
        authorization.spender.toLowerCase() !==
        options.settlerAddress.toLowerCase()
      ) {
        throw new SettlementUnsettleableError(
          `chain settler: permit for ${input.nonce} names spender ` +
            `${authorization.spender}, but this settler submits as ` +
            `${options.settlerAddress}. Permit2 binds spender to msg.sender.`,
        );
      }
      if (input.deadline === null || input.deadline === undefined) {
        throw new SettlementUnsettleableError(
          `chain settler: settlement intent ${input.nonce} carries no deadline; ` +
            `the deadline is part of the signed digest and cannot be defaulted.`,
        );
      }

      const witnessHash = hashPermit2Witness(authorization.witness);

      let transactionHash: Hex;
      try {
        transactionHash = await options.walletClient.writeContract({
          address: options.permit2Address,
          abi: permit2Abi,
          functionName: "permitWitnessTransferFrom",
          args: [
            {
              permitted: { token: input.token, amount: input.amount },
              nonce: BigInt(input.nonce),
              deadline: BigInt(input.deadline),
            },
            {
              // The recipient is the witness's `to` — the address the
              // buyer cryptographically bound. Sending to the spender
              // would pay the settler its own float.
              to: authorization.witness.to,
              requestedAmount: input.amount,
            },
            input.payer,
            witnessHash,
            WITNESS_TYPE_STRING,
            authorization.signature,
          ],
        });
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/out of gas|insufficient funds/i.test(message)) {
          throw new SettlerOutOfGasError(
            `chain settler: ${message} (nonce=${input.nonce})`,
          );
        }
        throw new SettlerOutOfGasError(
          `chain settler: submit failed for nonce=${input.nonce}: ${message}`,
        );
      }

      pending.set(transactionHash, {
        amount: input.amount,
        streamId: input.streamId,
        nonce: input.nonce,
        deadline: input.deadline ?? null,
        sessionPublicKey: input.sessionPublicKey,
        token: input.token,
        tokenDecimals: input.tokenDecimals,
      });

      try {
        await recordPaymentSettlementSubmitted({
          store: options.ledger,
          ctx: {
            streamId: input.streamId,
            sessionPublicKey: input.sessionPublicKey,
            chainId: input.chainId,
            token: input.token,
            tokenDecimals: input.tokenDecimals,
          },
          amount: input.amount,
          nonce: input.nonce,
          transactionHash,
        });
      } catch (err: unknown) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            nonce: input.nonce,
            transactionHash,
          },
          "failed to record payment.settlement.submitted",
        );
      }

      return { transactionHash };
    },

    async awaitConfirmation(transactionHash: Hex): Promise<void> {
      const meta = pending.get(transactionHash);
      const startedAt = Date.now();

      while (Date.now() - startedAt < lostTxTimeoutMs) {
        let receipt: Awaited<
          ReturnType<typeof options.publicClient.getTransactionReceipt>
        >;
        try {
          receipt = await options.publicClient.getTransactionReceipt({
            hash: transactionHash,
          });
        } catch (cause: unknown) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          logger.warn(
            { transactionHash, err: message },
            "getTransactionReceipt threw; will retry",
          );
          await sleep(pollIntervalMs);
          continue;
        }

        if (receipt === null) {
          await sleep(pollIntervalMs);
          continue;
        }

        if (receipt.status === "success") {
          await emitConfirmed(options, transactionHash, meta);
          pending.delete(transactionHash);
          return;
        }

        if (receipt.status === "reverted") {
          await emitFailed(
            options,
            transactionHash,
            meta,
            "settlement-reverted",
            "transaction reverted on chain",
          );
          pending.delete(transactionHash);
          throw new SettlementRevertedError(transactionHash);
        }

        await sleep(pollIntervalMs);
      }

      await emitLost(options, transactionHash, meta);
      pending.delete(transactionHash);
      throw new SettlementLostError(
        transactionHash,
        `settlement lost (timeout ${lostTxTimeoutMs}ms)`,
      );
    },
  };
}

async function emitConfirmed(
  options: ChainBackedSettlerOptions,
  transactionHash: Hex,
  meta: PendingSettlement | undefined,
): Promise<void> {
  if (meta === undefined) {
    logger.warn(
      { transactionHash },
      "chain settler: no pending metadata for confirmed tx; skipping ledger write",
    );
    return;
  }
  try {
    await recordPaymentSettlementConfirmed({
      store: options.ledger,
      ctx: ctxFromMeta(meta, options),
      amount: meta.amount,
      nonce: meta.nonce,
      transactionHash,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        nonce: meta.nonce,
        transactionHash,
      },
      "failed to record payment.settlement.confirmed",
    );
  }
}

async function emitFailed(
  options: ChainBackedSettlerOptions,
  transactionHash: Hex,
  meta: PendingSettlement | undefined,
  classification: PaymentFailureClassification,
  detail: string,
): Promise<void> {
  if (meta === undefined) {
    logger.warn(
      { transactionHash },
      "chain settler: no pending metadata for failed tx; skipping ledger write",
    );
    return;
  }
  try {
    await recordPaymentSettlementFailed({
      store: options.ledger,
      ctx: ctxFromMeta(meta, options),
      amount: meta.amount,
      nonce: meta.nonce,
      classification,
      transactionHash,
      detail,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        nonce: meta.nonce,
        transactionHash,
      },
      "failed to record payment.settlement.failed",
    );
  }
}

async function emitLost(
  options: ChainBackedSettlerOptions,
  transactionHash: Hex,
  meta: PendingSettlement | undefined,
): Promise<void> {
  if (meta === undefined) {
    logger.warn(
      { transactionHash },
      "chain settler: no pending metadata for lost tx; skipping ledger write",
    );
    return;
  }
  try {
    await recordPaymentSettlementLost({
      store: options.ledger,
      ctx: ctxFromMeta(meta, options),
      amount: meta.amount,
      nonce: meta.nonce,
      transactionHash,
      detail: `settlement lost (timeout ${options.lostTxTimeoutMs ?? 60_000}ms)`,
    });
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        nonce: meta.nonce,
        transactionHash,
      },
      "failed to record payment.settlement.lost",
    );
  }
}

function ctxFromMeta(
  meta: PendingSettlement,
  options: ChainBackedSettlerOptions,
): EventContext {
  return {
    streamId: meta.streamId,
    sessionPublicKey: meta.sessionPublicKey,
    chainId: options.chainId,
    // The settlement token, carried from the submitted input. Reporting
    // Permit2's own address here would make every confirm/fail entry
    // disagree with the submit entry that preceded it.
    token: meta.token,
    tokenDecimals: meta.tokenDecimals,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
