/**
 * Starting and stopping a forked local chain.
 *
 * The handle a test gets back is an RPC URL and a `stop()`. Everything
 * else — which runner, which port, how long the fork took to warm up —
 * is this module's problem.
 *
 * ## The determinism story
 *
 * A fork is only repeatable if the block it forks from is pinned. Left
 * unpinned it follows the head of a public testnet, which means the same
 * test reads different balances, different nonces, and a different
 * session state on two runs an hour apart. `forkBlockNumber` is
 * therefore recorded in config rather than passed per call — see
 * `./fork-config.js` — and a test that needs a specific chain state pins
 * its own.
 *
 * What a fork cannot make hermetic is the *first* run: the fork provider
 * fetches state over the network on demand. Anvil caches what it fetches
 * for the process lifetime, and pinning the block makes that cache
 * reusable across runs, but the network is still a dependency. That is
 * the honest trade for being able to exercise contracts whose source we
 * do not have.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import type { Address, Hex } from "@neuro-pay/types";

import {
  resolveRunner,
  RUNNER_MISSING_MESSAGE,
  type RunnerKind,
} from "./runner.js";

/**
 * Anvil's deterministic development accounts.
 *
 * Derived from the well-known `test test test ... junk` mnemonic that
 * anvil, hardhat, and ganache all default to. Hard-coded rather than
 * derived at runtime so a test can name an account without deriving a
 * key, and safe to commit precisely because every one of these keys is
 * public knowledge and holds nothing on any real network.
 */
export const DEV_ACCOUNTS = [
  {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
    privateKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  },
  {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    privateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  },
  {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address,
    privateKey:
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  },
] as const;

export type LocalChainOptions = {
  /**
   * Network to fork. Defaults to `FORK_RPC_URL`, then `RPC_URL`.
   * Without one, `startLocalChain` throws rather than silently starting
   * a blank chain — a blank chain passes "did it start" and then fails
   * every contract call with a message that does not mention forking.
   */
  forkUrl?: string;
  /** Block to pin the fork at. Omit only for an exploratory run. */
  forkBlockNumber?: bigint;
  /** Chain id the node reports. Defaults to the forked network's. */
  chainId?: number;
  /** Host port. Defaults to an ephemeral free one. */
  port?: number;
  /** How long to wait for the node to answer before giving up. */
  readyTimeoutMs?: number;
  /** Extra anvil flags, appended last. */
  extraArgs?: string[];
  /** Stream the node's stdout/stderr. Off by default; very noisy. */
  verbose?: boolean;
};

export type LocalChain = {
  rpcUrl: string;
  chainId: number;
  runner: RunnerKind;
  /** The block the fork is pinned at, when one was requested. */
  forkBlockNumber: bigint | undefined;
  accounts: typeof DEV_ACCOUNTS;
  /** Terminate the node. Idempotent; safe in an `afterAll` that may double-fire. */
  stop: () => Promise<void>;
};

export class LocalChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalChainUnavailableError";
  }
}

export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export async function startLocalChain(
  options: LocalChainOptions = {},
): Promise<LocalChain> {
  const runner = resolveRunner();
  if (!runner) throw new LocalChainUnavailableError(RUNNER_MISSING_MESSAGE);

  const forkUrl =
    options.forkUrl ?? process.env.FORK_RPC_URL ?? process.env.RPC_URL;
  if (!forkUrl) {
    throw new LocalChainUnavailableError(
      "no fork URL — set FORK_RPC_URL (or RPC_URL) to an archive-capable " +
        "endpoint for the network under test. A blank local chain has none " +
        "of the contracts these suites exercise.",
    );
  }

  const port = options.port ?? (await freePort());
  const anvilArgs = ["--fork-url", forkUrl];
  if (options.forkBlockNumber !== undefined) {
    anvilArgs.push("--fork-block-number", options.forkBlockNumber.toString(10));
  }
  if (options.chainId !== undefined) {
    anvilArgs.push("--chain-id", String(options.chainId));
  }
  // Silence anvil's per-request log; the interesting output is the
  // test's, and a forked run prints a line per RPC call.
  anvilArgs.push("--silent");
  anvilArgs.push(...(options.extraArgs ?? []));

  const child = spawn(runner.command, runner.args(port, anvilArgs), {
    stdio: options.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  // Keep the tail of stderr so a startup failure reports why rather than
  // "timed out". A bad fork URL and an unreachable one look identical
  // from the outside otherwise.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  child.stdout?.resume();

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const rpcUrl = `http://127.0.0.1:${port}`;
  const stop = makeStopper(child, runner.kind);

  try {
    const chainId = await waitForChain(
      rpcUrl,
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      () => exited,
      () => stderr,
    );
    return {
      rpcUrl,
      chainId,
      runner: runner.kind,
      forkBlockNumber: options.forkBlockNumber,
      accounts: DEV_ACCOUNTS,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Poll `eth_chainId` until the node answers.
 *
 * Polling rather than parsing the "Listening on" banner: the banner
 * differs between anvil versions and is suppressed by `--silent`, and
 * under docker the port can be published before the process inside is
 * accepting. A successful RPC round trip is the only signal that means
 * what it needs to mean.
 */
async function waitForChain(
  rpcUrl: string,
  timeoutMs: number,
  exitState: () => { code: number | null; signal: NodeJS.Signals | null } | null,
  stderr: () => string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    const exit = exitState();
    if (exit) {
      throw new LocalChainUnavailableError(
        `the local chain exited before becoming ready (code ${exit.code ?? "null"}` +
          `, signal ${exit.signal ?? "null"}). stderr:\n${stderr().trim() || "(empty)"}`,
      );
    }

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
        signal: AbortSignal.timeout(2_000),
      });
      const body = (await response.json()) as { result?: string };
      if (typeof body.result === "string") return Number(BigInt(body.result));
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await sleep(150);
  }

  throw new LocalChainUnavailableError(
    `the local chain did not answer within ${timeoutMs}ms (last error: ` +
      `${lastError || "none"}). A cold fork can be slow — raise ` +
      `readyTimeoutMs, or check the fork URL. stderr:\n${stderr().trim() || "(empty)"}`,
  );
}

/**
 * Build a `stop()` that actually stops the node.
 *
 * `SIGTERM` then `SIGKILL` after a grace period: anvil exits promptly,
 * but a docker run that is still pulling an image does not, and a test
 * suite that hangs in `afterAll` is worse than one that kills hard.
 */
function makeStopper(
  child: ChildProcess,
  kind: RunnerKind,
): () => Promise<void> {
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exit = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
    // `docker run --rm` removes the container on exit, so there is
    // nothing to clean up beyond the process itself.
    void kind;
  };
}

/**
 * Reserve an ephemeral port by binding and immediately releasing it.
 *
 * Inherently racy — something else can claim the port between the
 * release and anvil's bind — but the window is small, the alternative is
 * a hard-coded port that collides with a second test file, and a failed
 * bind surfaces as a clear startup error rather than silent misbehaviour.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
