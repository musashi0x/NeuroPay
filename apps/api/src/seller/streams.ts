/**
 * Streams (5.1, 5.2, 5.3).
 *
 * A stream is the lifecycle wrapper around a metered consumption session:
 *
 * - open → assign a stream id, pin a price sheet, return an opaque handle
 *   that the buyer uses to request segments against.
 * - state → the in-memory bookkeeping that is updated after every segment
 *   (accrual, delivered seconds and units, in-flight settlement count).
 * - nextSegment → bounded work: covers up to `maxSecondsPerSegment` or
 *   `maxUnitsPerSegment`, whichever ends first, and reports the actual
 *   seconds and units that were delivered so the buyer's mirror meter
 *   can accrue from observed consumption rather than the seller's
 *   arithmetic (a deliberate redundancy — see §2 of design.md).
 *
 * Streams end for one of the reasons enumerated in `StreamEndReason`; a
 * stream that has ended MUST NOT deliver a new segment, which is what
 * the 404 in `nextSegment` enforces.
 */

import { randomUUID } from "node:crypto";

import {
  accrueCalls,
  accrueSeconds,
  accrueUnits,
  type Clock,
  createMeterState,
  type MeterState,
  settle,
} from "@neuro-pay/metering";
import type {
  Address,
  IsoTimestamp,
  PriceSheet,
  SegmentResponse,
  SmallestUnits,
  StreamEndReason,
  StreamOpenResponse,
} from "@neuro-pay/types";

/**
 * The shape of the deliverer injected at the composition root.
 *
 * Returns the exact payload and the work it covered so the meter can
 * accrue from observed work, not from the budget cap. The producer is
 * free to return less than the cap on either axis; it MUST NOT return
 * more than it was asked to produce on either axis.
 */
export type SegmentProducer = (input: {
  streamId: string;
  sequence: number;
  maxSeconds: number;
  maxUnits: number;
}) => DeliveredWork;

/**
 * The inputs to opening a stream. `segmentProducer` is injected because
 * the actual payload (LLM tokens, frame data, …) is owned by the
 * application, not the seller.
 */
export type OpenStreamInput = {
  priceSheet: PriceSheet;
  payTo: Address;
  maxSecondsPerSegment: number;
  maxUnitsPerSegment: number;
  segmentProducer: SegmentProducer;
  now?: () => IsoTimestamp;
  ttlSeconds?: number;
  randomId?: () => string;
};

/**
 * The in-memory record the seller maintains per active stream. Everything
 * the segment response needs to report is on this record.
 *
 * The stream id is the public key; the seller only ever hands out ids that
 * came back from `openStream`. `endReason === null && endedAt !== null`
 * is the closed-but-still-tracked state: we keep the record around so a
 * late `nextSegment` returns 404 rather than seeing a fresh stream with
 * the same id.
 */
export type StreamRecord = {
  id: string;
  priceSheet: PriceSheet;
  payTo: Address;
  openedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  maxSecondsPerSegment: number;
  maxUnitsPerSegment: number;
  segmentProducer: SegmentProducer;
  /** Monotonic segment counter; zero before the first segment is delivered. */
  sequence: number;
  meter: MeterState;
  /** Set when the stream transitions to ended. */
  endReason: StreamEndReason | null;
  endedAt: IsoTimestamp | null;
  /** Last next-segment or open activity, used for idle sweep. */
  lastActivityAt: IsoTimestamp;
};

/** Open a stream and return the wire response. */
export function openStream(input: OpenStreamInput): {
  record: StreamRecord;
  response: StreamOpenResponse;
} {
  const now = (input.now ?? defaultClock)();
  const ttlSeconds = input.ttlSeconds ?? 3600;
  const id = (input.randomId ?? defaultRandomId)();
  const record: StreamRecord = {
    id,
    priceSheet: input.priceSheet,
    payTo: input.payTo,
    openedAt: now,
    expiresAt: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(),
    maxSecondsPerSegment: input.maxSecondsPerSegment,
    maxUnitsPerSegment: input.maxUnitsPerSegment,
    segmentProducer: input.segmentProducer,
    sequence: 0,
    meter: createMeterState(),
    endReason: null,
    endedAt: null,
    lastActivityAt: now,
  };
  const response: StreamOpenResponse = {
    streamId: id,
    priceSheet: input.priceSheet,
    chainId: input.priceSheet.chainId,
    token: input.priceSheet.token,
    tokenDecimals: input.priceSheet.tokenDecimals,
    payTo: input.payTo,
    openedAt: record.openedAt,
    expiresAt: record.expiresAt,
    maxSecondsPerSegment: input.maxSecondsPerSegment,
    maxUnitsPerSegment: input.maxUnitsPerSegment,
  };
  return { record, response };
}

/** The store the seller maintains over its open streams. */
export type StreamStore = {
  open(input: OpenStreamInput): StreamOpenResponse;
  /**
   * Read a stream by id. Returns `null` for unknown ids; for known ids
   * that have ended, returns the (still-tracked) record so callers can
   * tell "404 the segment" from "404 not your stream".
   */
  get(streamId: string): StreamRecord | null;
  /** Snapshot of every known stream, including ended ones. */
  list(): StreamRecord[];
  /** End a stream with a reason. Idempotent: a second call is a no-op. */
  end(streamId: string, reason: StreamEndReason): StreamRecord | null;
  /** Increment the segment counter for `streamId` and return the new value. */
  nextSequence(streamId: string): number | null;
  /**
   * Accrue a delivered segment into the meter. The default shape is "one
   * segment = one call, and a bounded amount of work that may consume
   * either seconds or units"; the caller passes whichever of the two
   * was the limiting factor. Returns the new meter state.
   */
  recordDelivery(
    streamId: string,
    delivery: {
      secondsDelivered: number;
      unitsDelivered: number;
    },
    clock: Clock,
  ): MeterState | null;
  /**
   * Settle `amount` from the meter for the named stream. Called by the
   * settlement path once on-chain confirms (the semantics in
   * `metering.accrual. settle` are "subtract accrued + restart tick").
   */
  recordSettle(
    streamId: string,
    amount: SmallestUnits,
    clock: Clock,
  ): MeterState | null;
  /** Returns true when the stream is still serving segments. */
  isActive(streamId: string): boolean;
  /** Mark activity so idle sweep does not collect this stream. */
  touch(streamId: string): void;
  /**
   * End active streams past `expiresAt` or idle longer than
   * `idleTtlSeconds`. Returns the records that were newly ended.
   */
  sweepAbandoned(idleTtlSeconds: number): StreamRecord[];
};

export type CreateStreamStoreOptions = {
  randomId?: () => string;
  now?: () => IsoTimestamp;
  /**
   * Default ttl in seconds for an open stream, applied when the caller
   * did not pass one. Defaults to one hour.
   */
  defaultTtlSeconds?: number;
};

/** Build a fresh in-memory stream store. */
export function createStreamStore(
  options: CreateStreamStoreOptions = {},
): StreamStore {
  const records = new Map<string, StreamRecord>();
  const randomId = options.randomId ?? defaultRandomId;
  const now = options.now ?? defaultClock;
  const defaultTtlSeconds = options.defaultTtlSeconds ?? 3600;

  return {
    open(input) {
      const { record, response } = openStream({
        ...input,
        now: input.now ?? now,
        randomId: input.randomId ?? randomId,
        ttlSeconds: input.ttlSeconds ?? defaultTtlSeconds,
      });
      records.set(record.id, record);
      return response;
    },
    get(streamId) {
      return records.get(streamId) ?? null;
    },
    list() {
      return [...records.values()];
    },
    end(streamId, reason) {
      const record = records.get(streamId);
      if (!record) return null;
      if (record.endReason !== null) return record;
      record.endReason = reason;
      record.endedAt = now();
      return record;
    },
    nextSequence(streamId) {
      const record = records.get(streamId);
      if (!record || record.endReason !== null) return null;
      record.sequence += 1;
      return record.sequence;
    },
    recordDelivery(streamId, delivery, clock) {
      const record = records.get(streamId);
      if (!record || record.endReason !== null) return null;
      const sheet = record.priceSheet;
      // Always accrue the per-call charge for the segment itself.
      let next = accrueCalls(record.meter, sheet, 1);
      if (delivery.secondsDelivered > 0) {
        next = accrueSeconds(next, sheet, delivery.secondsDelivered * 1000);
      }
      if (delivery.unitsDelivered > 0) {
        next = accrueUnits(next, sheet, delivery.unitsDelivered);
      }
      record.meter = next;
      void clock; // clock is the interface seam — kept for parity with the policy module even though we don't index time here directly.
      return next;
    },
    recordSettle(streamId, amount, clock) {
      const record = records.get(streamId);
      if (!record || record.endReason !== null) return null;
      record.meter = settle(record.meter, amount, clock);
      return record.meter;
    },
    isActive(streamId) {
      const record = records.get(streamId);
      return record !== undefined && record.endReason === null;
    },
    touch(streamId) {
      const record = records.get(streamId);
      if (!record || record.endReason !== null) return;
      record.lastActivityAt = now();
    },
    sweepAbandoned(idleTtlSeconds) {
      const ts = now();
      const nowMs = Date.parse(ts);
      const idleMs = idleTtlSeconds * 1000;
      const ended: StreamRecord[] = [];
      for (const record of records.values()) {
        if (record.endReason !== null) continue;
        const expired = Date.parse(record.expiresAt) <= nowMs;
        const idle = Date.parse(record.lastActivityAt) + idleMs <= nowMs;
        if (!expired && !idle) continue;
        record.endReason = "abandoned";
        record.endedAt = ts;
        ended.push(record);
      }
      return ended;
    },
  };
}

/** Inputs to requesting the next segment. */
export type NextSegmentInput = {
  store: StreamStore;
  streamId: string;
  /**
   * If set, the segment must cover at most this many seconds of delivery.
   * Defaults to the stream's `maxSecondsPerSegment`.
   */
  maxSeconds?: number;
  /**
   * If set, the segment must cover at most this many units of delivery.
   * Defaults to the stream's `maxUnitsPerSegment`.
   */
  maxUnits?: number;
  /**
   * The amount of work the producer can cover in this segment. The seller
   * picks the smaller of "call limit and caller-supplied cap" for time and
   * units, then asks the producer for the actual workload (which may
   * produce less than the cap). The resulting seconds/units are reported
   * back so the meter can accrue accurately.
   */
  availableSeconds: number;
  availableUnits: number;
};

/** The bounded work a delivered segment covered. */
export type DeliveredWork = {
  data: string;
  secondsDelivered: number;
  unitsDelivered: number;
};

export type NextSegmentError =
  { kind: "unknown-stream" } | { kind: "ended"; reason: StreamEndReason };

export type NextSegmentResult =
  | { kind: "ok"; response: SegmentResponse; meter: MeterState }
  | { kind: "err"; error: NextSegmentError };

/**
 * Run one segment delivery (5.3).
 *
 * Bounded by whichever of "max seconds / max units" runs out first; the
 * segment ends at the moment the producer reports being done, and the
 * caller passes the actual `secondsDelivered` / `unitsDelivered` back in
 * so the meter accrues from observed work, not from the budget cap.
 */
export function deliverNextSegment(
  input: NextSegmentInput,
  clock: Clock,
): NextSegmentResult {
  const record = input.store.get(input.streamId);
  if (!record) return { kind: "err", error: { kind: "unknown-stream" } };
  if (record.endReason !== null) {
    return {
      kind: "err",
      error: { kind: "ended", reason: record.endReason },
    };
  }
  const sequence = input.store.nextSequence(input.streamId);
  if (sequence === null) {
    return { kind: "err", error: { kind: "unknown-stream" } };
  }

  const maxSeconds = Math.min(
    input.maxSeconds ?? record.maxSecondsPerSegment,
    input.availableSeconds,
  );
  const maxUnits = Math.min(
    input.maxUnits ?? record.maxUnitsPerSegment,
    input.availableUnits,
  );

  const produced = record.segmentProducer({
    streamId: record.id,
    sequence,
    maxSeconds,
    maxUnits,
  });

  // Producers are allowed to deliver less than either cap; we clamp here
  // so a buggy producer cannot exceed the budget for the segment.
  const secondsDelivered = Math.max(
    0,
    Math.min(produced.secondsDelivered, maxSeconds),
  );
  const unitsDelivered = Math.max(
    0,
    Math.min(produced.unitsDelivered, maxUnits),
  );

  const nextMeter = input.store.recordDelivery(
    record.id,
    { secondsDelivered, unitsDelivered },
    clock,
  );
  if (!nextMeter) {
    return { kind: "err", error: { kind: "unknown-stream" } };
  }

  const response: SegmentResponse = {
    streamId: record.id,
    sequence,
    data: produced.data,
    secondsDelivered,
    unitsDelivered,
    accruedUnpaid: nextMeter.accruedUnpaid,
    totalAccrued: nextMeter.totalAccrued,
    streamEnded: false,
    endReason: null,
  };
  return { kind: "ok", response, meter: nextMeter };
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function defaultRandomId(): string {
  return randomUUID();
}
