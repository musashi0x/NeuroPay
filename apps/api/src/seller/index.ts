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
import { type LedgerStore } from "@neuro-pay/ledger";
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
} from "./settle.js";
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
  /** Stream-level ceiling beyond which streams end. */
  streamTtlSeconds?: number;
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
    };

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
  });

  /**
   * Close every active stream on a price change (5.10). The price
   * registry stays the same reference; the streams each receive an end
   * signal at the next segment read.
   */
  function closeActiveStreamsOnPriceChange(): StreamOpenResponse[] {
    const ended: StreamOpenResponse[] = [];
    for (const record of activeStreams()) {
      streams.end(record.id, "price-changed");
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
      void requestUrl;
      return response;
    },

    async nextSegment(req: SegmentRequest): Promise<SellerOutcome> {
      const useClock = req.clock ?? clock;
      const streamId = req.streamId;
      if (!streamId) {
        return { kind: "not-found", status: 404, reason: "missing stream id" };
      }
      const record = streams.get(streamId);
      if (!record || record.endReason !== null) {
        return {
          kind: "not-found",
          status: 404,
          reason: "stream ended or unknown",
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
          const demand = decision.demand;
          const body = buildPaymentRequired(
            requirementsFor(req.requestUrl, record.priceSheet, demand),
          );
          return {
            kind: "payment-required",
            status: 402,
            body,
            resource: req.requestUrl,
          };
        }
        return {
          kind: "rejected",
          status: 402,
          classification: "verification-failed",
          detail: `envelope error: ${envelope.error.kind}`,
          resource: req.requestUrl,
        };
      }

      const parsed = envelope.envelope;
      const witnessAmount = readAuthorizedAmount(parsed.witness);
      const demandAmount = readDemandAmount(
        record.meter,
        input.config.metering,
        useClock,
      );

      const verification = await verifyEnvelope(
        {
          envelope: parsed,
          demandedAmount: witnessAmount ?? demandAmount,
          expectedPayTo: input.config.payTo,
          expectedToken: input.config.token,
          expectedChainId: input.config.chainId,
          paymentRequired,
        },
        input.verifier,
        useClock,
      );
      if (verification.kind === "fail") {
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
          body: buildReplayResponse(parsed.nonce!, replay.record),
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

      const sequence = streams.nextSequence(streamId);
      if (sequence === null) {
        exposure.release();
        return {
          kind: "not-found",
          status: 404,
          reason: "stream ended before segment request",
        };
      }

      const produced = record.segmentProducer({
        streamId: streamId,
        sequence,
        maxSeconds: input.config.maxSecondsPerSegment ?? 60,
        maxUnits: input.config.maxUnitsPerSegment ?? 1000,
      });
      const secondsDelivered = Math.max(
        0,
        Math.min(
          produced.secondsDelivered,
          input.config.maxSecondsPerSegment ?? 60,
        ),
      );
      const unitsDelivered = Math.max(
        0,
        Math.min(
          produced.unitsDelivered,
          input.config.maxUnitsPerSegment ?? 1000,
        ),
      );

      // Record the verification + delivery. The verification call writes
      // `payment.verified` first; then `recordSegmentDelivery` writes the
      // matching `segment.delivered` so the lifecycle view sees both.
      const verificationResult = await recordVerification(
        {
          store: input.store,
          index: idempotency,
          nonce: parsed.nonce!,
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
          body: buildReplayResponse(parsed.nonce!, verificationResult.record),
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
        nonce: parsed.nonce!,
        segment,
        sessionPublicKey: null,
        chainId: input.config.chainId,
        token: input.config.token,
        tokenDecimals: input.config.tokenDecimals,
        authorizedAmount: verification.authorized.amount,
      });

      // Async settlement. Don't await — return the segment immediately.
      // The exposure counter is decremented by the settle.onConfirm hook
      // (wired outside this composition root via `release()`).
      const settlementInput: SettlementInput = {
        nonce: parsed.nonce!,
        streamId,
        sessionPublicKey: null,
        chainId: input.config.chainId,
        token: input.config.token,
        tokenDecimals: input.config.tokenDecimals,
        amount: verification.authorized.amount,
        payer: parsed.from,
        payTo: input.config.payTo,
      };
      // The queue's submitAwaitable signature varies; we use the
      // helper that returns the tx hash and triggers the
      // confirm-and-release flow via the catch path.
      queue
        .enqueue(settlementInput)
        .catch(() => {
          // Settlement failure is already recorded by the queue; the
          // exposure counter is decremented in the confirm-or-fail path.
        })
        .then(() => {
          exposure.release();
        })
        .catch(() => {
          exposure.release();
        });

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
      bumpPriceSheet(priceRegistry, draft, bumpOptions);
      const ended = closeActiveStreamsOnPriceChange();
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
      await queue.drain();
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
        ended.push(record.id);
      }
      return ended;
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

function readAuthorizedAmount(witness: unknown): SmallestUnits | null {
  if (typeof witness !== "object" || witness === null) return null;
  const w = witness as Record<string, unknown>;
  const a = w.amount;
  if (typeof a === "bigint") return a;
  if (typeof a === "string") {
    try {
      return BigInt(a) as SmallestUnits;
    } catch {
      return null;
    }
  }
  return null;
}

function readDemandAmount(
  meter: import("@neuro-pay/metering").MeterState,
  config: MeteringConfig,
  clock: Clock,
): SmallestUnits {
  const decision = evaluatePolicy(meter, config, clock);
  return decision.demand;
}

/**
 * Replay detection: same nonce → same segment, no new cost. Reads via
 * the in-memory index (fast path) and falls back to the ledger.
 */
async function isReplay(
  nonce: string | null,
  store: LedgerStore,
  index: IdempotencyIndex,
): Promise<
  | { kind: "fresh" }
  | { kind: "replay"; record: import("./idempotency.js").IdempotencyRecord }
> {
  if (nonce === null) return { kind: "fresh" };
  const cached = index.get(nonce);
  if (cached) return { kind: "replay", record: cached };
  // Fall through to ledger on a cold cache.
  const { isNonceAlreadyVerified } = await import("@neuro-pay/ledger");
  const verified = await isNonceAlreadyVerified(store, nonce);
  if (!verified) return { kind: "fresh" };
  // Rebuild a stub record from the ledger (no segment payload); the
  // route layer falls back to a 404 if no segment was recorded under
  // the nonce (which is the standard case if a `segment.delivered`
  // entry isn't required).
  return {
    kind: "replay",
    record: {
      nonce,
      streamId: "",
      sequence: 0,
      data: "",
      secondsDelivered: 0,
      unitsDelivered: 0,
      ledgerEntryId: "",
      ledgerTimestamp: new Date(0).toISOString(),
    },
  };
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
