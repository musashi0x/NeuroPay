/**
 * Immutable delivery records keyed by authorization nonce.
 *
 * `segment.delivered` ledger events carry seconds/units for the auditor
 * but not the exact HTTP payload. Replay must return that payload
 * byte-for-byte, including accrued totals, so the records live beside
 * the event log in the same SQLite file and are never updated.
 */

import type {
  IsoTimestamp,
  SegmentResponse,
  SmallestUnits,
  StreamEndReason,
} from "@neuro-pay/types";

export type DeliveryRecord = {
  nonce: string;
  payload: SegmentResponse;
  recordedAt: IsoTimestamp;
};

export type DeliveryRow = {
  nonce: string;
  stream_id: string;
  sequence: number;
  data: string;
  seconds_delivered: number;
  units_delivered: number;
  accrued_unpaid: string;
  total_accrued: string;
  stream_ended: number;
  end_reason: string | null;
  recorded_at: string;
};

export function encodeDeliveryRecord(record: DeliveryRecord): DeliveryRow {
  return {
    nonce: record.nonce,
    stream_id: record.payload.streamId,
    sequence: record.payload.sequence,
    data: record.payload.data,
    seconds_delivered: record.payload.secondsDelivered,
    units_delivered: record.payload.unitsDelivered,
    accrued_unpaid: record.payload.accruedUnpaid.toString(10),
    total_accrued: record.payload.totalAccrued.toString(10),
    stream_ended: record.payload.streamEnded ? 1 : 0,
    end_reason: record.payload.endReason,
    recorded_at: record.recordedAt,
  };
}

export function decodeDeliveryRow(row: DeliveryRow): DeliveryRecord {
  return {
    nonce: row.nonce,
    recordedAt: row.recorded_at,
    payload: {
      streamId: row.stream_id,
      sequence: row.sequence,
      data: row.data,
      secondsDelivered: row.seconds_delivered,
      unitsDelivered: row.units_delivered,
      accruedUnpaid: BigInt(row.accrued_unpaid) as SmallestUnits,
      totalAccrued: BigInt(row.total_accrued) as SmallestUnits,
      streamEnded: row.stream_ended === 1,
      endReason: row.end_reason as StreamEndReason | null,
    },
  };
}
