/**
 * The pinned price sheet (5.10).
 *
 * The seller serves one price sheet at any given moment. Streams opened
 * against a particular sheet are pinned to that sheet for the stream's
 * lifetime — a mid-stream price change ends the stream rather than
 * repricing usage already accrued against the prior sheet (see spec,
 * "Both meters agreeing does not make them right").
 *
 * `prices.version` is monotonic and any successful stream open snapshots
 * the entire sheet into the stream record so the segment-delivery path
 * cannot read it out from a moving target.
 */

import { randomUUID } from "node:crypto";
import type {
  Address,
  IsoTimestamp,
  PriceSheet,
  SmallestUnits,
} from "@neuro-pay/types";

/**
 * The fields a seller needs to publish a price sheet. The wire `PriceSheet`
 * is augmented with a stable `id`, a monotonic `version`, and an `issuedAt`
 * so two readers can tell whether they are looking at the same sheet.
 */
export type PriceSheetDraft = {
  perCall: SmallestUnits;
  perSecond: SmallestUnits;
  perUnit: SmallestUnits;
  unitName: string;
};

/** A token the price sheet is denominated in. */
export type PriceSheetToken = {
  chainId: number;
  token: Address;
  tokenDecimals: number;
};

/**
 * The seller's mutable price state: the current sheet plus the listeners
 * that want to be told when the version moves.
 *
 * `listeners` is intentional: streams already opened under the previous
 * version get the chance to end themselves, which is what the spec means
 * by "ends the stream rather than repricing accrued usage".
 */
export type PriceRegistry = {
  current: PriceSheet;
  /** Incrementing version stamp; bumped on every successful update. */
  version: number;
  /** Minted once on construction; the prior version is read off the stream. */
  id: string;
};

export type PriceChangedListener = (
  previous: PriceSheet,
  next: PriceSheet,
) => void;

/**
 * Build the seller's price registry from a draft.
 *
 * `randomId` is injected so a deterministic id is available for tests
 * and a UUID for production. The wall clock is used to stamp `issuedAt`.
 */
export function createPriceRegistry(
  token: PriceSheetToken,
  draft: PriceSheetDraft,
  options?: {
    randomId?: () => string;
    now?: () => IsoTimestamp;
    initialVersion?: number;
    initialId?: string;
  },
): PriceRegistry {
  const randomId = options?.randomId ?? defaultRandomId;
  const now = options?.now ?? defaultClock;
  const id = options?.initialId ?? randomId();
  const current: PriceSheet = {
    id,
    version: options?.initialVersion ?? 1,
    chainId: token.chainId,
    token: token.token,
    tokenDecimals: token.tokenDecimals,
    perCall: draft.perCall,
    perSecond: draft.perSecond,
    perUnit: draft.perUnit,
    unitName: draft.unitName,
    issuedAt: now(),
  };
  return { current, version: current.version, id };
}

/**
 * Apply a new draft, minting a fresh `id` and bumping the version. The
 * old `current` is returned as `previous` so a single caller can fan out
 * to listeners without re-reading the registry.
 *
 * The bump is the trigger for every open stream to end itself (5.10).
 */
export function bumpPriceSheet(
  registry: PriceRegistry,
  draft: PriceSheetDraft,
  options?: { randomId?: () => string; now?: () => IsoTimestamp },
): { previous: PriceSheet; next: PriceSheet } {
  const previous = registry.current;
  const next: PriceSheet = {
    id: (options?.randomId ?? defaultRandomId)(),
    version: registry.version + 1,
    chainId: previous.chainId,
    token: previous.token,
    tokenDecimals: previous.tokenDecimals,
    perCall: draft.perCall,
    perSecond: draft.perSecond,
    perUnit: draft.perUnit,
    unitName: draft.unitName,
    issuedAt: (options?.now ?? defaultClock)(),
  };
  registry.current = next;
  registry.version = next.version;
  registry.id = next.id;
  return { previous, next };
}

function defaultRandomId(): string {
  return randomUUID();
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}
