/**
 * Deciding whether a chain-backed suite can run at all.
 *
 * These suites need two things the rest of the test tree does not: a way
 * to run anvil, and network access to a fork URL. Neither is guaranteed
 * on a machine that just cloned the repo, and neither is worth failing a
 * build over.
 *
 * So the contract is: **skip with a reason, never fail**. A suite that
 * hard-fails on a missing binary trains people to ignore it or to delete
 * it; a suite that says "install foundry or start Docker, then re-run"
 * gets run. The tradeoff is that a green build does not by itself mean
 * the chain suites passed — which is why `pnpm chain:check` exists to
 * assert the opposite in CI, and why the skip reason is printed rather
 * than silent.
 */

import { resolveRunner, RUNNER_MISSING_MESSAGE } from "./runner.js";

/** Fork endpoint these suites would use, if configured. */
export function forkUrl(): string | undefined {
  return process.env.FORK_RPC_URL ?? process.env.RPC_URL;
}

/**
 * Why a chain suite cannot run, or null when it can.
 *
 * Returns the reason rather than a boolean so the skip message names the
 * *specific* missing piece. "Skipped: no chain" sends someone hunting;
 * "skipped: FORK_RPC_URL is not set" does not.
 */
export function describeSkipReason(): string | null {
  if (!resolveRunner()) return RUNNER_MISSING_MESSAGE;
  if (!forkUrl()) {
    return (
      "no fork endpoint — set FORK_RPC_URL (or RPC_URL) to a BNB testnet " +
      "endpoint. These suites fork a real network because the contracts " +
      "they exercise cannot be deployed from source."
    );
  }
  return null;
}

/** True when a chain-backed suite has everything it needs. */
export function chainAvailable(): boolean {
  return describeSkipReason() === null;
}
