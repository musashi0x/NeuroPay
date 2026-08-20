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

/** A node somebody else started, from `compose.yaml` or otherwise. */
export function externalRpcUrl(): string | undefined {
  const value = process.env.EVM_TESTNET_RPC_URL?.trim();
  return value === undefined || value === "" ? undefined : value;
}

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
  // An already-running node needs neither a local anvil nor a fork URL:
  // it is already forking whatever it was started against.
  if (externalRpcUrl()) return null;
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

/**
 * Announce that a chain suite cannot run — or refuse to let it pass.
 *
 * Skipping is right on a developer machine that never opted in. It is
 * dangerous everywhere else, because a skipped suite and a passing one
 * are reported identically: `pnpm test:chain` prints "7 successful"
 * while running zero of the seventeen tests, and the only trace is a
 * warning scrolling past. That is how coverage quietly stops existing.
 *
 * So CI sets `EVM_TESTNET_REQUIRE=1` and a missing prerequisite becomes
 * a hard failure naming exactly what is absent. Call this once at the
 * top of a chain suite.
 */
export function announceChainSkip(suiteName: string): void {
  const reason = describeSkipReason();
  if (reason === null) return;

  const message = `[chain] ${suiteName} cannot run — ${reason}`;
  if (process.env.EVM_TESTNET_REQUIRE === "1") {
    throw new Error(
      `${message}\n\nEVM_TESTNET_REQUIRE=1 is set, so this is a failure rather ` +
        `than a skip. Unset it to allow skipping locally.`,
    );
  }
  // Printed rather than silent: a suite that vanishes without saying why
  // is one nobody notices has stopped running.
  console.warn(`${message} (skipping)`);
}
