/**
 * Locating an EVM to run against.
 *
 * ## Why this is a fork, not a fresh chain
 *
 * The obvious shape for a local integration environment is a blank chain
 * plus deploy scripts. That does not work here, and the reason is worth
 * stating because it is the whole design constraint.
 *
 * Three of the five things this environment has to exercise — ERC-1271
 * verification, the session keystore, and revoke — run inside **Altana's
 * own contracts**: the smart account whose `isValidSignature` validates a
 * session-key signature, and the keystore that `isValidKey` reads and
 * `revokeSession` writes. This project consumes those through
 * `@altananetwork/sdk` and has neither their source nor their bytecode.
 * There is nothing to deploy to a blank chain.
 *
 * Forking an existing network sidesteps that entirely. Every contract is
 * already there at its real address — Permit2, the ERC-20 with its real
 * `decimals()`, the Altana deployments, and any session already granted
 * against them. What the fork adds is what a public testnet will not
 * give you: instant blocks, unlimited gas, arbitrary balances, the
 * ability to impersonate an account you do not hold the key for, and
 * snapshot/revert so a destructive test (revoke) runs as many times as
 * you like.
 *
 * ## Why two runners
 *
 * `anvil` is a native binary that has to be installed. Docker is already
 * on most machines that run this repo and needs nothing installed
 * system-wide. Both are supported and detected in that order, because a
 * native binary starts in ~50ms and a container in ~1s, and this gets
 * called per test file.
 *
 * Neither being present is **not** a failure. `resolveRunner` returns
 * null and the integration suites skip with a message naming both
 * install paths. A repeatable environment nobody can run because it hard
 * -fails on a missing binary is worse than one that says what it needs.
 */

import { execFileSync } from "node:child_process";

export type RunnerKind = "native" | "docker";

export type Runner = {
  kind: RunnerKind;
  /** Executable to spawn. */
  command: string;
  /**
   * Full argument vector for an anvil listening on `port` of the host.
   *
   * A function rather than a static prefix because the two runners
   * disagree about what "listen on port N" means: native anvil takes
   * `--port N`, while the container always listens on 8545 internally
   * and docker maps the host port onto it.
   */
  args: (port: number, anvilArgs: string[]) => string[];
  /** Human description for skip messages and logs. */
  describe: string;
};

/** The published foundry image. Pinned by tag, not digest — see README. */
export const FOUNDRY_IMAGE =
  process.env.FOUNDRY_IMAGE ?? "ghcr.io/foundry-rs/foundry:latest";

/**
 * Whether a command exists and answers.
 *
 * `--version` rather than `which`: a binary on `PATH` that cannot
 * actually execute (wrong architecture, broken symlink, a shim pointing
 * at an uninstalled toolchain) passes a path lookup and fails at spawn
 * time, which is a much more confusing failure to debug from inside a
 * test.
 */
function responds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

let cached: Runner | null | undefined;

/**
 * Find a usable anvil, preferring the native binary.
 *
 * Cached for the process: probing costs a subprocess spawn each time and
 * the answer cannot change mid-run.
 */
export function resolveRunner(): Runner | null {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

/** Test hook: forget the cached probe result. */
export function resetRunnerCache(): void {
  cached = undefined;
}

function detect(): Runner | null {
  const forced = process.env.EVM_TESTNET_RUNNER;
  if (forced === "none") return null;

  if (forced !== "docker" && responds("anvil", ["--version"])) {
    return {
      kind: "native",
      command: "anvil",
      args: (port, anvilArgs) => [
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        ...anvilArgs,
      ],
      describe: "native anvil",
    };
  }

  if (forced !== "native" && responds("docker", ["info"])) {
    return {
      kind: "docker",
      command: "docker",
      args: (port, anvilArgs) => [
        "run",
        // Leaves nothing behind when a test run is killed.
        "--rm",
        // Real PID 1 in the container, so SIGTERM reaches anvil instead
        // of being swallowed and leaving an orphan holding the port.
        "--init",
        "-p",
        `127.0.0.1:${port}:8545`,
        // The foundry image's entrypoint is a shell wrapper, so passing
        // `anvil` as the first *argument* makes it `$0` rather than the
        // command — anvil then starts with no flags at all and quietly
        // ignores the port and fork settings. Overriding the entrypoint
        // is what makes the arguments below mean what they say.
        "--entrypoint",
        "anvil",
        FOUNDRY_IMAGE,
        // Inside the container anvil must bind all interfaces or the
        // published port maps onto nothing.
        "--host",
        "0.0.0.0",
        ...anvilArgs,
      ],
      describe: `anvil via docker (${FOUNDRY_IMAGE})`,
    };
  }

  return null;
}

/**
 * One line explaining what to install, for a skipped suite.
 *
 * Written as instructions rather than an error because the common reader
 * is someone who just cloned the repo and ran the tests.
 */
export const RUNNER_MISSING_MESSAGE =
  "no local EVM available — install foundry (`brew install foundry`, or " +
  "https://getfoundry.sh) or start Docker, then re-run. Set " +
  "EVM_TESTNET_RUNNER=native|docker|none to pin the choice.";
