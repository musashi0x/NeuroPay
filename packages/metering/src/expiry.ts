/**
 * Projected-duration-versus-expiry checks.
 *
 * ## What this module is
 *
 * Two checks that together prevent opening a stream the session cannot
 * finish, and surface the warning that the last tick may not be payable.
 *
 * - **Open check.** A stream whose projected duration extends past the
 *   session's `expiry` is refused at open time. The seller cannot deliver
 *   past `expiry`; opening the stream anyway would just produce a 402 at the
 *   first demand, after delivery, when the meter discovers it cannot sign.
 * - **Warning.** When fewer than one `tickIntervalSeconds` of session
 *   lifetime remains, the next tick may not be payable: settlement can
 *   require a sign step that takes longer than the session has left, and a
 *   demand fired in that window is either paid late or refused, never paid
 *   on time.
 *
 * Both checks take an injected clock so they are testable without a wall
 * clock, and they are pure functions over their inputs — no I/O, no state.
 */

import type { Clock } from "./clock.js";
import type { IsoTimestamp } from "@neuro-pay/types";

/**
 * A duration in seconds, expressed as either a positive finite number or a
 * bigint count of milliseconds.
 *
 * The open check takes a `projectedSeconds`; the warning takes
 * `tickIntervalSeconds` from `MeteringConfig`. Both come from integer
 * inputs in production code, and the helper accepts either form so the
 * caller does not have to convert at the call site.
 */
export type DurationSeconds = number;

/**
 * The outcome of the open-time expiry check. `ok: true` means the stream may
 * be opened; `ok: false` means refused with the reason and the shortfall in
 * seconds so the operator can read the gap exactly.
 */
export type OpenExpiryCheckResult =
  | { ok: true }
  | { ok: false; reason: "projected-past-expiry"; shortfallSeconds: number };

/**
 * The outcome of the near-expiry warning.
 *
 * `warn: false` means plenty of session lifetime left. `warn: true` carries
 * the remaining lifetime in seconds so the caller can surface "next tick
 * may not be payable, N seconds left".
 */
export type ExpiryWarning = {
  warn: boolean;
  remainingSeconds: number;
};

/**
 * Check that a stream's projected duration fits inside the session's
 * remaining lifetime.
 *
 * `expiresAt` is the session's absolute expiry, in ISO-8601 with
 * millisecond precision. `projectedSeconds` is the caller's estimate of how
 * long the stream will run — bounded above by `maxSecondsPerSegment` per
 * segment and by the buyer's intent. The check refuses the open when
 * `now + projectedSeconds > expiresAt`.
 *
 * Throws on malformed timestamps so a misconfigured session does not slip
 * through as "fits" by accident.
 */
export function checkStreamOpenFitsExpiry(
  projectedSeconds: DurationSeconds,
  expiresAt: IsoTimestamp,
  clock: Clock,
): OpenExpiryCheckResult {
  if (!Number.isFinite(projectedSeconds) || projectedSeconds < 0) {
    throw new RangeError(
      `checkStreamOpenFitsExpiry: projectedSeconds must be a non-negative finite number, received ${projectedSeconds}`,
    );
  }

  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    throw new RangeError(
      `checkStreamOpenFitsExpiry: expiresAt is not a valid ISO timestamp, received ${expiresAt}`,
    );
  }

  const projectedEndMs = clock.now() + projectedSeconds * 1000;
  if (projectedEndMs > expiryMs) {
    const shortfallMs = projectedEndMs - expiryMs;
    return {
      ok: false,
      reason: "projected-past-expiry",
      shortfallSeconds: Math.ceil(shortfallMs / 1000),
    };
  }

  return { ok: true };
}

/**
 * Surface a warning when fewer than `tickIntervalSeconds` of session
 * lifetime remains.
 *
 * The threshold is `tickIntervalSeconds`, not zero: a session expiring in
 * the next millisecond can still sign, but a demand fired during that gap
 * cannot reliably settle before the session ends, and the seller should
 * know not to start a new stream.
 *
 * The remaining lifetime is in whole seconds, rounded up: under a half
 * second remaining rounds to 1 so the caller can compare against a whole-
 * second tick interval without a separate ceiling.
 */
export function checkApproachingExpiry(
  expiresAt: IsoTimestamp,
  tickIntervalSeconds: number,
  clock: Clock,
): ExpiryWarning {
  if (!Number.isFinite(tickIntervalSeconds) || tickIntervalSeconds < 0) {
    throw new RangeError(
      `checkApproachingExpiry: tickIntervalSeconds must be a non-negative finite number, received ${tickIntervalSeconds}`,
    );
  }

  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    throw new RangeError(
      `checkApproachingExpiry: expiresAt is not a valid ISO timestamp, received ${expiresAt}`,
    );
  }

  const remainingMs = Math.max(0, expiryMs - clock.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return {
    warn: remainingSeconds < tickIntervalSeconds,
    remainingSeconds,
  };
}
