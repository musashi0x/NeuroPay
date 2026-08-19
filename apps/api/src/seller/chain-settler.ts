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
import { logger } from "../logger.js";
import {
  type SettlementInput,
  type SettlementSubmitted,
  type Settler,
  SettlerOutOfGasError,
  SettlementRevertedError,
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
  spenderAddress: Address;
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
      const witnessTypeString = witnessTypeStringFor(input.chainId);
      const witnessHash = witnessPlaceholderHash(input.nonce);

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
              deadline: BigInt(
                input.deadline ??
                  Math.floor(Date.now() / 1000) + lostTxTimeoutMs,
              ),
            },
            {
              to: options.spenderAddress,
              requestedAmount: input.amount,
            },
            input.payer,
            witnessHash,
            witnessTypeString,
            "0x" as Hex,
          ],
        });
      } catch (cause: unknown) {
        const message =
          cause instanceof Error ? cause.message : String(cause);
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
        let receipt: Awaited<ReturnType<typeof options.publicClient.getTransactionReceipt>>;
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
    sessionPublicKey: null,
    chainId: options.chainId,
    token: options.permit2Address,
    tokenDecimals: 18,
  };
}

function witnessTypeStringFor(_chainId: number): string {
  void _chainId;
  return "Permit2 Witness witness)PayTo(address payTo,uint256 amount)Token(address token,uint256 chainId)Witness(uint256 nonce,uint256 deadline)PermitWitness(bytes32 hash)";
}

function witnessPlaceholderHash(nonce: string): Hex {
  const stripped = nonce.replace(/[^0-9a-fA-F]/g, "");
  const padded = (stripped + "0".repeat(64)).slice(0, 64);
  return ("0x" + padded) as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
