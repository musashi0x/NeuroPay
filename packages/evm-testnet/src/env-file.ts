/**
 * Reading configuration out of a `.env` file for the chain suites.
 *
 * ## Why this is needed at all
 *
 * The API process loads `apps/api/.env` through Node's
 * `--env-file-if-exists`. Vitest does not: Vite reads `.env` files, but
 * only exposes `VITE_`-prefixed keys, and never to `process.env`. So a
 * developer who puts `FORK_RPC_URL` in `apps/api/.env` — the obvious
 * place, next to `RPC_URL` — gets a chain suite that quietly skips.
 *
 * That failure is worse than an error. `pnpm test:chain` reports every
 * task successful while running zero of the seventeen tests, and the
 * only sign is a warning line scrolling past. Loading the file closes
 * the gap between where the value obviously belongs and where the test
 * process actually looks.
 *
 * ## What it deliberately does not do
 *
 * No interpolation, no `export` prefixes, no multi-line values. This
 * parses the handful of plain `KEY=value` lines the chain suites need
 * and nothing else — a fuller dotenv implementation would be a
 * dependency and a source of surprise. Anything it cannot parse it
 * ignores rather than guessing.
 *
 * Values already present in the environment always win, so an inline
 * `FORK_RPC_URL=… pnpm test:chain` still overrides the file.
 */

import { readFileSync } from "node:fs";

/** Keys the chain suites read. Nothing else is copied out of the file. */
export const CHAIN_ENV_KEYS = [
  "FORK_RPC_URL",
  "RPC_URL",
  "EVM_TESTNET_RUNNER",
  "FOUNDRY_IMAGE",
] as const;

/**
 * Parse `KEY=value` lines. Returns an empty record when the file is
 * missing, which is the normal case on a fresh clone and not an error.
 */
export function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one matched pair of surrounding quotes; leave anything else
    // exactly as written.
    if (value.length >= 2) {
      const first = value[0];
      if ((first === '"' || first === "'") && value.endsWith(first)) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * The chain-suite keys from `path`, minus any already set in the
 * environment.
 *
 * Shaped for Vitest's `test.env`, which is why it returns a record
 * rather than mutating `process.env` — a config file that mutates
 * global state as a side effect of being imported is a nasty thing to
 * debug.
 */
export function chainEnvFrom(path: string): Record<string, string> {
  const parsed = parseEnvFile(path);
  const out: Record<string, string> = {};
  for (const key of CHAIN_ENV_KEYS) {
    const fromFile = parsed[key];
    // An inline value on the command line always wins.
    if (
      process.env[key] === undefined &&
      fromFile !== undefined &&
      fromFile !== ""
    ) {
      out[key] = fromFile;
    }
  }
  return out;
}
