/**
 * Start a forked local chain and leave it running.
 *
 * `pnpm --filter @neuro-pay/evm-testnet chain`
 *
 * For driving the API against a local chain by hand: point `RPC_URL` at
 * the printed URL, run the seller, and use the printed dev accounts for
 * gas. The tests start their own chain per suite and do not need this.
 *
 * Ctrl-C stops the node. `--fork-block <n>` pins the fork, which only
 * works against an archive endpoint — the public BNB testnet endpoints
 * are pruned past roughly a thousand blocks.
 */

import { createCheats } from "../src/cheats.js";
import { startLocalChain } from "../src/chain.js";
import { describeSkipReason } from "../src/suite.js";

async function main(): Promise<void> {
  const reason = describeSkipReason();
  if (reason) {
    console.error(`cannot start a local chain: ${reason}`);
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const blockIndex = args.indexOf("--fork-block");
  const forkBlockNumber =
    blockIndex >= 0 && args[blockIndex + 1]
      ? BigInt(args[blockIndex + 1] as string)
      : undefined;

  const chain = await startLocalChain({
    ...(forkBlockNumber !== undefined ? { forkBlockNumber } : {}),
    verbose: args.includes("--verbose"),
  });
  const cheats = createCheats(chain.rpcUrl);
  const block = await cheats.blockNumber();

  console.log(`local chain up via ${chain.runner}`);
  console.log(`  rpc      ${chain.rpcUrl}`);
  console.log(`  chainId  ${chain.chainId}`);
  console.log(
    `  block    ${block}${forkBlockNumber === undefined ? " (following head)" : " (pinned)"}`,
  );
  console.log(
    `  accounts ${chain.accounts.map((a) => a.address).join("\n           ")}`,
  );
  console.log(`\nCtrl-C to stop.`);

  const shutdown = (): void => {
    void chain.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Hold the event loop open; the node runs until a signal arrives.
  await new Promise<never>(() => {});
}

void main();
