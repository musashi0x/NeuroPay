import type { Address, Hex } from "@neuro-pay/types";
import { InvalidConfigError, MissingConfigError } from "./errors.js";

/** The subset of `process.env` the config reader needs. Injectable for tests. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_PATTERN = /^-?\d+$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** An unset variable and one set to whitespace are the same thing: absent. */
function raw(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readString(
  env: EnvSource,
  key: string,
  purpose: string,
): string {
  const value = raw(env, key);
  if (value === undefined) {
    throw new MissingConfigError(key, purpose);
  }
  return value;
}

export function readUrl(env: EnvSource, key: string, purpose: string): string {
  const value = readString(env, key, purpose);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidConfigError(
      key,
      `expected an absolute URL, got "${value}"`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidConfigError(
      key,
      `expected an http or https URL, got protocol "${parsed.protocol}"`,
    );
  }

  return value;
}

type IntegerOptions = {
  purpose: string;
  /** Used when the variable is absent. Omit to make the variable required. */
  fallback?: number;
  min?: number;
  max?: number;
};

export function readInteger(
  env: EnvSource,
  key: string,
  options: IntegerOptions,
): number {
  const value = raw(env, key);
  if (value === undefined) {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    throw new MissingConfigError(key, options.purpose);
  }

  if (!INTEGER_PATTERN.test(value)) {
    throw new InvalidConfigError(key, `expected an integer, got "${value}"`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidConfigError(
      key,
      `expected an integer within the safe range, got "${value}"`,
    );
  }

  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (parsed < min || parsed > max) {
    throw new InvalidConfigError(
      key,
      `expected an integer in [${min}, ${max}], got ${parsed}`,
    );
  }

  return parsed;
}

type SmallestUnitsOptions = {
  purpose: string;
  /** Inclusive lower bound. Defaults to 1: a zero cap or threshold is a misconfiguration. */
  min?: bigint;
};

/**
 * Reads a token amount in smallest units.
 *
 * Digits only — a decimal point here means the operator wrote a human-readable
 * amount, which on an 18-decimal token is off by twelve orders of magnitude
 * against a 6-decimal assumption. Rejecting it is cheaper than debugging it.
 */
export function readSmallestUnits(
  env: EnvSource,
  key: string,
  options: SmallestUnitsOptions,
): bigint {
  const value = readString(env, key, options.purpose);

  if (!WHOLE_NUMBER_PATTERN.test(value)) {
    throw new InvalidConfigError(
      key,
      `expected a whole number of smallest token units (digits only, no decimal point or sign), got "${value}"`,
    );
  }

  const parsed = BigInt(value);
  const min = options.min ?? 1n;
  if (parsed < min) {
    throw new InvalidConfigError(
      key,
      `expected at least ${min}, got ${parsed}`,
    );
  }

  return parsed;
}

/** Reads a fraction in `[0, 1)`, such as the budget margin. */
export function readFraction(
  env: EnvSource,
  key: string,
  options: { purpose: string; fallback?: number },
): number {
  const value = raw(env, key);
  if (value === undefined) {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    throw new MissingConfigError(key, options.purpose);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidConfigError(key, `expected a number, got "${value}"`);
  }
  if (parsed < 0 || parsed >= 1) {
    throw new InvalidConfigError(
      key,
      `expected a fraction in [0, 1), got ${value}`,
    );
  }

  return parsed;
}

export function readAddress(
  env: EnvSource,
  key: string,
  purpose: string,
): Address {
  const value = readString(env, key, purpose);
  if (!ADDRESS_PATTERN.test(value)) {
    throw new InvalidConfigError(
      key,
      `expected a 0x-prefixed 20-byte address, got "${value}"`,
    );
  }
  return value as Address;
}

/**
 * Reads a 32-byte private key.
 *
 * The failure message names the variable and the expected shape and never
 * echoes the value, so a malformed key cannot leak a good one through logs.
 */
export function readPrivateKey(
  env: EnvSource,
  key: string,
  purpose: string,
): Hex {
  const value = readString(env, key, purpose);
  if (!PRIVATE_KEY_PATTERN.test(value)) {
    throw new InvalidConfigError(
      key,
      "expected a 0x-prefixed 32-byte hex private key (value withheld)",
    );
  }
  return value as Hex;
}

/** As `readPrivateKey`, but absent is a legitimate answer rather than a failure. */
export function readOptionalPrivateKey(
  env: EnvSource,
  key: string,
): Hex | null {
  if (raw(env, key) === undefined) {
    return null;
  }
  return readPrivateKey(
    env,
    key,
    "wallet admin key, when an admin action runs",
  );
}
