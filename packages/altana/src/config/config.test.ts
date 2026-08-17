import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MARGIN,
  DEFAULT_CHAIN_ID,
  DEFAULT_MAX_IN_FLIGHT_SETTLEMENTS,
  DEFAULT_SESSION_LIFETIME_SECONDS,
  DEFAULT_SESSION_SPEND_PERIOD_SECONDS,
  DEFAULT_TICK_INTERVAL_SECONDS,
  loadAppConfig,
} from "./config.js";
import type { EnvSource } from "./env.js";
import { InvalidConfigError, MissingConfigError } from "./errors.js";

const SETTLER_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const ADMIN_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

/** Only the values that have no default. Everything else falls back. */
const MINIMAL_ENV: EnvSource = {
  RPC_URL: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  TOKEN_ADDRESS: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
  TOKEN_DECIMALS: "18",
  PAY_TO: "0x000000000000000000000000000000000000dEaD",
  SETTLER_PRIVATE_KEY: SETTLER_KEY,
  SESSION_SPEND_CAP: "10",
  SETTLEMENT_THRESHOLD: "50000000000000000",
};

function envWithout(key: string): EnvSource {
  return Object.fromEntries(
    Object.entries(MINIMAL_ENV).filter(([name]) => name !== key),
  );
}

function envWith(overrides: Record<string, string>): EnvSource {
  return { ...MINIMAL_ENV, ...overrides };
}

describe("loadAppConfig defaults", () => {
  it("applies every documented default when only required values are set", () => {
    const config = loadAppConfig(MINIMAL_ENV);

    expect(config.chain.chainId).toBe(DEFAULT_CHAIN_ID);
    expect(config.chain.chainId).toBe(97);
    expect(config.session.lifetimeSeconds).toBe(
      DEFAULT_SESSION_LIFETIME_SECONDS,
    );
    expect(config.session.spendPeriodSeconds).toBe(
      DEFAULT_SESSION_SPEND_PERIOD_SECONDS,
    );
    expect(config.metering.budgetMargin).toBe(DEFAULT_BUDGET_MARGIN);
    expect(config.metering.tickIntervalSeconds).toBe(
      DEFAULT_TICK_INTERVAL_SECONDS,
    );
    expect(config.metering.maxInFlightSettlements).toBe(
      DEFAULT_MAX_IN_FLIGHT_SETTLEMENTS,
    );
  });

  it("reads amounts as exact bigints, not floats", () => {
    const config = loadAppConfig(MINIMAL_ENV);

    // SESSION_SPEND_CAP is whole tokens; SETTLEMENT_THRESHOLD is smallest units.
    expect(config.session.spendCap).toBe(10n);
    expect(config.metering.settlementThreshold).toBe(50_000_000_000_000_000n);
  });

  it("treats a missing admin key as a running agent process, not a failure", () => {
    expect(loadAppConfig(MINIMAL_ENV).secrets.adminPrivateKey).toBeNull();
    expect(
      loadAppConfig(envWith({ ADMIN_PRIVATE_KEY: ADMIN_KEY })).secrets
        .adminPrivateKey,
    ).toBe(ADMIN_KEY);
  });

  it("honours explicit overrides", () => {
    const config = loadAppConfig(
      envWith({
        CHAIN_ID: "56",
        TOKEN_DECIMALS: "6",
        BUDGET_MARGIN: "0.5",
        TICK_INTERVAL_SECONDS: "5",
        MAX_IN_FLIGHT_SETTLEMENTS: "1",
      }),
    );

    expect(config.chain.chainId).toBe(56);
    expect(config.chain.tokenDecimals).toBe(6);
    expect(config.metering.budgetMargin).toBe(0.5);
    expect(config.metering.tickIntervalSeconds).toBe(5);
    expect(config.metering.maxInFlightSettlements).toBe(1);
  });
});

describe("loadAppConfig missing required values", () => {
  const required = [
    "RPC_URL",
    "TOKEN_ADDRESS",
    "TOKEN_DECIMALS",
    "PAY_TO",
    "SETTLER_PRIVATE_KEY",
    "SESSION_SPEND_CAP",
    "SETTLEMENT_THRESHOLD",
  ];

  it.each(required)("fails with a named error when %s is unset", (key) => {
    expect(() => loadAppConfig(envWithout(key))).toThrowError(
      MissingConfigError,
    );

    try {
      loadAppConfig(envWithout(key));
      expect.unreachable(`${key} should be required`);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigError);
      expect((error as MissingConfigError).name).toBe("MissingConfigError");
      expect((error as MissingConfigError).variable).toBe(key);
      expect((error as MissingConfigError).message).toContain(key);
    }
  });

  it.each(required)("treats %s set to whitespace as unset", (key) => {
    expect(() => loadAppConfig(envWith({ [key]: "   " }))).toThrowError(
      MissingConfigError,
    );
  });
});

describe("loadAppConfig malformed values", () => {
  const cases: Array<[string, string]> = [
    ["RPC_URL", "not-a-url"],
    ["RPC_URL", "ftp://example.invalid"],
    ["TOKEN_ADDRESS", "0xdeadbeef"],
    ["TOKEN_DECIMALS", "18.0"],
    ["PAY_TO", "not-an-address"],
    ["CHAIN_ID", "0"],
    ["SESSION_SPEND_CAP", "-10"],
    ["SESSION_SPEND_CAP", "10.5.5"],
    ["SESSION_SPEND_CAP", "+10"],
    ["SESSION_SPEND_CAP", "1e3"],
    ["SETTLEMENT_THRESHOLD", "-1"],
    ["BUDGET_MARGIN", "1"],
    ["BUDGET_MARGIN", "-0.1"],
    ["TICK_INTERVAL_SECONDS", "0"],
    ["MAX_IN_FLIGHT_SETTLEMENTS", "0"],
  ];

  it.each(cases)("rejects %s=%s with a named error", (key, value) => {
    try {
      loadAppConfig(envWith({ [key]: value }));
      expect.unreachable(`${key}=${value} should be rejected`);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).name).toBe("InvalidConfigError");
      expect((error as InvalidConfigError).variable).toBe(key);
    }
  });

  it("accepts a fractional whole-token count (e.g. \"10.5\")", () => {
    expect(() =>
      loadAppConfig(envWith({ SESSION_SPEND_CAP: "10" })),
    ).not.toThrow();
    expect(() =>
      loadAppConfig(envWith({ SESSION_SPEND_CAP: "10.5" })),
    ).not.toThrow();
    // The decimals hazard still applies to smallest-unit amounts.
    expect(() =>
      loadAppConfig(envWith({ SETTLEMENT_THRESHOLD: "10.000000" })),
    ).toThrowError(InvalidConfigError);
  });
});

describe("loadAppConfig secret handling", () => {
  it("never echoes a private key in an error message", () => {
    const malformed = `${SETTLER_KEY}ff`;

    try {
      loadAppConfig(envWith({ SETTLER_PRIVATE_KEY: malformed }));
      expect.unreachable("a malformed settler key should be rejected");
    } catch (error) {
      const message = (error as Error).message;
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(message).toContain("SETTLER_PRIVATE_KEY");
      expect(message).not.toContain(malformed);
      expect(message).not.toContain(SETTLER_KEY);
    }
  });

  it("rejects a malformed admin key rather than silently ignoring it", () => {
    expect(() =>
      loadAppConfig(envWith({ ADMIN_PRIVATE_KEY: "0xnope" })),
    ).toThrowError(InvalidConfigError);
  });
});
