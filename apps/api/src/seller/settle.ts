/**
 * Async settler (5.8).
 *
 * After the verifier accepts an envelope, the seller submits a settlement
 * transaction (`Permit2.permitWitnessTransferFrom`) and returns
 * delivery immediately — the settlement may take one or two blocks to
 * land.
 *
 * The settler is a promise queue: each successful verification submits a
 * single settlement. A drained settler (one with no gas) reports
 * `settler-out-of-gas` distinctly from a transaction revert
 * (`settlement-reverted`). Both classifications are recorded against the
 * authorization nonce so the operator console can tell "the seller ran
 * out of money" from "the buyer signed something Permit2 rejected".
 *
 * The settler interface is sealed at the composition root:
 *
 *   Settler.submitSettle({ ... }) => Promise<{ txHash }>  // happy path
 *   Settler.submitSettle({ ... }) => throws SettlerOutOfGasError  // drained
 *   Settler.submitSettle({ ... }) => throws SettlementRevertedError  // reorged
 *
 * Tests use an in-memory settler; production calls
 * `permitWitnessTransferFrom` on a viem `WalletClient` from the
 * settler EOA.
 */

import type {
  Address,
  Hex,
  PaymentFailureClassification,
  SmallestUnits,
} from "@neuro-pay/types";
import type { LedgerStore } from "@neuro-pay/ledger";
import {
  recordSettlementConfirmed,
  recordSettlementFailed,
  recordSettlementSubmitted,
} from "@neuro-pay/ledger";

/**
 * Inputs to a single settlement. The settler is `submitSettle` — it
 * either submits and returns the tx hash, or throws and the route
 * classifies the throw.
 */
export type SettlementInput = {
  nonce: string;
  streamId: string;
  sessionPublicKey: Hex | null;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  amount: SmallestUnits;
  payer: Address;
  payTo: Address;
  /**
   * The deadline after which the Permit2 witness is no longer valid.
   * Carried through so a settlement can be submitted even if the network
   * is congested past 480s.
   */
  deadline?: number | null;
};

/** What `submitSettle` returns on the happy path. */
export type SettlementSubmitted = {
  transactionHash: Hex;
  /** The settlement is submitted; later events (confirm/fail) update the same nonce. */
};

/** Thrown when the settler cannot submit because the EOA has no gas. */
export class SettlerOutOfGasError extends Error {
  constructor(message: string = "settler account has no gas") {
    super(message);
    this.name = "SettlerOutOfGasError";
  }
}

/** Thrown when the settlement transaction reverts on chain. */
export class SettlementRevertedError extends Error {
  readonly transactionHash: Hex;
  constructor(transactionHash: Hex, message: string = "settlement reverted") {
    super(message);
    this.name = "SettlementRevertedError";
    this.transactionHash = transactionHash;
  }
}

/**
 * Thrown when a submitted settlement never confirms before the settler's
 * timeout. Distinct from revert: the chain may still land the tx later.
 */
export class SettlementLostError extends Error {
  readonly transactionHash: Hex;
  constructor(
    transactionHash: Hex,
    message: string = "settlement lost (timeout)",
  ) {
    super(message);
    this.name = "SettlementLostError";
    this.transactionHash = transactionHash;
  }
}

/**
 * The settler contract. `submitSettle` is fire-and-forget: the call
 * site awaits the submission only — confirmation lands out-of-band
 * via `awaitConfirmation` (or via a polling block watcher in
 * production).
 */
export type Settler = {
  /**
   * Submit the Permit2 settlement. Returns the transaction hash. The
   * call site should `await submitSettle(...)` and catch the
   * `SettlerOutOfGasError` / `SettlementRevertedError` to record the
   * correct classification.
   */
  submitSettle(input: SettlementInput): Promise<SettlementSubmitted>;
  /**
   * Wait for `transactionHash` to confirm. Resolves on confirmation
   * (and any error throws `SettlementRevertedError`). Used internally
   * to flip `settlement.submitted` into `settlement.confirmed`.
   *
   * Production implementations poll a `PublicClient.waitForTransactionReceipt`;
   * the in-memory test stub returns immediately.
   */
  awaitConfirmation(transactionHash: Hex): Promise<void>;
};

/**
 * The async settlement pipeline.
 *
 * The pipeline orchestrates: submit → record `settlement.submitted` →
 * (out of band) await confirmation → record `settlement.confirmed`. If
 * either step throws, the matching classification is recorded against
 * the same nonce as `settlement.failed`.
 *
 * All ledger writes are append-only; the same nonce carries up to three
 * lifecycle entries — submitted, confirmed/failed — that the
 * `lookupByNonce` reader stitches back together.
 */
export type SettlementQueue = {
  /**
   * Enqueue a settlement. Fire-and-forget: returns immediately after
   * the `submitSettle` Promise resolves with a tx hash. Confirmation
   * happens out-of-band.
   */
  enqueue(input: SettlementInput): Promise<{ transactionHash: Hex }>;
  /**
   * Read how many settlements are in-flight right now. Synonymous with
   * the exposure counter's `inFlightCount`; the same number is mirrored
   * to the exposure module, this is just a thin read.
   */
  inFlight(): number;
  /**
   * Wait for all currently-pending settlements to settle (success or
   * failure). Tests use this to make assertions deterministic.
   */
  drain(): Promise<void>;
  /** Reset internal state. Tests only. */
  reset(): void;
};

/**
 * Optional accounting callbacks. Invoked after the matching ledger write
 * so a hook throw cannot swallow a recorded outcome.
 */
export type SettlementQueueHooks = {
  onConfirmed?: (input: SettlementInput) => void | Promise<void>;
  onFailed?: (
    input: SettlementInput,
    failure: {
      classification: PaymentFailureClassification;
      detail: string;
      transactionHash: Hex | null;
    },
  ) => void | Promise<void>;
};

/**
 * Build a settlement queue with an injected settler + ledger. The queue
 * owns:
 *  - the in-flight set of pending confirmations
 *  - `drain()` for tests
 *  - the submit-then-confirm orchestration that records the lifecycle
 */
export function createSettlementQueue(input: {
  settler: Settler;
  store: LedgerStore;
  hooks?: SettlementQueueHooks;
}): SettlementQueue {
  const pending = new Set<Promise<void>>();
  let count = 0;

  return {
    async enqueue(s) {
      let resolveSubmitted!: (value: SettlementSubmitted) => void;
      let rejectSubmitted!: (cause: unknown) => void;
      const submittedP = new Promise<SettlementSubmitted>((resolve, reject) => {
        resolveSubmitted = resolve;
        rejectSubmitted = reject;
      });

      // Track the full submit→confirm job from the first tick so
      // `drain()` cannot miss a fire-and-forget enqueue.
      const job = (async () => {
        let submitted: SettlementSubmitted;
        try {
          submitted = await input.settler.submitSettle(s);
        } catch (cause) {
          try {
            if (cause instanceof SettlerOutOfGasError) {
              await recordFailed(input, s, {
                classification:
                  "settler-out-of-gas" satisfies PaymentFailureClassification,
                detail: cause.message,
                transactionHash: null,
              });
            } else if (cause instanceof SettlementRevertedError) {
              await recordFailed(input, s, {
                classification:
                  "settlement-reverted" satisfies PaymentFailureClassification,
                transactionHash: cause.transactionHash,
                detail: cause.message,
              });
            } else {
              await recordFailed(input, s, {
                classification:
                  "settlement-reverted" satisfies PaymentFailureClassification,
                detail: cause instanceof Error ? cause.message : String(cause),
                transactionHash: null,
              });
            }
          } finally {
            rejectSubmitted(cause);
          }
          return;
        }

        await recordSettlementSubmitted({
          store: input.store,
          ctx: ctxFor(s),
          amount: s.amount,
          nonce: s.nonce,
          transactionHash: submitted.transactionHash,
        });
        count += 1;
        resolveSubmitted(submitted);

        try {
          await input.settler.awaitConfirmation(submitted.transactionHash);
          await recordSettlementConfirmed({
            store: input.store,
            ctx: ctxFor(s),
            amount: s.amount,
            nonce: s.nonce,
            transactionHash: submitted.transactionHash,
          });
          await invokeHook(() => input.hooks?.onConfirmed?.(s));
        } catch (cause) {
          if (cause instanceof SettlementRevertedError) {
            await recordFailed(input, s, {
              classification:
                "settlement-reverted" satisfies PaymentFailureClassification,
              transactionHash: cause.transactionHash,
              detail: cause.message,
            });
          } else if (cause instanceof SettlementLostError) {
            await recordFailed(input, s, {
              classification:
                "settlement-reverted" satisfies PaymentFailureClassification,
              transactionHash: cause.transactionHash,
              detail: cause.message,
            });
          } else {
            await recordFailed(input, s, {
              classification:
                "settlement-reverted" satisfies PaymentFailureClassification,
              detail: cause instanceof Error ? cause.message : String(cause),
              transactionHash: null,
            });
          }
        } finally {
          count -= 1;
        }
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));

      return { transactionHash: (await submittedP).transactionHash };
    },
    inFlight() {
      return count;
    },
    async drain() {
      // `allSettled` resolves regardless of success/failure; we don't
      // care about the rejection here, only that the queue is empty.
      await Promise.allSettled(Array.from(pending));
    },
    reset() {
      pending.clear();
      count = 0;
    },
  };
}

async function recordFailed(
  input: {
    store: LedgerStore;
    hooks?: SettlementQueueHooks;
  },
  s: SettlementInput,
  failure: {
    classification: PaymentFailureClassification;
    detail: string;
    transactionHash?: Hex | null;
  },
): Promise<void> {
  const transactionHash = failure.transactionHash ?? null;
  await recordSettlementFailed({
    store: input.store,
    ctx: ctxFor(s),
    amount: s.amount,
    nonce: s.nonce,
    classification: failure.classification,
    transactionHash,
    detail: failure.detail,
  });
  await invokeHook(() =>
    input.hooks?.onFailed?.(s, {
      classification: failure.classification,
      detail: failure.detail,
      transactionHash,
    }),
  );
}

async function invokeHook(
  fn: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await fn();
  } catch {
    // Accounting hooks must not fail the settlement pipeline or hide
    // an already-recorded ledger outcome.
  }
}

function ctxFor(input: SettlementInput): {
  streamId: string;
  sessionPublicKey: Hex | null;
  chainId: number;
  token: Address;
  tokenDecimals: number;
} {
  return {
    streamId: input.streamId,
    sessionPublicKey: input.sessionPublicKey,
    chainId: input.chainId,
    token: input.token,
    tokenDecimals: input.tokenDecimals,
  };
}

/**
 * In-memory settler for tests. Resolves the configured tx hash for any
 * `submitSettle` call; flips behavior based on the per-nonce configuration.
 */
export type InMemorySettlerOptions = {
  /**
   * Default behavior for unknown nonces. The intentional default is "succeed
   * with a deterministic tx hash" so test wiring is straightforward.
   */
  defaultBehavior?: "confirm" | "revert" | "out-of-gas";
  /**
   * Per-nonce override. Use this to drive specific test scenarios.
   */
  perNonce?: Map<string, "confirm" | "revert" | "out-of-gas">;
  defaultTransactionHash?: Hex;
};

export function createInMemorySettler(
  options: InMemorySettlerOptions = {},
): Settler {
  const defaultHash =
    options.defaultTransactionHash ?? (("0x" + "ab".repeat(32)) as Hex);
  const cache = new Map<Hex, "confirmed" | "reverted">();
  return {
    async submitSettle(input) {
      const behavior =
        options.perNonce?.get(input.nonce) ??
        options.defaultBehavior ??
        "confirm";
      const txHash = ("0x" +
        behavior.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)) as Hex;
      cache.set(txHash, behavior === "revert" ? "reverted" : "confirmed");
      if (behavior === "out-of-gas") {
        throw new SettlerOutOfGasError(
          `in-memory settler: nonce=${input.nonce} simulated out-of-gas`,
        );
      }
      if (behavior === "revert") {
        // Throw the reverted error so the caller records it; the tx hash
        // would still be on chain but the confirmation path also throws.
        throw new SettlementRevertedError(
          txHash,
          `in-memory settler: nonce=${input.nonce} simulated revert`,
        );
      }
      return { transactionHash: txHash };
    },
    async awaitConfirmation(transactionHash) {
      const result = cache.get(transactionHash);
      // Default to confirm unless the submit path set the entry to revert.
      if (result === "reverted") {
        throw new SettlementRevertedError(transactionHash);
      }
      return;
      void defaultHash; // referenced when no per-nonce override
    },
  };
}

/**
 * Settler whose confirmations stay pending until the test calls
 * `confirm()` or `revert()`. Used to exercise the exposure gate
 * deterministically: acquire a slot, refuse the next delivery, then
 * release.
 */
export function createStallingSettler(
  options: {
    defaultTransactionHash?: Hex;
  } = {},
): {
  settler: Settler;
  confirm: () => void;
  revert: () => void;
  lose: () => void;
} {
  const defaultHash =
    options.defaultTransactionHash ?? (("0x" + "cd".repeat(32)) as Hex);
  let resolveGate: () => void = () => {
    /* set in Promise executor */
  };
  let rejectGate: (err: Error) => void = () => {
    /* set in Promise executor */
  };
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return {
    settler: {
      async submitSettle() {
        return { transactionHash: defaultHash };
      },
      async awaitConfirmation(transactionHash) {
        await gate;
        void transactionHash;
      },
    },
    confirm() {
      resolveGate();
    },
    revert() {
      rejectGate(
        new SettlementRevertedError(
          defaultHash,
          "stalling settler: simulated revert",
        ),
      );
    },
    lose() {
      rejectGate(
        new SettlementLostError(
          defaultHash,
          "stalling settler: simulated lost tx",
        ),
      );
    },
  };
}
