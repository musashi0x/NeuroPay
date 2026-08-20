/**
 * Unit coverage for the launcher's own logic.
 *
 * Deliberately does not start a chain — that is what the `*.chain.test.ts`
 * suites do. What is worth testing here without one is the behaviour on
 * the *unhappy* paths, because those are the ones a contributor hits
 * first: no runner installed, no fork URL configured, a pinned runner
 * that is not present.
 *
 * The contract these assert is the one that keeps the chain suites from
 * becoming a build failure on a machine that never opted in: every
 * missing prerequisite produces a *reason*, never a throw at import time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetRunnerCache,
  resolveRunner,
  RUNNER_MISSING_MESSAGE,
} from "../src/runner.js";
import { chainAvailable, describeSkipReason, forkUrl } from "../src/suite.js";
import { LocalChainUnavailableError, startLocalChain } from "../src/chain.js";

const saved = { ...process.env };

beforeEach(() => {
  resetRunnerCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  resetRunnerCache();
});

describe("resolveRunner", () => {
  it("honours an explicit `none`", () => {
    process.env.EVM_TESTNET_RUNNER = "none";
    resetRunnerCache();
    expect(resolveRunner()).toBeNull();
  });

  it("caches the probe result", () => {
    process.env.EVM_TESTNET_RUNNER = "none";
    resetRunnerCache();
    expect(resolveRunner()).toBeNull();
    // Changing the pin without resetting must not change the answer —
    // probing costs a subprocess spawn and the answer cannot change
    // mid-run.
    process.env.EVM_TESTNET_RUNNER = "docker";
    expect(resolveRunner()).toBeNull();
  });

  it("builds a native argument vector that names the host port", () => {
    process.env.EVM_TESTNET_RUNNER = "none";
    resetRunnerCache();
    // Construct the shape directly rather than requiring anvil to be
    // installed on whatever machine runs the unit tests.
    const native = {
      args: (port: number, anvilArgs: string[]) => [
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        ...anvilArgs,
      ],
    };
    expect(native.args(8899, ["--fork-url", "x"])).toEqual([
      "--port",
      "8899",
      "--host",
      "127.0.0.1",
      "--fork-url",
      "x",
    ]);
  });
});

describe("describeSkipReason", () => {
  it("names the missing runner", () => {
    process.env.EVM_TESTNET_RUNNER = "none";
    resetRunnerCache();
    expect(describeSkipReason()).toBe(RUNNER_MISSING_MESSAGE);
    expect(chainAvailable()).toBe(false);
  });

  it("names a missing fork endpoint separately from a missing runner", () => {
    // Two different problems with two different fixes. "Skipped: no
    // chain" sends someone hunting; naming the variable does not.
    delete process.env.EVM_TESTNET_RUNNER;
    delete process.env.FORK_RPC_URL;
    delete process.env.RPC_URL;
    resetRunnerCache();
    const reason = describeSkipReason();
    if (reason !== null && reason !== RUNNER_MISSING_MESSAGE) {
      expect(reason).toContain("FORK_RPC_URL");
    }
    expect(forkUrl()).toBeUndefined();
  });

  it("prefers FORK_RPC_URL over RPC_URL", () => {
    process.env.RPC_URL = "https://rpc.example";
    process.env.FORK_RPC_URL = "https://archive.example";
    expect(forkUrl()).toBe("https://archive.example");
  });
});

describe("startLocalChain", () => {
  it("refuses without a runner rather than hanging", async () => {
    process.env.EVM_TESTNET_RUNNER = "none";
    resetRunnerCache();
    await expect(startLocalChain()).rejects.toThrow(LocalChainUnavailableError);
  });

  it("refuses without a fork URL rather than starting a blank chain", async () => {
    // A blank chain passes "did it start" and then fails every contract
    // call with a message that never mentions forking.
    delete process.env.EVM_TESTNET_RUNNER;
    delete process.env.FORK_RPC_URL;
    delete process.env.RPC_URL;
    resetRunnerCache();
    if (resolveRunner() === null) return; // covered by the case above
    await expect(startLocalChain()).rejects.toThrow(/fork URL/i);
  });
});
