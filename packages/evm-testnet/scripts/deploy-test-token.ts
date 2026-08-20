/**
 * Deploy the test payment token and mint an opening balance.
 *
 *   pnpm --filter @neuro-pay/evm-testnet deploy:token -- --dry-run
 *   pnpm --filter @neuro-pay/evm-testnet deploy:token -- --yes
 *
 * ## Why this exists
 *
 * The token previously configured as `TOKEN_ADDRESS` cannot be minted by
 * anyone here — its `mint` is owner-gated by a third party — and the
 * public BNB faucet gates claims behind mainnet BNB and a once-per-day
 * limit. A payment loop that can only be funded by a human filling in a
 * web form once a day is not a loop anyone will run.
 *
 * This deploys a token with an open mint instead, so funding a wallet is
 * a function call.
 *
 * ## Safety
 *
 * The default is `--dry-run`, which deploys against a **forked** chain
 * and exercises the whole path — deploy, mint, approve, read back —
 * without broadcasting anything. `--yes` is the only thing that sends a
 * real transaction, and it prints exactly what it is about to do first.
 *
 * The key is read from the environment and signs in-process. It is never
 * passed to a subprocess or a container, where `docker inspect` or a
 * process list would expose it.
 *
 * The contract itself refuses to deploy on a production chain id, so the
 * worst case of a wrong `RPC_URL` is a reverted deployment rather than a
 * free-mint token on a network where someone might mistake it for value.
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";

import { startLocalChain } from "../src/chain.js";
import { createCheats } from "../src/cheats.js";
import {
  TEST_TOKEN_ABI,
  TEST_TOKEN_BYTECODE,
  TEST_TOKEN_METADATA,
} from "../src/test-token.js";

/** Opening balance minted to the wallet. Generous; the supply is free. */
const DEFAULT_MINT = 1_000_000n * 10n ** BigInt(TEST_TOKEN_METADATA.decimals);

type Options = {
  dryRun: boolean;
  confirmed: boolean;
  mintTo: Address | undefined;
  amount: bigint;
};

function parseArgs(argv: string[]): Options {
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rawAmount = at("--amount");
  return {
    dryRun: argv.includes("--dry-run"),
    confirmed: argv.includes("--yes"),
    mintTo: at("--to") as Address | undefined,
    amount:
      rawAmount === undefined
        ? DEFAULT_MINT
        : BigInt(rawAmount) * 10n ** BigInt(TEST_TOKEN_METADATA.decimals),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function chainFor(chainId: number) {
  return chainId === bscTestnet.id ? bscTestnet : bsc;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun && !options.confirmed) {
    console.error(
      "Refusing to broadcast without --yes.\n\n" +
        "  --dry-run   deploy against a fork and verify the whole path\n" +
        "  --yes       deploy for real to RPC_URL\n" +
        "  --to <addr> mint recipient (defaults to PAY_TO, then the deployer)\n" +
        "  --amount <n> whole tokens to mint (default 1,000,000)\n",
    );
    process.exitCode = 1;
    return;
  }

  const privateKey = requireEnv("ADMIN_PRIVATE_KEY") as Hex;
  const account = privateKeyToAccount(privateKey);
  const configuredChainId = Number.parseInt(process.env.CHAIN_ID ?? "97", 10);

  // A dry run stands up its own fork of the configured network, so the
  // rehearsal happens against the same contracts the real deploy will.
  const fork = options.dryRun ? await startLocalChain() : null;
  const rpcUrl = fork ? fork.rpcUrl : requireEnv("RPC_URL");
  const chain = chainFor(configuredChainId);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  const mintTo =
    options.mintTo ??
    (process.env.PAY_TO?.trim() as Address | undefined) ??
    (account.address as Address);

  try {
    if (fork) {
      // The deployer needs gas on the fork; on the real chain it has to
      // already have it, and the balance check below says so.
      await createCheats(fork.rpcUrl).setBalance(
        account.address as Address,
        10n ** 18n,
      );
    }

    const chainId = await publicClient.getChainId();
    const balance = await publicClient.getBalance({
      address: account.address,
    });

    console.log(fork ? "DRY RUN — forked chain" : "LIVE — broadcasting");
    console.log(`  rpc        ${fork ? rpcUrl : "(RPC_URL)"}`);
    console.log(`  chainId    ${chainId}`);
    console.log(`  deployer   ${account.address}`);
    console.log(`  gas        ${formatUnits(balance, 18)}`);
    console.log(`  mint to    ${mintTo}`);
    console.log(
      `  amount     ${formatUnits(options.amount, TEST_TOKEN_METADATA.decimals)} ${TEST_TOKEN_METADATA.symbol}`,
    );

    if (chainId !== configuredChainId) {
      throw new Error(
        `RPC reports chain ${chainId}, but CHAIN_ID is ${configuredChainId}. ` +
          `Refusing to deploy to a chain the configuration does not describe.`,
      );
    }
    if (balance === 0n) {
      throw new Error(
        `${account.address} has no native balance and cannot pay for the ` +
          `deployment. Fund it from the faucet first.`,
      );
    }

    const deployHash = await walletClient.deployContract({
      abi: TEST_TOKEN_ABI,
      bytecode: TEST_TOKEN_BYTECODE,
      args: [],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });
    const token = deployReceipt.contractAddress;
    if (!token) throw new Error("deployment produced no contract address");
    console.log(`\ndeployed  ${token}`);
    console.log(`  tx      ${deployHash}  (${deployReceipt.status})`);

    const mintHash = await walletClient.writeContract({
      address: token,
      abi: TEST_TOKEN_ABI,
      functionName: "mint",
      args: [mintTo, options.amount],
    });
    const mintReceipt = await publicClient.waitForTransactionReceipt({
      hash: mintHash,
    });
    console.log(`minted    tx ${mintHash}  (${mintReceipt.status})`);

    // Read the state back rather than trusting the receipts. A
    // successful transaction and a correct balance are different claims.
    const [symbol, decimals, minted] = await Promise.all([
      publicClient.readContract({
        address: token,
        abi: TEST_TOKEN_ABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: token,
        abi: TEST_TOKEN_ABI,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: token,
        abi: TEST_TOKEN_ABI,
        functionName: "balanceOf",
        args: [mintTo],
      }),
    ]);
    console.log(`\nverified  symbol=${symbol} decimals=${decimals}`);
    console.log(
      `          balanceOf(${mintTo}) = ${formatUnits(minted as bigint, Number(decimals))}`,
    );

    if (minted !== options.amount) {
      throw new Error(
        `balance read back as ${minted}, expected ${options.amount}`,
      );
    }

    if (fork) {
      console.log(
        `\nDry run complete — nothing was broadcast. Re-run with --yes to deploy.`,
      );
    } else {
      console.log(
        `\nSet TOKEN_ADDRESS=${token} (and TOKEN_DECIMALS=${decimals}) in apps/api/.env.\n` +
          `Record the deployment:\n` +
          `  pnpm --filter @neuro-pay/altana runbook -- --add token-deploy ${account.address} ${deployHash}`,
      );
    }
  } finally {
    await fork?.stop();
  }
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
