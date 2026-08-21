/**
 * The showcase's buyer loop, as an async iterable.
 *
 * The BFF owns the session key. It opens a stream, then pulls segments
 * via `fetchWithX402`. Each segment yields either a `free` event (no
 * payment needed) or a `paid` event (a 402 was seen and signed). The
 * loop stops on a classified refusal, a network error, or the requested
 * count.
 *
 * Why an async iterable, not a callback or a Promise:
 *
 *  - The route handler turns it into an SSE response one event at a
 *    time, so the browser sees segments as they arrive.
 *  - Tests can `for await (const event of runStream(...))` against a
 *    stubbed fetch and assert the exact event sequence without
 *    mocking a Response stream.
 *  - The function is pure logic — no Next.js imports. The route module
 *    owns the env wiring and the HTTP framing.
 *
 * The configuration object is everything the loop needs to start a run.
 * `fetchImpl` is the injection seam used by tests; production passes
 * `globalThis.fetch` (the altana client defaults to it too).
 */

import {
  SessionStore,
  signerFromPrivateKey,
  createBuyerPaymentContext,
  fetchWithX402,
  PaymentFailureError,
  type Signer,
} from "@neuro-pay/altana";
import { recordPayment } from "@neuro-pay/metering";
import type {
  Address,
  Hex,
  SegmentResponse,
  StreamOpenResponse,
} from "@neuro-pay/types";

/**
 * A single event the BFF streams to the browser. The discriminated
 * union is the wire contract for the page's client component — keep
 * the `kind` literally stable across route + page + tests.
 *
 * `bigint` fields are encoded as decimal strings on the wire (SSE is
 * JSON). The page's client component decodes them back to `bigint` for
 * the amount formatter.
 */
export type RunEvent =
  | {
      kind: "opened";
      runId: string;
      streamId: string;
      chainId: number;
      tokenAddress: Address;
      tokenDecimals: number;
      tokenSymbol: string;
      maxSecondsPerSegment: number;
      maxUnitsPerSegment: number;
      priceSheet: {
        perCall: string;
        perSecond: string;
        perUnit: string;
        unitName: string;
      };
    }
  | {
      kind: "segment";
      runId: string;
      sequence: number;
      delivery: "free" | "paid";
      amount: string | null;
      status: number;
      secondsDelivered: number;
      unitsDelivered: number;
      accruedUnpaid: string;
      totalAccrued: string;
      streamEnded: boolean;
      endReason: string | null;
    }
  | {
      kind: "refused";
      runId: string;
      classification: string;
      message: string;
      sequence: number | null;
    }
  | {
      kind: "budget";
      runId: string;
      tokenSymbol: string;
      localRemaining: string;
      onChainRemaining: string;
      spent: string;
      localLimit: string;
      onChainCap: string;
    }
  | {
      kind: "done";
      runId: string;
      streamId: string;
      totalSegments: number;
      totalPaid: number;
      totalPaidAmount: string;
    }
  | {
      kind: "error";
      runId: string;
      message: string;
    };

/**
 * What the loop needs to start a run. The route handler builds this
 * from `loadShowcaseConfig()` plus a loaded `SessionStore`.
 */
export type RunStreamInput = {
  runId: string;
  requestedSegments: number;
  sellerUrl: string;
  storePath: string;
  privateKey: Hex;
  budgetMargin: number;
  segmentDelayMs: number;
  tokenSymbol: string;
  /** Optional clock seam for tests; the default is a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional fetch injection. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
};

export class RunStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStreamError";
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the showcase loop.
 *
 * Yields events in stream order. The browser sees an `opened` event
 * first, then one event per `next-segment` round trip (either `segment`
 * or `refused`), an optional `budget` after each paid segment, and a
 * `done` or `error` at the end.
 *
 * Errors are reported as `error` events — the route layer never throws
 * out of the generator. The exception is the very first
 * configuration load: if the persisted session or its key is missing,
 * the loop yields a single `error` event and exits.
 */
export async function* runStream(
  input: RunStreamInput,
): AsyncGenerator<RunEvent, void, void> {
  const sleep = input.sleep ?? defaultSleep;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const runId = input.runId;
  const segmentUrl = (): string =>
    `${input.sellerUrl.replace(/\/$/, "")}/v1/streams/{id}/next`;

  let totalSegments = 0;
  let totalPaid = 0;
  let totalPaidAmount = BigInt(0);

  // 1. Load the persisted session and attach the signer.
  let signer: Signer;
  try {
    signer = signerFromPrivateKey(input.privateKey);
  } catch (err) {
    yield {
      kind: "error",
      runId,
      message: `SESSION_PRIVATE_KEY could not be loaded: ${(err as Error).message}`,
    };
    return;
  }

  const store = new SessionStore({
    fileStorePath: input.storePath,
    signerSource: () => signer,
  });

  const wallets = store.list();
  if (wallets.length === 0) {
    yield {
      kind: "error",
      runId,
      message: `No persisted session at ${input.storePath}. Run the provision script with the same private key, then refresh.`,
    };
    return;
  }
  const wallet = wallets[0]!;

  let resolved;
  try {
    resolved = store.resolve(wallet);
  } catch (err) {
    yield {
      kind: "error",
      runId,
      message: `Failed to resolve session for ${wallet}: ${(err as Error).message}`,
    };
    return;
  }
  if (resolved.signer === undefined || resolved.signer === null) {
    yield {
      kind: "error",
      runId,
      message: `signerSource did not yield a signer for ${wallet}.`,
    };
    return;
  }

  // 2. Open a stream on the seller.
  let opened: StreamOpenResponse;
  try {
    const openResp = await fetchImpl(`${input.sellerUrl}/v1/streams`, {
      method: "POST",
    });
    if (!openResp.ok) {
      const text = await openResp.text();
      yield {
        kind: "error",
        runId,
        message: `Open stream failed: ${openResp.status} ${text}`,
      };
      return;
    }
    opened = (await openResp.json()) as StreamOpenResponse;
  } catch (err) {
    yield {
      kind: "error",
      runId,
      message: `Seller unreachable at ${input.sellerUrl}: ${(err as Error).message}`,
    };
    return;
  }

  yield {
    kind: "opened",
    runId,
    streamId: opened.streamId,
    chainId: opened.chainId,
    tokenAddress: opened.token,
    tokenDecimals: opened.tokenDecimals,
    tokenSymbol: input.tokenSymbol,
    maxSecondsPerSegment: opened.maxSecondsPerSegment,
    maxUnitsPerSegment: opened.maxUnitsPerSegment,
    priceSheet: {
      perCall: opened.priceSheet.perCall.toString(10),
      perSecond: opened.priceSheet.perSecond.toString(10),
      perUnit: opened.priceSheet.perUnit.toString(10),
      unitName: opened.priceSheet.unitName,
    },
  };

  // 3. Build the buyer payment context. The altana SDK defaults the
  // budget's tokenSymbol to "token" when the chain config did not name
  // one; the showcase has its own SHOWCASE_TOKEN_SYMBOL env var, so
  // override it after construction. The persisted session's token is
  // still the chain token — only the display label changes.
  let payment;
  try {
    payment = createBuyerPaymentContext({
      persisted: resolved.persisted,
      signer: resolved.signer as Signer,
      chainId: opened.chainId,
      tokenDecimals: opened.tokenDecimals,
      budgetMargin: input.budgetMargin,
    });
  } catch (err) {
    yield {
      kind: "error",
      runId,
      message: `Cannot initialize payment context: ${(err as Error).message}`,
    };
    return;
  }
  payment = {
    ...payment,
    budget: { ...payment.budget, tokenSymbol: input.tokenSymbol },
  };

  // 4. Pull segments.
  const url = segmentUrl().replace("{id}", opened.streamId);
  for (let i = 0; i < input.requestedSegments; i += 1) {
    let result;
    try {
      result = await fetchWithX402(url, { payment, fetchImpl });
    } catch (err) {
      const classification =
        err instanceof PaymentFailureError
          ? err.classification
          : "payment-request-failed";
      yield {
        kind: "refused",
        runId,
        classification,
        message: (err as Error).message,
        sequence: i + 1,
      };
      return;
    }

    const status = result.response.status;
    // Read the body for both logging and stream-end detection. The
    // seller never closes the response stream itself, so the JSON
    // parse is bounded.
    let body: SegmentResponse | null = null;
    try {
      body = (await result.response.clone().json()) as SegmentResponse;
    } catch {
      body = null;
    }

    if (status !== 200 || body === null) {
      // Not a 2xx-delivered segment. Classify by status.
      const classification =
        status === 402
          ? "amount-underpaid"
          : status === 404
            ? "stream-not-found"
            : status === 503
              ? "exposure-limit-reached"
              : "verification-failed";
      yield {
        kind: "refused",
        runId,
        classification,
        message: `Segment ${i + 1} returned status ${status}.`,
        sequence: i + 1,
      };
      return;
    }

    const delivery: "free" | "paid" =
      result.payment !== undefined ? "paid" : "free";
    const amount =
      result.payment !== undefined
        ? result.payment.requirement.maxAmountRequired
        : null;

    if (amount !== null) {
      payment = {
        ...payment,
        budget: recordPayment(payment.budget, amount),
      };
      totalPaid += 1;
      totalPaidAmount += amount;
    }
    totalSegments += 1;

    yield {
      kind: "segment",
      runId,
      sequence: i + 1,
      delivery,
      amount: amount === null ? null : amount.toString(10),
      status,
      secondsDelivered: body.secondsDelivered,
      unitsDelivered: body.unitsDelivered,
      accruedUnpaid: body.accruedUnpaid.toString(10),
      totalAccrued: body.totalAccrued.toString(10),
      streamEnded: body.streamEnded,
      endReason: body.endReason,
    };

    // After a paid segment, surface the live budget window so the
    // page can show "remaining".
    if (amount !== null) {
      yield {
        kind: "budget",
        runId,
        tokenSymbol: payment.budget.tokenSymbol,
        localRemaining: payment.budget.localRemaining.toString(10),
        onChainRemaining: payment.budget.onChainRemaining.toString(10),
        spent: payment.budget.spent.toString(10),
        localLimit: payment.budget.localLimit.toString(10),
        onChainCap: payment.budget.onChainCap.toString(10),
      };
    }

    if (body.streamEnded) break;
    if (i + 1 < input.requestedSegments && input.segmentDelayMs > 0) {
      await sleep(input.segmentDelayMs);
    }
  }

  yield {
    kind: "done",
    runId,
    streamId: opened.streamId,
    totalSegments,
    totalPaid,
    totalPaidAmount: totalPaidAmount.toString(10),
  };
}

/**
 * SSE wire format helper. Render an event as a single `data:` line.
 */
export function renderSseEvent(event: RunEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
