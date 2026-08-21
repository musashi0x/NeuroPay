/**
 * Env loader unit tests.
 *
 * The loader reads from `process.env` at call time. We swap the store
 * with a snapshot per test so the runner does not have to stub
 * `process.env` globally.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadShowcaseConfig,
  resolveSegments,
  ShowcaseConfigError,
} from "../src/lib/env";

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string>): void {
  // Clear keys we care about, then apply overrides.
  for (const key of [
    "SELLER_URL",
    "SESSION_STORE_PATH",
    "SESSION_PRIVATE_KEY",
    "BUDGET_MARGIN",
    "SEGMENT_DELAY_MS",
    "DEFAULT_SEGMENTS",
    "SHOWCASE_TOKEN_SYMBOL",
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

beforeEach(() => {
  setEnv({});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadShowcaseConfig", () => {
  it("throws when SESSION_PRIVATE_KEY is missing", () => {
    expect(() => loadShowcaseConfig()).toThrowError(ShowcaseConfigError);
  });

  it("throws when SESSION_PRIVATE_KEY is not a 0x-prefixed 32-byte key", () => {
    setEnv({
      SESSION_PRIVATE_KEY: "0x1234",
      SESSION_STORE_PATH: "/tmp/x",
    });
    expect(() => loadShowcaseConfig()).toThrowError(/0x-prefixed 32-byte/);
  });

  it("returns defaults when fully populated", () => {
    setEnv({
      SELLER_URL: "http://localhost:4000",
      SESSION_STORE_PATH: "/tmp/session.json",
      SESSION_PRIVATE_KEY: "0x" + "aa".repeat(32),
      BUDGET_MARGIN: "0.1",
      SEGMENT_DELAY_MS: "123",
      DEFAULT_SEGMENTS: "5",
      SHOWCASE_TOKEN_SYMBOL: "npUSD",
    });
    const config = loadShowcaseConfig();
    expect(config.sellerUrl).toBe("http://localhost:4000");
    expect(config.budgetMargin).toBe(0.1);
    expect(config.segmentDelayMs).toBe(123);
    expect(config.defaultSegments).toBe(5);
    expect(config.tokenSymbol).toBe("npUSD");
    expect(config.maxSegmentsPerRun).toBe(20);
  });

  it("rejects out-of-range BUDGET_MARGIN", () => {
    setEnv({
      SESSION_STORE_PATH: "/tmp/session.json",
      SESSION_PRIVATE_KEY: "0x" + "aa".repeat(32),
      BUDGET_MARGIN: "1.5",
    });
    expect(() => loadShowcaseConfig()).toThrowError(/fraction/i);
  });

  it("falls back to default SELLER_URL when unset", () => {
    setEnv({
      SESSION_STORE_PATH: "/tmp/session.json",
      SESSION_PRIVATE_KEY: "0x" + "aa".repeat(32),
    });
    const config = loadShowcaseConfig();
    expect(config.sellerUrl).toBe("http://localhost:4000");
  });

  it("falls back to default SHOWCASE_TOKEN_SYMBOL when unset", () => {
    setEnv({
      SESSION_STORE_PATH: "/tmp/session.json",
      SESSION_PRIVATE_KEY: "0x" + "aa".repeat(32),
    });
    const config = loadShowcaseConfig();
    expect(config.tokenSymbol).toBe("npUSD");
  });
});

describe("resolveSegments", () => {
  const config = {
    sellerUrl: "http://localhost:4000",
    sessionStorePath: "/tmp/x",
    sessionPrivateKey: "0x" + "aa".repeat(32),
    budgetMargin: 0.2,
    segmentDelayMs: 0,
    defaultSegments: 8,
    tokenSymbol: "npUSD",
    maxSegmentsPerRun: 20,
  };

  it("returns the default when no count is given", () => {
    expect(resolveSegments(undefined, config)).toBe(8);
  });

  it("returns the default when given a non-number", () => {
    expect(resolveSegments("10", config)).toBe(8);
  });

  it("clamps to the max when the request exceeds it", () => {
    expect(resolveSegments(100, config)).toBe(20);
  });

  it("floors fractional input", () => {
    expect(resolveSegments(3.7, config)).toBe(3);
  });

  it("falls back to default when the value is zero or negative", () => {
    expect(resolveSegments(0, config)).toBe(8);
    expect(resolveSegments(-5, config)).toBe(8);
  });
});
