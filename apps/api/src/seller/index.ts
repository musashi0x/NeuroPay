/**
 * Seller composition root.
 *
 * Assembles the streams, requirements, verifier, idempotency,
 * exposure, and settler modules into a single `Seller` object the route
 * layer consumes. The router never imports the modules individually —
 * the seller closure is passed to the route, and the route asks it to
 * deliver a segment, returns the response.
 *
 * Settler key material and the production `Verifier` (which reads on
 * chain) are NOT loaded here. The composition root takes injected
 * `Verifier` and `Settler` so a test can compose the seller with an
 * in-memory settler and a stub verifier. The actual composition against
 * `AppConfig` lives in `apps/api/src/index.ts`.
 */

import {
  computeLocalLimit,
  evaluatePolicy,
  systemClock,
  type Clock,
  type MeteringConfig,
} from "@neuro-pay/metering";
import {
  recordPaymentRejected,
  recordSegmentDelivered,
  recordStreamAbandoned,
  recordStreamEnded,
  recordStreamOpened,
  type LedgerStore,
} from "@neuro-pay/ledger";
import type {
  Address,
  Hex,
  IsoTimestamp,
  PaymentFailureClassification,
  PriceSheet,
  SmallestUnits,
  StreamEndReason,
  StreamOpenResponse,
  X402PaymentRequired,
} from "@neuro-pay/types";

import {
  buildPaymentRequired,
  buildSegmentResource,
  descriptionForPriceSheet,
  type BuildRequirementsInput,
} from "./requirements.js";
import {
  createStreamStore,
  type StreamRecord,
  type StreamStore,
} from "./streams.js";
import { type Verifier, verifyEnvelope } from "./verify.js";
import {
  buildReplayResponse,
  type IdempotencyIndex,
  createIdempotencyIndex,
  loadIdempotencyRecord,
  recordSegmentDelivery,
  recordVerification,
} from "./idempotency.js";
import {
  buildExposureRefusal,
  createExposureCounter,
  type ExposureCounter,
  type ExposureRefusal,
  exposureCeiling,
} from "./exposure.js";
import {
  type Settler,
  type SettlementInput,
  type SettlementQueue,
  createSettlementQueue,
  settlementIntentFromInput,
} from "./settle.js";
import { attachSettlementHooks } from "./settlement-hooks.js";
import { logger } from "../logger.js";
import {
  type PriceRegistry,
  bumpPriceSheet,
  createPriceRegistry,
} from "./prices.js";

import { parseEnvelopeFromHeaders } from "./envelope.js";

/**
 * The full seller configuration.
 */
export type SellerConfig = {
  metering: MeteringConfig;
  payTo: Address;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /**
   * The settler EOA that submits `permitWitnessTransferFrom`.
   *
   * Published in every 402 as `extra.spenderAddress` and enforced by the
   * verifier, because Permit2 binds the signed `spender` to `msg.sender`
   * of the settlement call. Distinct from `payTo`: the settler moves the
   * money, `payTo` receives it.
   */
  settlerAddress: Address;
  /** Stream-level ceiling beyond which streams end. */
  streamTtlSeconds?: number;
  /**
   * Most streams that may be open at once, across all callers.
   *
   * The idle sweep already reclaims abandoned streams, but it runs on an
   * interval, and a caller that opens faster than the sweep collects
   * outruns it. This is the standing ceiling that does not depend on how
   * fast anything is: past it, opening fails until something ends.
   * Unset means unbounded, which is only appropriate for a local dev
   * process.
   */
  maxConcurrentStreams?: number;
  maxSecondsPerSegment?: number;
  maxUnitsPerSegment?: number;
};

/**
 * The outcome of a segment request through the seller. Carries either
 * a delivered 200, a `402`, a `404`, or one of the operational refusal
 * shapes. Routes map each to its respective response.
 */
export type SellerOutcome =
  | { kind: "delivered"; status: 200; body: unknown }
  | {
      kind: "payment-required";
      status: 402;
      body: X402PaymentRequired;
      resource: string;
    }
  | { kind: "not-found"; status: 404; reason: string }
  | { kind: "exposure-limit"; status: 503; refusal: ExposureRefusal }
  | {
      kind: "rejected";
      status: 402;
      classification: PaymentFailureClassification;
      detail: string;
      resource: string;
    }
  | { kind: "unavailable"; status: 503; reason: "shutting-down" };

/** Thrown by `openStream` after `shutdown()` has started. */
export class SellerUnavailableError extends Error {
  readonly reason = "shutting-down" as const;
  constructor(message: string = "seller is shutting down") {
    super(message);
    this.name = "SellerUnavailableError";
  }
}

/**
 * Thrown when the seller already holds its maximum number of live
 * streams.
 *
 * Distinct from `SellerUnavailableError` (which means "shutting down",
 * a state that resolves by restarting elsewhere): this one resolves on
 * its own as streams end, so the route answers 503 with `Retry-After`
 * rather than telling the caller the service is going away.
 */
export class StreamCapacityError extends Error {
  readonly live: number;
  readonly ceiling: number;
  constructor(live: number, ceiling: number) {
    super(
      `seller is at its stream ceiling (${live}/${ceiling} live). ` +
        `Retry once an open stream ends or is swept as abandoned.`,
    );
    this.name = "StreamCapacityError";
    this.live = live;
    this.ceiling = ceiling;
  }
}

/**
 * The request the seller answers. It deliberately is HTTP-agnostic so the
 * route layer does not leak through; the route hands the seller the
 * header bag and the URL, and the seller returns an outcome.
 */
export type SegmentRequest = {
  /** Either `streamId` (for the segment request) or absent (for open). */
  streamId?: string;
  /** Stream open extras. */
  open?: {
    payTo: Address;
    segmentProducer: import("./streams.js").SegmentProducer;
    ttlSeconds?: number;
  };
  /** The headers on the segment request, used to read `X-PAYMENT`. */
  headers: { get(name: string): string | null };
  /** The full URL of the request, used as the `resource` field on a 402. */
  requestUrl: string;
  /** Optional clock injection. */
  clock?: Clock;
};

/** The seller handle. */
export type Seller = {
  openStream(input: { requestUrl: string; clock?: Clock }): StreamOpenResponse;
  nextSegment(input: SegmentRequest): Promise<SellerOutcome>;
  /** Read the current price sheet (used by the segment request when building 402s). */
  currentPriceSheet(): PriceSheet;
  /** Update the price sheet (5.10). Closes every active stream. */
  updatePrices(draft: {
    perCall: SmallestUnits;
    perSecond: SmallestUnits;
    perUnit: SmallestUnits;
    unitName: string;
  }): { ended: StreamOpenResponse[] };
  /** Read the exposure ceiling for diagnostics. */
  exposureStats(): {
    inFlight: number;
    ceiling: number;
    ceilingAmount: SmallestUnits;
  };
  /** Drain all pending settlements. */
  drainSettlements(): Promise<void>;
  /**
   * Resume pending/submitted settlement intents from the durable outbox.
   * Call once at process start.
   */
  reconcileSettlements(): Promise<import("./settle.js").ReconciliationReport>;
  /** Operator recovery: resubmit a failed settlement intent. */
  retrySettlement(nonce: string): Promise<{ transactionHash: Hex }>;
  /** False after `shutdown()`; open and next-segment refuse new work. */
  isAccepting(): boolean;
  /**
   * Stop new delivery, end leftover streams, drain the settlement
   * outbox. Does not close the ledger — the runtime does that after.
   */
  shutdown(): Promise<void>;
  /** End idle or expired in-memory streams and record `stream.abandoned`. */
  sweepAbandoned(): Promise<string[]>;
  /** Console inspection: every known stream without the producer callback. */
  inspectStreams(): StreamInspection[];
  /** End every active stream. Used by the kill switch. */
  endAll(reason: StreamEndReason): string[];
};

/** Public stream snapshot — no producer, no private state. */
export type StreamInspection = {
  id: string;
  priceSheet: PriceSheet;
  payTo: Address;
  openedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  endReason: StreamEndReason | null;
  meter: import("@neuro-pay/metering").MeterState;
};

/**
 * Inputs to `createSeller`. Everything the route layer needs is built here.
 */
export type CreateSellerInput = {
  config: SellerConfig;
  store: LedgerStore;
  verifier: Verifier;
  settler: Settler;
  clock?: Clock;
  /** Initial price sheet — optional; defaults to zero-priced. */
  initialPriceSheet?: {
    perCall: SmallestUnits;
    perSecond: SmallestUnits;
    perUnit: SmallestUnits;
    unitName: string;
  };
  /** Mint for stream/price ids; tests override. */
  randomId?: () => string;
  /** Wall clock for issuance; tests override. */
  now?: () => IsoTimestamp;
  /** Optional explicit price registry; tests override. */
  priceRegistry?: PriceRegistry;
  /**
   * Seconds without activity before `sweepAbandoned` ends a stream.
   * Defaults to the stream TTL.
   */
  idleTtlSeconds?: number;
};

/** Build a fully composed seller. */
export function createSeller(input: CreateSellerInput): Seller {
  const clock = input.clock ?? systemClock;
  const priceRegistryOptions = {
    ...(input.randomId ? { randomId: input.randomId } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  const priceRegistry =
    input.priceRegistry ??
    createPriceRegistry(
      {
        chainId: input.config.chainId,
        token: input.config.token,
        tokenDecimals: input.config.tokenDecimals,
      },
      input.initialPriceSheet ?? {
        perCall: 0n,
        perSecond: 0n,
        perUnit: 0n,
        unitName: "unit",
      },
      priceRegistryOptions,
    );

  const streamStoreOptions = {
    ...(input.randomId ? { randomId: input.randomId } : {}),
    ...(input.now ? { now: input.now } : {}),
    defaultTtlSeconds: input.config.streamTtlSeconds ?? 3600,
  };
  const streams: StreamStore = createStreamStore(streamStoreOptions);

  const exposure: ExposureCounter = createExposureCounter({
    maxInFlight: input.config.metering.maxInFlightSettlements,
    settlementThreshold: input.config.metering.settlementThreshold,
  });

  const idempotency: IdempotencyIndex = createIdempotencyIndex();

  const queue: SettlementQueue = createSettlementQueue({
    settler: input.settler,
    store: input.store,
    hooks: attachSettlementHooks({
      streams,
      exposure,
      clock,
    }),
  });
  const enqueued = new Set<Promise<unknown>>();
  let accepting = true;
  const idleTtlSeconds =
    input.idleTtlSeconds ?? input.config.streamTtlSeconds ?? 3600;

  function streamCtx(streamId: string) {
    return {
      streamId,
      sessionPublicKey: null as Hex | null,
      chainId: input.config.chainId,
      token: input.config.token,
      tokenDecimals: input.config.tokenDecimals,
    };
  }

  function noteClosed(
    streamId: string,
    reason: StreamEndReason,
    kind: "ended" | "abandoned",
    detail?: string,
  ): Promise<void> {
    const write =
      kind === "abandoned" ? recordStreamAbandoned : recordStreamEnded;
    return write({
      store: input.store,
      ctx: streamCtx(streamId),
      reason,
      ...(detail !== undefined ? { detail } : {}),
    }).then(
      () => undefined,
      (err: unknown) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            streamId,
            reason,
          },
          "failed to record stream close",
        );
      },
    );
  }

  /**
   * Deliver a segment that nothing is owed for yet.
   *
   * The unpaid path is deliberately thinner than the paid one, and each
   * omission is a consequence of there being no payment rather than a
   * shortcut:
   *
   *  - **No idempotency record.** Idempotency is keyed by the
   *    authorization nonce, and an unpaid request has none. It also has
   *    nothing to protect: replay exists so a buyer cannot be charged
   *    twice for one nonce, and nobody was charged here.
   *  - **No settlement.** There is no authorization to settle.
   *  - **No exposure slot.** Exposure bounds in-flight settlements. The
   *    credit extended here is bounded instead by
   *    `settlementThreshold` — once the accrual reaches it the policy
   *    demands payment and this path stops being taken.
   *
   * The ledger entry is still written, with a null nonce and a zero
   * amount. Without it the demand that eventually fires would be
   * unreconcilable against the segments that produced it.
   */
  function deliverOnCredit(
    streamId: string,
    record: StreamRecord,
    clock: Clock,
  ): SellerOutcome {
    const produced = produceSegment(streamId, record);
    if (produced === null) {
      return {
        kind: "not-found",
        status: 404,
        reason: "stream ended before segment request",
      };
    }

    const nextMeter = streams.recordDelivery(
      streamId,
      {
        secondsDelivered: produced.secondsDelivered,
        unitsDelivered: produced.unitsDelivered,
      },
      clock,
    );
    if (!nextMeter) {
      return { kind: "not-found", status: 404, reason: "stream ended" };
    }

    const segment = {
      streamId,
      sequence: produced.sequence,
      data: produced.data,
      secondsDelivered: produced.secondsDelivered,
      unitsDelivered: produced.unitsDelivered,
      accruedUnpaid: nextMeter.accruedUnpaid,
      totalAccrued: nextMeter.totalAccrued,
      streamEnded: false,
      endReason: null as StreamEndReason | null,
    };

    void recordSegmentDelivered({
      store: input.store,
      ctx: streamCtx(streamId),
      amount: 0n as SmallestUnits,
      nonce: null,
      secondsDelivered: produced.secondsDelivered,
      unitsDelivered: produced.unitsDelivered,
      detail: `segment delivered on credit: ${produced.secondsDelivered}s, ${produced.unitsDelivered}u (accrued ${nextMeter.accruedUnpaid})`,
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          streamId,
          sequence: produced.sequence,
        },
        "failed to record segment.delivered for an unpaid segment",
      );
    });

    return { kind: "delivered", status: 200, body: segment };
  }

  /**
   * Take the next sequence number and produce its segment, clamped to
   * the configured per-segment ceilings. Returns `null` when the stream
   * ended between the request arriving and the sequence being taken.
   *
   * Shared by the paid and unpaid paths so the two cannot drift on what
   * a segment is or how it is bounded.
   */
  function produceSegment(
    streamId: string,
    record: StreamRecord,
  ): {
    sequence: number;
    data: string;
    secondsDelivered: number;
    unitsDelivered: number;
  } | null {
    const sequence = streams.nextSequence(streamId);
    if (sequence === null) return null;
    const maxSeconds = input.config.maxSecondsPerSegment ?? 60;
    const maxUnits = input.config.maxUnitsPerSegment ?? 1000;
    const produced = record.segmentProducer({
      streamId,
      sequence,
      maxSeconds,
      maxUnits,
    });
    return {
      sequence,
      data: produced.data,
      secondsDelivered: Math.max(
        0,
        Math.min(produced.secondsDelivered, maxSeconds),
      ),
      unitsDelivered: Math.max(0, Math.min(produced.unitsDelivered, maxUnits)),
    };
  }

  /**
   * Write the `payment.rejected` audit entry for a refused envelope.
   *
   * Every 402 the seller returns for a *reason* lands here. Without it
   * the ledger cannot tell "the buyer never paid" from "the buyer paid
   * and we refused, because the permit named the wrong spender". The
   * classifications exist precisely so an operator never has to guess,
   * and they were being computed and then thrown away.
   *
   * Fire-and-forget, like `noteClosed`: a ledger write that fails must
   * not turn a well-classified 402 into a 500. The rejection is the
   * answer to the buyer; the entry is the record for the operator, and
   * losing the record is the lesser failure.
   */
  function noteRejected(rejection: {
    streamId: string;
    classification: PaymentFailureClassification;
    detail: string;
    nonce: string | null;
    amount: SmallestUnits | null;
  }): void {
    void recordPaymentRejected({
      store: input.store,
      ctx: streamCtx(rejection.streamId),
      amount: rejection.amount,
      nonce: rejection.nonce,
      classification: rejection.classification,
      detail: rejection.detail,
    }).catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          streamId: rejection.streamId,
          classification: rejection.classification,
        },
        "failed to record payment.rejected",
      );
    });
  }

  /**
   * Close every active stream on a price change (5.10). The price
   * registry stays the same reference; the streams each receive an end
   * signal at the next segment read.
   */
  function closeActiveStreamsOnPriceChange(): StreamOpenResponse[] {
    const ended: StreamOpenResponse[] = [];
    for (const record of activeStreams()) {
      streams.end(record.id, "price-changed");
      noteClosed(record.id, "price-changed", "ended");
      ended.push({
        streamId: record.id,
        priceSheet: record.priceSheet,
        chainId: record.priceSheet.chainId,
        token: record.priceSheet.token,
        tokenDecimals: record.priceSheet.tokenDecimals,
        payTo: record.payTo,
        openedAt: record.openedAt,
        expiresAt: record.expiresAt,
        maxSecondsPerSegment: record.maxSecondsPerSegment,
        maxUnitsPerSegment: record.maxUnitsPerSegment,
      });
    }
    return ended;
  }

  function activeStreams() {
    // The `StreamStore` exposes `get`/`end`; we want a snapshot of all
    // active records so price-change can fan out to each. A `Map.values`
    // over the internal store would be cheaper, but the public surface
    // is small; iterate via `get` and the `ids` we remembered at open.
    const ids = Array.from(activeIds.values());
    const out: StreamRecord[] = [];
    for (const id of ids) {
      const r = streams.get(id);
      if (r && r.endReason === null) out.push(r);
    }
    return out;
  }

  const activeIds = new Set<string>();

  function rememberActive(id: string): void {
    activeIds.add(id);
  }

  /**
   * The seller returned by the composition root. Encapsulates the
   * shared price sheet, the stream store, and the
   * accept-deliver-and-settle pipeline.
   */
  const seller: Seller = {
    openStream({ requestUrl, clock: callerClock }) {
      if (!accepting) throw new SellerUnavailableError();
      const ceiling = input.config.maxConcurrentStreams;
      if (ceiling !== undefined) {
        // Count only live streams: an ended or abandoned record still
        // sits in the store for replay lookups and must not consume a
        // slot it is no longer using.
        const live = streams.list().filter((r) => r.endReason === null).length;
        if (live >= ceiling) {
          throw new StreamCapacityError(live, ceiling);
        }
      }
      const useClock = callerClock ?? clock;
      const openOptions = {
        priceSheet: priceRegistry.current,
        payTo: input.config.payTo,
        maxSecondsPerSegment: input.config.maxSecondsPerSegment ?? 60,
        maxUnitsPerSegment: input.config.maxUnitsPerSegment ?? 1000,
        segmentProducer: producerProxy(useClock),
        ...(input.now ? { now: input.now } : {}),
        ...(input.config.streamTtlSeconds !== undefined
          ? { ttlSeconds: input.config.streamTtlSeconds }
          : {}),
        ...(input.randomId ? { randomId: input.randomId } : {}),
      };
      const response = streams.open(openOptions);
      rememberActive(response.streamId);
      void recordStreamOpened({
        store: input.store,
        ctx: streamCtx(response.streamId),
      }).catch((err: unknown) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            streamId: response.streamId,
          },
          "failed to record stream.opened",
        );
      });
      void requestUrl;
      return response;
    },

    async nextSegment(req: SegmentRequest): Promise<SellerOutcome> {
      if (!accepting) {
        return { kind: "unavailable", status: 503, reason: "shutting-down" };
      }
      const useClock = req.clock ?? clock;
      const streamId = req.streamId;
      if (!streamId) {
        return { kind: "not-found", status: 404, reason: "missing stream id" };
      }
      const record = streams.get(streamId);
      if (!record) {
        return {
          kind: "not-found",
          status: 404,
          reason: "stream ended or unknown",
        };
      }
      if (record.endReason === "session-revoked") {
        // Refused before the envelope is read at all, so there is no
        // nonce and no authorized amount to record.
        noteRejected({
          streamId,
          classification: "session-revoked",
          detail: "session revoked",
          nonce: null,
          amount: null,
        });
        return {
          kind: "rejected",
          status: 402,
          classification: "session-revoked",
          detail: "session revoked",
          resource: req.requestUrl,
        };
      }
      if (record.endReason !== null) {
        return {
          kind: "not-found",
          status: 404,
          reason: "stream ended or unknown",
        };
      }
      streams.touch(streamId);
      if (Date.parse(record.expiresAt) <= useClock.now()) {
        streams.end(streamId, "abandoned");
        noteClosed(streamId, "abandoned", "abandoned", "stream ttl elapsed");
        return {
          kind: "not-found",
          status: 404,
          reason: "stream abandoned",
        };
      }

      const paymentRequired = buildPaymentRequired(
        requirementsFor(req.requestUrl, record.priceSheet, 0n),
      );

      const envelope = parseEnvelopeFromHeaders(req.headers);
      if (envelope.kind === "err") {
        if (envelope.error.kind === "missing") {
          const decision = evaluatePolicy(
            record.meter,
            input.config.metering,
            useClock,
          );
          // Threshold-or-tick: the seller delivers on credit until
          // `accruedUnpaid` reaches the threshold or the tick elapses.
          // A zero demand means nothing is owed *yet*, so answering 402
          // here would ask the buyer to sign for nothing — one wasted
          // signature and one zero-value settlement per segment, which
          // is precisely the per-unit settlement cost the design exists
          // to avoid. Deliver instead, and let the accrual bring the
          // demand around.
          if (decision.demand === 0n) {
            return deliverOnCredit(streamId, record, useClock);
          }
          const body = buildPaymentRequired(
            requirementsFor(req.requestUrl, record.priceSheet, decision.demand),
          );
          return {
            kind: "payment-required",
            status: 402,
            body,
            resource: req.requestUrl,
          };
        }
        // A malformed envelope has no parsable nonce by definition;
        // the error kind is the whole diagnostic.
        const detail = `envelope error: ${envelope.error.kind}`;
        noteRejected({
          streamId,
          classification: "verification-failed",
          detail,
          nonce: null,
          amount: null,
        });
        return {
          kind: "rejected",
          status: 402,
          classification: "verification-failed",
          detail,
          resource: req.requestUrl,
        };
      }

      const parsed = envelope.envelope;
      const demandAmount = readDemandAmount(
        record.meter,
        input.config.metering,
        useClock,
      );

      const verification = await verifyEnvelope(
        {
          envelope: parsed,
          demandedAmount: demandAmount,
          expectedPayTo: input.config.payTo,
          expectedToken: input.config.token,
          expectedChainId: input.config.chainId,
          expectedSpender: input.config.settlerAddress,
          paymentRequired,
        },
        input.verifier,
        useClock,
      );
      if (verification.kind === "fail") {
        // The envelope parsed, so the nonce is real and this entry joins
        // the buyer's other events under `lookupByNonce`. The amount
        // recorded is what the seller demanded, which is the number an
        // operator reading an `amount-underpaid` needs to compare
        // against.
        noteRejected({
          streamId,
          classification: verification.classification,
          detail: verification.detail,
          nonce: parsed.nonce,
          amount: demandAmount,
        });
        return {
          kind: "rejected",
          status: 402,
          classification: verification.classification,
          detail: verification.detail,
          resource: req.requestUrl,
        };
      }

      // Replay path: nonce already verified; serve the cached segment.
      const replay = await isReplay(parsed.nonce, input.store, idempotency);
      if (replay.kind === "replay") {
        return {
          kind: "delivered",
          status: 200,
          body: buildReplayResponse(parsed.nonce, replay.record),
        };
      }
      if (replay.kind === "incomplete") {
        return {
          kind: "not-found",
          status: 404,
          reason: "verified nonce is missing a delivery record",
        };
      }

      // Exposure gate. Only runs after we know the buyer paid; the
      // exposure limit is "credit the seller has extended but not yet
      // settled", which only exists after at least one verified payment.
      if (!exposure.tryAcquire()) {
        return {
          kind: "exposure-limit",
          status: 503,
          refusal: buildExposureRefusal(exposure, {
            maxInFlight: input.config.metering.maxInFlightSettlements,
            settlementThreshold: input.config.metering.settlementThreshold,
          }),
        };
      }

      const produced = produceSegment(streamId, record);
      if (produced === null) {
        exposure.release();
        return {
          kind: "not-found",
          status: 404,
          reason: "stream ended before segment request",
        };
      }
      const { sequence, secondsDelivered, unitsDelivered } = produced;

      // Record the verification + delivery. The verification call writes
      // `payment.verified` first; then `recordSegmentDelivery` writes the
      // matching `segment.delivered` so the lifecycle view sees both.
      const verificationResult = await recordVerification(
        {
          store: input.store,
          index: idempotency,
          nonce: parsed.nonce,
          streamId: streamId,
          sessionPublicKey: null,
          chainId: input.config.chainId,
          token: input.config.token,
          tokenDecimals: input.config.tokenDecimals,
          authorizedAmount: verification.authorized.amount,
        },
        {
          sequence,
          data: produced.data,
          secondsDelivered,
          unitsDelivered,
        },
      );
      if (verificationResult.kind === "duplicate") {
        exposure.release();
        return {
          kind: "delivered",
          status: 200,
          body: buildReplayResponse(parsed.nonce, verificationResult.record),
        };
      }

      const segment = {
        streamId,
        sequence,
        data: produced.data,
        secondsDelivered,
        unitsDelivered,
        accruedUnpaid: 0n,
        totalAccrued: 0n,
        streamEnded: false,
        endReason: null as StreamEndReason | null,
      };
      const nextMeter = streams.recordDelivery(
        streamId,
        { secondsDelivered, unitsDelivered },
        useClock,
      );
      if (!nextMeter) {
        exposure.release();
        return { kind: "not-found", status: 404, reason: "stream ended" };
      }
      segment.accruedUnpaid = nextMeter.accruedUnpaid;
      segment.totalAccrued = nextMeter.totalAccrued;

      await recordSegmentDelivery({
        store: input.store,
        index: idempotency,
        nonce: parsed.nonce,
        segment,
        sessionPublicKey: null,
        chainId: input.config.chainId,
        token: input.config.token,
        tokenDecimals: input.config.tokenDecimals,
        authorizedAmount: verification.authorized.amount,
      });

      // Async settlement. Don't await — return the segment immediately.
      // Exposure is released only on confirmation (via settlement hooks).
      // Failed or lost settlements keep the slot as unrecovered exposure.
      const settlementInput: SettlementInput = {
        nonce: parsed.nonce,
        streamId,
        sessionPublicKey: null,
        chainId: input.config.chainId,
        token: input.config.token,
        tokenDecimals: input.config.tokenDecimals,
        amount: verification.authorized.amount,
        payer: parsed.from,
        payTo: input.config.payTo,
        deadline: parsed.permit.deadline,
        // The buyer's signed data, verbatim. Permit2 rebuilds the digest
        // from these at settlement time, so they travel intact from the
        // envelope through the outbox to the chain settler.
        authorization: {
          signature: parsed.signature,
          spender: parsed.permit.spender,
          witness: parsed.permit.witness!,
        },
      };
      // Persist the intent before returning 200 so a crash cannot lose
      // the work between delivery and submitSettle.
      await input.store.putIntent(settlementIntentFromInput(settlementInput));
      const submitted = queue
        .enqueue(settlementInput)
        .catch((cause: unknown) => {
          logger.warn(
            {
              err: cause instanceof Error ? cause.message : String(cause),
              nonce: settlementInput.nonce,
              streamId,
            },
            "settlement enqueue failed; exposure held as unrecovered",
          );
        });
      enqueued.add(submitted);
      void submitted.finally(() => enqueued.delete(submitted));

      return {
        kind: "delivered",
        status: 200,
        body: segment,
      };
    },

    currentPriceSheet() {
      return priceRegistry.current;
    },

    updatePrices(draft) {
      const bumpOptions = {
        ...(input.randomId ? { randomId: input.randomId } : {}),
        ...(input.now ? { now: input.now } : {}),
      };
      const previous = priceRegistry.current;
      bumpPriceSheet(priceRegistry, draft, bumpOptions);
      const ended = closeActiveStreamsOnPriceChange();
      // A price change ends every open stream, so it is an operator
      // action with a blast radius, not a config tweak. The ledger
      // records the resulting `stream.ended` entries; this records the
      // decision that caused them.
      void input.store
        .appendAudit({
          action: "prices.updated",
          actor: "operator",
          outcome: "succeeded",
          subject: `version:${previous.version}->${priceRegistry.current.version}`,
          detail:
            `perCall=${draft.perCall} perSecond=${draft.perSecond} ` +
            `perUnit=${draft.perUnit} unit=${draft.unitName} ` +
            `endedStreams=${ended.length}`,
        })
        .catch(() => {
          // The price change itself has already happened and is durable
          // in the streams it ended; a failed audit write must not undo
          // it or throw into the caller.
        });
      return { ended };
    },

    exposureStats() {
      return {
        inFlight: exposure.inFlightCount(),
        ceiling: input.config.metering.maxInFlightSettlements,
        ceilingAmount: exposureCeiling({
          maxInFlight: input.config.metering.maxInFlightSettlements,
          settlementThreshold: input.config.metering.settlementThreshold,
        }),
      };
    },

    async drainSettlements() {
      await Promise.allSettled(Array.from(enqueued));
      await queue.drain();
    },

    async reconcileSettlements() {
      const report = await queue.reconcile();
      for (let i = 0; i < report.resumed.length; i += 1) {
        exposure.tryAcquire();
      }
      return report;
    },

    retrySettlement(nonce) {
      return queue.retry(nonce);
    },

    inspectStreams() {
      return streams.list().map((record) => ({
        id: record.id,
        priceSheet: record.priceSheet,
        payTo: record.payTo,
        openedAt: record.openedAt,
        expiresAt: record.expiresAt,
        endReason: record.endReason,
        meter: record.meter,
      }));
    },

    endAll(reason) {
      const ended: string[] = [];
      for (const record of streams.list()) {
        if (record.endReason !== null) continue;
        streams.end(record.id, reason);
        noteClosed(record.id, reason, "ended");
        ended.push(record.id);
      }
      return ended;
    },

    isAccepting() {
      return accepting;
    },

    async shutdown() {
      accepting = false;
      this.endAll("abandoned");
      await this.drainSettlements();
    },

    async sweepAbandoned() {
      const ended = streams.sweepAbandoned(idleTtlSeconds);
      await Promise.all(
        ended.map((record) => noteClosed(record.id, "abandoned", "abandoned")),
      );
      return ended.map((record) => record.id);
    },
  };

  return seller;

  function requirementsFor(
    requestUrl: string,
    sheet: PriceSheet,
    amount: SmallestUnits,
  ): BuildRequirementsInput {
    void computeLocalLimit; // referenced for downstream budget mirroring; reserved.
    return {
      amount,
      chainId: sheet.chainId,
      resource: buildSegmentResource({
        requestUrl,
        streamId: streamIdOf(requestUrl),
      }),
      token: sheet.token,
      tokenDecimals: sheet.tokenDecimals,
      payTo: input.config.payTo,
      description: descriptionForPriceSheet(sheet),
      // A buyer cannot produce a settleable Permit2 signature without
      // knowing which address will call `permitWitnessTransferFrom`, and
      // it is not derivable from anything else in the 402 — so it is
      // published here.
      extra: {
        name: null,
        version: null,
        verifyingContract: null,
        spenderAddress: input.config.settlerAddress,
        assetTransferMethod: "permit2-exact",
      },
    };
  }

  function producerProxy(
    callerClock: Clock,
  ): import("./streams.js").SegmentProducer {
    return ({ maxSeconds, maxUnits }) => ({
      data: "",
      secondsDelivered: Math.max(0, maxSeconds),
      unitsDelivered: Math.max(0, maxUnits),
    });
    void callerClock;
  }

  function streamIdOf(url: string): string {
    const parts = url.split("/");
    return parts[parts.length - 2] ?? "";
  }
}

/* ------- internal helpers shared by the public surface ------- */

function readDemandAmount(
  meter: import("@neuro-pay/metering").MeterState,
  config: MeteringConfig,
  clock: Clock,
): SmallestUnits {
  const decision = evaluatePolicy(meter, config, clock);
  return decision.demand;
}

/**
 * Replay detection: same nonce → same segment, no new cost.
 *
 * Prefers the immutable delivery record in the ledger so a cold
 * in-memory index still returns the original payload. A verified
 * nonce with no delivery record is `incomplete` — never a stub.
 */
async function isReplay(
  nonce: string | null,
  store: LedgerStore,
  index: IdempotencyIndex,
): Promise<
  | { kind: "fresh" }
  | { kind: "replay"; record: import("./idempotency.js").IdempotencyRecord }
  | { kind: "incomplete" }
> {
  if (nonce === null) return { kind: "fresh" };
  const record = await loadIdempotencyRecord(store, index, nonce);
  if (record !== null && record.sequence > 0) {
    return { kind: "replay", record };
  }
  const { isNonceAlreadyVerified } = await import("@neuro-pay/ledger");
  if (await isNonceAlreadyVerified(store, nonce)) {
    return { kind: "incomplete" };
  }
  return { kind: "fresh" };
}

export { computeLocalLimit } from "@neuro-pay/metering";
export type { StreamOpenResponse } from "@neuro-pay/types";
export type {
  OpenStreamInput,
  StreamStore,
  SegmentProducer,
} from "./streams.js";
export type { SellerConfig as _SellerConfigUnused } from "./index.js"; // suppress unused-warning surprises
export type { Verifier } from "./verify.js";
export type { Settler } from "./settle.js";
export type { IdempotencyIndex, IdempotencyRecord } from "./idempotency.js";
export type { ExposureCounter, ExposureRefusal } from "./exposure.js";
export type {
  PriceRegistry,
  PriceSheetDraft,
  PriceSheetToken,
} from "./prices.js";

// Keep the symbol referenced to silence unused-import checks while
// preserving the imports for downstream callers.
void ({} as Hex);
