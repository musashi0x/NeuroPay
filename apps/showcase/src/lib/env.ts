/**
 * Read the showcase's server-side configuration.
 *
 * The showcase is a BFF: the browser never sees these values. Each
 * function reads from `process.env` at call time, so a missing
 * session private key only fails on the first Run — not on app boot.
 * That matches the design intent (the page must still render with the
 * empty-state copy when the session is unprovisioned).
 *
 * Three values are required to start a run:
 *  - SELLER_URL: defaults to http://localhost:4000.
 *  - SESSION_STORE_PATH: required, the session store produced by
 *    the altana provision script.
 *  - SESSION_PRIVATE_KEY: required, the session key that signed the grant.
 *
 * The defaults below are deliberately small so a stock 8-segment run
 * does not bump the seller's exposure limit.
 */

const DEFAULT_SELLER_URL = "http://localhost:4000";
const DEFAULT_BUDGET_MARGIN = 0.2;
const DEFAULT_SEGMENT_DELAY_MS = 500;
const DEFAULT_DEFAULT_SEGMENTS = 8;
const DEFAULT_TOKEN_SYMBOL = "npUSD";
const MAX_SEGMENTS_PER_RUN = 20;

export class ShowcaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShowcaseConfigError";
  }
}

export type ShowcaseConfig = {
  sellerUrl: string;
  sessionStorePath: string;
  sessionPrivateKey: `0x${string}`;
  budgetMargin: number;
  segmentDelayMs: number;
  defaultSegments: number;
  tokenSymbol: string;
  maxSegmentsPerRun: number;
};

/**
 * Read a single env var, trimmed; throw if blank or missing.
 *
 * The outer shell may define SESSION_PRIVATE_KEY as an empty string to
 * "disable" it; we treat that the same as missing because the run loop
 * cannot sign without a key.
 */
function readRequired(name: string): string {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    throw new ShowcaseConfigError(
      `${name} is required. The showcase cannot start a run without it. See the example env file shipped with this package.`,
    );
  }
  return raw;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function readSessionPrivateKey(): `0x${string}` {
  const raw = readRequired("SESSION_PRIVATE_KEY");
  if (!PRIVATE_KEY_PATTERN.test(raw)) {
    throw new ShowcaseConfigError(
      "SESSION_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key.",
    );
  }
  return raw as `0x${string}`;
}

function readFraction(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new ShowcaseConfigError(
      `${name} must be a fraction in [0, 1); received '${raw}'.`,
    );
  }
  return value;
}

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ShowcaseConfigError(
      `${name} must be a positive integer; received '${raw}'.`,
    );
  }
  return value;
}

/**
 * Resolve the full configuration. Called once per Run request so the
 * server picks up env changes between sessions without a restart.
 */
export function loadShowcaseConfig(): ShowcaseConfig {
  return {
    sellerUrl: process.env.SELLER_URL?.trim() || DEFAULT_SELLER_URL,
    sessionStorePath: readRequired("SESSION_STORE_PATH"),
    sessionPrivateKey: readSessionPrivateKey(),
    budgetMargin: readFraction("BUDGET_MARGIN", DEFAULT_BUDGET_MARGIN),
    segmentDelayMs: readInteger("SEGMENT_DELAY_MS", DEFAULT_SEGMENT_DELAY_MS),
    defaultSegments: readInteger("DEFAULT_SEGMENTS", DEFAULT_DEFAULT_SEGMENTS),
    tokenSymbol:
      process.env.SHOWCASE_TOKEN_SYMBOL?.trim() || DEFAULT_TOKEN_SYMBOL,
    maxSegmentsPerRun: MAX_SEGMENTS_PER_RUN,
  };
}

/**
 * How many segments a Run request should actually attempt.
 *
 * The caller picks the count; the BFF caps it at MAX_SEGMENTS_PER_RUN
 * and falls back to the configured default when the caller passes
 * nothing usable. 0/negative/NaN inputs collapse to the default.
 */
export function resolveSegments(
  requested: unknown,
  config: ShowcaseConfig,
): number {
  let value: number;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    value = Math.floor(requested);
  } else {
    value = config.defaultSegments;
  }
  if (value <= 0) value = config.defaultSegments;
  if (value > config.maxSegmentsPerRun) value = config.maxSegmentsPerRun;
  return value;
}
