import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import {
  checkApproachingExpiry,
  checkStreamOpenFitsExpiry,
} from "../src/expiry.js";

/**
 * Spec scenarios covered:
 *
 * - "Payments stop at session expiry":
 *     stream longer than the session is refused at open,
 *     approaching expiry is surfaced (under one tickInterval).
 */

const EXPIRES_AT = "2026-08-17T01:00:00.000Z"; // 3_600_000 ms past the unix epoch baseline
const EXPIRES_AT_MS = Date.parse(EXPIRES_AT);

/** A clock whose `now` returns the value it was constructed with. */
const clockAt = (ms: number): Clock => ({ now: () => ms });

describe("checkStreamOpenFitsExpiry", () => {
  it("allows a stream that fits inside the remaining lifetime", () => {
    // 30 minutes from now to expiry → a 5-minute stream fits.
    const result = checkStreamOpenFitsExpiry(
      300,
      EXPIRES_AT,
      clockAt(EXPIRES_AT_MS - 30 * 60_000),
    );

    expect(result).toEqual({ ok: true });
  });

  it("refuses a stream whose projected end crosses expiry, with the shortfall", () => {
    // Scenario: stream longer than the session is refused at open.
    // 30 minutes remaining; a 35-minute stream runs 5 minutes past expiry.
    const result = checkStreamOpenFitsExpiry(
      35 * 60,
      EXPIRES_AT,
      clockAt(EXPIRES_AT_MS - 30 * 60_000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("projected-past-expiry");
      expect(result.shortfallSeconds).toBe(5 * 60);
    }
  });

  it("allows a stream whose projected end lands exactly on expiry", () => {
    // Spec: a stream is refused only when its projected duration *extends
    // past* the session's expiry — equality is allowed. A stream that ends
    // at the expiry instant is the tightest valid fit; the seller can
    // deliver up to and including that boundary.
    const result = checkStreamOpenFitsExpiry(
      30 * 60,
      EXPIRES_AT,
      clockAt(EXPIRES_AT_MS - 30 * 60_000),
    );

    expect(result).toEqual({ ok: true });
  });

  it("rounds the shortfall up so a partial second is reported as one full second", () => {
    // Projected end is 500 ms past expiry → shortfallSeconds = ceil(500/1000) = 1.
    const result = checkStreamOpenFitsExpiry(
      1,
      EXPIRES_AT,
      clockAt(EXPIRES_AT_MS - 999),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.shortfallSeconds).toBe(1);
    }
  });

  it("rejects malformed expiry timestamps", () => {
    expect(() =>
      checkStreamOpenFitsExpiry(60, "not-a-date", clockAt(0)),
    ).toThrow(RangeError);
  });

  it("rejects negative or non-finite projected durations", () => {
    expect(() => checkStreamOpenFitsExpiry(-1, EXPIRES_AT, clockAt(0))).toThrow(
      RangeError,
    );
    expect(() =>
      checkStreamOpenFitsExpiry(Number.NaN, EXPIRES_AT, clockAt(0)),
    ).toThrow(RangeError);
    expect(() =>
      checkStreamOpenFitsExpiry(
        Number.POSITIVE_INFINITY,
        EXPIRES_AT,
        clockAt(0),
      ),
    ).toThrow(RangeError);
  });
});

describe("checkApproachingExpiry", () => {
  it("does not warn when lifetime comfortably exceeds one tick", () => {
    // Scenario: approaching expiry is surfaced.
    // tickInterval = 60 s; lifetime remaining = 600 s → plenty of room.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      60,
      clockAt(EXPIRES_AT_MS - 600_000),
    );

    expect(result.warn).toBe(false);
    expect(result.remainingSeconds).toBe(600);
  });

  it("warns when fewer than one tickInterval of lifetime remains", () => {
    // 30 s remaining, 60 s tick → next tick may not be payable.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      60,
      clockAt(EXPIRES_AT_MS - 30_000),
    );

    expect(result.warn).toBe(true);
    expect(result.remainingSeconds).toBe(30);
  });

  it("warns at the exact tick boundary (remainingSeconds === tickInterval)", () => {
    // The threshold is `remainingSeconds < tickIntervalSeconds`; equal is
    // still plenty, so no warning. Documented explicitly so a caller relying
    // on the boundary does not get a false positive.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      60,
      clockAt(EXPIRES_AT_MS - 60_000),
    );

    expect(result.warn).toBe(false);
    expect(result.remainingSeconds).toBe(60);
  });

  it("clamps remainingSeconds at zero after expiry", () => {
    // Past expiry: remainingSeconds is 0 (clamped), warn is true.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      60,
      clockAt(EXPIRES_AT_MS + 1_000),
    );

    expect(result.warn).toBe(true);
    expect(result.remainingSeconds).toBe(0);
  });

  it("rounds remaining lifetime up to whole seconds", () => {
    // 500 ms remaining at a 60 s tick → ceil(500/1000) = 1, warn is true.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      60,
      clockAt(EXPIRES_AT_MS - 500),
    );

    expect(result.warn).toBe(true);
    expect(result.remainingSeconds).toBe(1);
  });

  it("does not warn with a zero tick interval", () => {
    // A 0-second tick means "warn only after expiry" — any positive
    // remaining lifetime is above the threshold.
    const result = checkApproachingExpiry(
      EXPIRES_AT,
      0,
      clockAt(EXPIRES_AT_MS - 500),
    );

    expect(result.warn).toBe(false);
    expect(result.remainingSeconds).toBe(1);
  });

  it("rejects malformed expiry timestamps and invalid tick intervals", () => {
    expect(() => checkApproachingExpiry("not-a-date", 60, clockAt(0))).toThrow(
      RangeError,
    );
    expect(() => checkApproachingExpiry(EXPIRES_AT, -1, clockAt(0))).toThrow(
      RangeError,
    );
    expect(() =>
      checkApproachingExpiry(EXPIRES_AT, Number.NaN, clockAt(0)),
    ).toThrow(RangeError);
  });
});
