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
import type { LedgerStore, SettlementIntent } from "@neuro-pay/ledger";
import {
  lookupByNonce,
  recordSettlementConfirmed,
  recordSettlementFailed,
  recordSettlementRecovered,
  recordSettlementRetry,
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
  /**
   * The buyer's real authorization.
   *
   * Permit2 recomputes the signed digest from `spender`, `nonce`,
   * `deadline`, the permitted token/amount, and the witness, then checks
   * it against `signature`. Every one of those has to be the buyer's own
   * value — a fabricated or defaulted field reverts the transaction
   * unconditionally. Optional on the type only so the in-memory settler
   * (which submits nothing) can still be driven from tests; the chain
   * settler refuses an input without it.
   */
  authorization?: SettlementAuthorization | null;
};

/** The buyer-signed Permit2 authorization, threaded verify → queue → chain. */
export type SettlementAuthorization = {
  /** The 98-byte nested ERC-1271 envelope the session key produced. */
  signature: Hex;
  /** The signed `spender` — must equal the settler EOA calling Permit2. */
  spender: Address;
  /** `Witness(address to,uint256 validAfter)`, bound into the signature. */
  witness: { to: Address; validAfter: string };
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
 * Thrown when an intent cannot produce a valid `permitWitnessTransferFrom`
 * call at all — no buyer authorization, a spender that is not this
 * settler, or a missing deadline.
 *
 * Terminal by construction: retrying cannot conjure the missing signed
 * data, and submitting anyway would spend gas on a transaction Permit2 is
 * certain to revert. Recorded as `settlement-reverted` so the operator
 * console shows it in the same bucket as an on-chain rejection, which is
 * what it would have been.
 */
export class SettlementUnsettleableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementUnsettleableError";
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
  /**
   * Resume pending and submitted intents left by a previous process.
   * Delivered-but-untracked nonces are reported as `unknown`.
   */
  reconcile(): Promise<ReconciliationReport>;
  /**
   * Operator recovery: move a failed intent back to pending and submit
   * again. Throws if the nonce has no failed intent.
   */
  retry(nonce: string): Promise<{ transactionHash: Hex }>;
};

export type ReconciliationReport = {
  pending: number;
  submitted: number;
  unknown: string[];
  resumed: string[];
};

export type SettlementRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
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
  retry?: Partial<SettlementRetryOptions>;
}): SettlementQueue {
  const pending = new Set<Promise<void>>();
  const jobs = new Map<string, Promise<SettlementSubmitted>>();
  let count = 0;
  const retry: SettlementRetryOptions = {
    maxAttempts: input.retry?.maxAttempts ?? 3,
    baseDelayMs: input.retry?.baseDelayMs ?? 25,
    sleep: input.retry?.sleep ?? defaultSleep,
  };

  const startJob = (
    s: SettlementInput,
    resumeHash: Hex | null,
    source: "live" | "reconcile" | "retry" = "live",
  ): Promise<SettlementSubmitted> => {
    const existingJob = jobs.get(s.nonce);
    if (existingJob !== undefined) return existingJob;
    let resolveSubmitted!: (value: SettlementSubmitted) => void;
    let rejectSubmitted!: (cause: unknown) => void;
    const submittedP = new Promise<SettlementSubmitted>((resolve, reject) => {
      resolveSubmitted = resolve;
      rejectSubmitted = reject;
    });
    jobs.set(s.nonce, submittedP);

    const job = (async () => {
      if (source !== "live") {
        await recordSettlementRetry({
          store: input.store,
          ctx: ctxFor(s),
          amount: s.amount,
          nonce: s.nonce,
          detail: `source=${source}`,
        });
      }
      let submitted: SettlementSubmitted;
      if (resumeHash !== null) {
        submitted = { transactionHash: resumeHash };
      } else {
        try {
          submitted = await submitWithRetry(
            input.settler,
            input.store,
            s,
            retry,
          );
        } catch (cause) {
          try {
            await markFailed(input, s, cause);
          } finally {
            rejectSubmitted(cause);
          }
          return;
        }
      }

      const life = await lookupByNonce(input.store, s.nonce);
      if ((life?.settlementSubmitted.length ?? 0) === 0) {
        await recordSettlementSubmitted({
          store: input.store,
          ctx: ctxFor(s),
          amount: s.amount,
          nonce: s.nonce,
          transactionHash: submitted.transactionHash,
        });
      }
      await input.store.updateIntent(s.nonce, {
        status: "submitted",
        transactionHash: submitted.transactionHash,
        lastError: null,
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
        await input.store.updateIntent(s.nonce, {
          status: "confirmed",
          transactionHash: submitted.transactionHash,
          lastError: null,
        });
        await invokeHook(() => input.hooks?.onConfirmed?.(s));
        if (source !== "live") {
          await recordSettlementRecovered({
            store: input.store,
            ctx: ctxFor(s),
            amount: s.amount,
            nonce: s.nonce,
            transactionHash: submitted.transactionHash,
            detail: `source=${source}`,
          });
        }
      } catch (cause) {
        await markFailed(input, s, cause);
      } finally {
        count -= 1;
      }
    })();
    pending.add(job);
    job.finally(() => {
      pending.delete(job);
      jobs.delete(s.nonce);
    });
    return submittedP;
  };

  return {
    async enqueue(s) {
      await persistPendingIntent(input.store, s);
      const existing = await input.store.getIntent(s.nonce);
      if (existing?.status === "confirmed") {
        return { transactionHash: existing.transactionHash ?? ("0x" as Hex) };
      }
      if (existing?.status === "failed") {
        throw new Error(
          `settlement intent ${s.nonce} already failed; call retry() to resubmit`,
        );
      }
      const resumeHash =
        existing?.status === "submitted" ? existing.transactionHash : null;
      return {
        transactionHash: (await startJob(s, resumeHash)).transactionHash,
      };
    },
    inFlight() {
      return count;
    },
    async drain() {
      await Promise.allSettled(Array.from(pending));
    },
    reset() {
      pending.clear();
      count = 0;
    },
    async reconcile() {
      const pendingIntents = await input.store.listIntents("pending");
      const submittedIntents = await input.store.listIntents("submitted");
      const unknown = await unknownDeliveryNonces(input.store);
      const resumed: string[] = [];
      for (const intent of [...pendingIntents, ...submittedIntents]) {
        const s = settlementInputFromIntent(intent);
        const resumeHash =
          intent.status === "submitted" ? intent.transactionHash : null;
        void startJob(s, resumeHash, "reconcile").catch(() => {
          // Failure is recorded on the intent; reconcile itself should
          // not reject because one nonce failed.
        });
        resumed.push(intent.nonce);
      }
      return {
        pending: pendingIntents.length,
        submitted: submittedIntents.length,
        unknown,
        resumed,
      };
    },
    async retry(nonce) {
      const intent = await input.store.getIntent(nonce);
      if (intent === null || intent.status !== "failed") {
        throw new Error(`no failed settlement intent for nonce ${nonce}`);
      }
      const s = settlementInputFromIntent(intent);
      if (intent.transactionHash !== null) {
        await input.store.updateIntent(nonce, {
          status: "submitted",
          lastError: null,
        });
        return {
          transactionHash: (await startJob(s, intent.transactionHash, "retry"))
            .transactionHash,
        };
      }
      await input.store.updateIntent(nonce, {
        status: "pending",
        lastError: null,
      });
      await persistPendingIntent(input.store, s);
      return {
        transactionHash: (await startJob(s, null, "retry")).transactionHash,
      };
    },
  };
}

export function settlementIntentFromInput(
  s: SettlementInput,
  now: string = new Date().toISOString(),
): SettlementIntent {
  return {
    nonce: s.nonce,
    streamId: s.streamId,
    sessionPublicKey: s.sessionPublicKey,
    chainId: s.chainId,
    token: s.token,
    tokenDecimals: s.tokenDecimals,
    amount: s.amount,
    payer: s.payer,
    payTo: s.payTo,
    deadline: s.deadline ?? null,
    authorization: s.authorization ?? null,
    status: "pending",
    transactionHash: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function settlementInputFromIntent(intent: SettlementIntent): SettlementInput {
  const input: SettlementInput = {
    nonce: intent.nonce,
    streamId: intent.streamId,
    sessionPublicKey: intent.sessionPublicKey,
    chainId: intent.chainId,
    token: intent.token,
    tokenDecimals: intent.tokenDecimals,
    amount: intent.amount,
    payer: intent.payer,
    payTo: intent.payTo,
  };
  if (intent.deadline !== null) input.deadline = intent.deadline;
  // Reconciliation after a crash has to resubmit a *settleable* tx, so
  // the authorization comes back out of the outbox with everything else.
  if (intent.authorization !== null) input.authorization = intent.authorization;
  return input;
}

async function persistPendingIntent(
  store: LedgerStore,
  s: SettlementInput,
): Promise<void> {
  await store.putIntent(settlementIntentFromInput(s));
}

async function submitWithRetry(
  settler: Settler,
  store: LedgerStore,
  s: SettlementInput,
  retry: SettlementRetryOptions,
): Promise<SettlementSubmitted> {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const current = await store.getIntent(s.nonce);
    await store.updateIntent(s.nonce, {
      attempts: (current?.attempts ?? 0) + 1,
    });
    try {
      return await settler.submitSettle(s);
    } catch (cause) {
      lastCause = cause;
      if (
        cause instanceof SettlerOutOfGasError ||
        cause instanceof SettlementRevertedError ||
        cause instanceof SettlementUnsettleableError
      ) {
        throw cause;
      }
      await store.updateIntent(s.nonce, {
        lastError: cause instanceof Error ? cause.message : String(cause),
      });
      if (attempt === retry.maxAttempts) throw cause;
      const delay = retry.baseDelayMs * 2 ** (attempt - 1);
      await (retry.sleep ?? defaultSleep)(delay);
    }
  }
  throw lastCause;
}

async function markFailed(
  input: { store: LedgerStore; hooks?: SettlementQueueHooks },
  s: SettlementInput,
  cause: unknown,
): Promise<void> {
  const classification: PaymentFailureClassification =
    cause instanceof SettlerOutOfGasError
      ? "settler-out-of-gas"
      : "settlement-reverted";
  const transactionHash =
    cause instanceof SettlementRevertedError ||
    cause instanceof SettlementLostError
      ? cause.transactionHash
      : null;
  const detail = cause instanceof Error ? cause.message : String(cause);
  await recordFailed(input, s, { classification, detail, transactionHash });
  await input.store.updateIntent(s.nonce, {
    status: "failed",
    transactionHash,
    lastError: detail,
  });
}

async function unknownDeliveryNonces(store: LedgerStore): Promise<string[]> {
  const deliveries = await store.listDeliveryNonces();
  const intents = new Set(
    (await store.listIntents()).map((intent) => intent.nonce),
  );
  const entries = await store.entries();
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.nonce === null) continue;
    if (
      entry.event === "settlement.confirmed" ||
      entry.event === "settlement.failed"
    ) {
      settled.add(entry.nonce);
    }
  }
  return deliveries.filter(
    (nonce) => !intents.has(nonce) && !settled.has(nonce),
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
