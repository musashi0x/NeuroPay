/**
 * The chain-backed suites, run separately from the unit tests.
 *
 * Separate because they are a different kind of test with different
 * costs: each one boots a forked EVM, needs network access, and takes
 * seconds rather than milliseconds. Folding them into `pnpm test` would
 * make the fast feedback loop slow and make a green build depend on
 * Docker being up.
 *
 * `pnpm test` excludes `*.chain.test.ts`; this config runs only those.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { chainEnvFrom } from "@neuro-pay/evm-testnet";

/**
 * Vitest does not load `.env` files into `process.env` — Vite reads them
 * but only exposes `VITE_`-prefixed keys. Without this, a `FORK_RPC_URL`
 * sitting in `apps/api/.env` (the obvious place, beside `RPC_URL`) is
 * invisible here and every chain suite skips while the run still reports
 * success. An inline value on the command line still wins.
 */
const envFromFile = chainEnvFrom(
  fileURLToPath(new URL("../../apps/api/.env", import.meta.url)),
);

export default defineConfig({
  test: {
    environment: "node",
    env: envFromFile,
    include: ["**/*.chain.test.ts"],
    // One forked chain per file, and forks are the expensive part.
    // Running files sequentially keeps the container count to one at a
    // time and the ports from colliding.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
