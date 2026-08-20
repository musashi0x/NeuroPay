/**
 * `@neuro-pay/evm-testnet` — a repeatable local EVM for integration work.
 *
 * Starts a forked chain on demand, hands back an RPC URL, and gives
 * tests the cheat codes that make a chain behave like a fixture:
 * assignable balances, impersonation, instant blocks, snapshot/revert.
 *
 * ## Why a fork rather than a blank chain
 *
 * Three of the five things the integration list has to exercise —
 * ERC-1271 verification, the session keystore, and revoke — live inside
 * Altana's own contracts, which this project consumes through
 * `@altananetwork/sdk` and has neither the source nor the bytecode for.
 * There is nothing to deploy to a blank chain. Forking puts every
 * contract at its real address, including Permit2 and the real ERC-20
 * with its real `decimals()`.
 *
 * ## What "repeatable" does and does not mean here
 *
 * Repeatable in the sense that matters most: a destructive test can run
 * as often as you like. `withSnapshot` restores chain state afterwards,
 * so revoke — which on a public testnet you can perform exactly once per
 * grant — becomes an ordinary test.
 *
 * Not repeatable in the sense of byte-identical state across runs, and
 * the reason is a property of the network rather than a choice made
 * here. Determinism needs a pinned fork block, and the public BNB
 * testnet endpoints are **pruned**: state older than roughly a thousand
 * blocks answers `missing trie node`. `forkBlockNumber` is supported and
 * is the right thing to use, but it only works against an archive
 * endpoint. Point `FORK_RPC_URL` at one and pin the block; otherwise the
 * fork follows the head, and a test must set up whatever state it
 * depends on rather than assuming it.
 *
 * That is why the cheat codes are the interesting half of this package,
 * not the launcher.
 *
 * ## Usage
 *
 * ```ts
 * const chain = await startLocalChain();
 * const cheats = createCheats(chain.rpcUrl);
 * await cheats.setBalance(someAddress, 10n ** 18n);
 * // ... drive the loop against chain.rpcUrl ...
 * await chain.stop();
 * ```
 *
 * In a suite, prefer `describeChain` from `./suite.js`: it skips with a
 * message naming both install paths when no runner is available, rather
 * than failing a build on a machine that never opted in.
 */

export {
  DEV_ACCOUNTS,
  DEFAULT_READY_TIMEOUT_MS,
  LocalChainUnavailableError,
  startLocalChain,
} from "./chain.js";
export type { LocalChain, LocalChainOptions } from "./chain.js";

export { createCheats, withSnapshot } from "./cheats.js";
export type { Cheats } from "./cheats.js";

export {
  FOUNDRY_IMAGE,
  RUNNER_MISSING_MESSAGE,
  resetRunnerCache,
  resolveRunner,
} from "./runner.js";
export type { Runner, RunnerKind } from "./runner.js";

export {
  announceChainSkip,
  chainAvailable,
  describeSkipReason,
  forkUrl,
} from "./suite.js";

export { chainEnvFrom, parseEnvFile, CHAIN_ENV_KEYS } from "./env-file.js";

export {
  TEST_TOKEN_ABI,
  TEST_TOKEN_BYTECODE,
  TEST_TOKEN_METADATA,
} from "./test-token.js";
