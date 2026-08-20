/**
 * Approve Permit2 to move the payment token on the payer's behalf.
 *
 *   pnpm --filter @neuro-pay/evm-testnet approve:permit2 -- --yes
 *
 * Permit2 pulls funds with `transferFrom`, so without this allowance
 * every settlement reverts no matter how correct the signature is. The
 * provisioning script does it as part of rail setup; this is the
 * standalone version, needed when the token changes and the rest of the
 * rail is already in place.
 *
 * It sends a plain ERC-20 `approve` from `ADMIN_PRIVATE_KEY`, which
 * works here because the wallet is an EIP-7702 account at the admin
 * EOA's own address — the allowance being set is the wallet's own. It
 * therefore does **not** go through Altana's relay, unlike `grant` and
 * `revoke`.
 */

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const MAX = 2n ** 256n - 1n;

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(): Promise<void> {
  const confirmed = process.argv.includes("--yes");
  const account = privateKeyToAccount(requireEnv("ADMIN_PRIVATE_KEY") as Hex);
  const token = requireEnv("TOKEN_ADDRESS") as Address;
  const chainId = Number.parseInt(process.env.CHAIN_ID ?? "97", 10);
  const chain = chainId === bscTestnet.id ? bscTestnet : bsc;
  const transport = http(requireEnv("RPC_URL"));

  const publicClient = createPublicClient({ chain, transport });
  const [symbol, existing] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: ERC20,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: token,
      abi: ERC20,
      functionName: "allowance",
      args: [account.address, PERMIT2],
    }),
  ]);

  console.log(`token      ${token} (${symbol})`);
  console.log(`owner      ${account.address}`);
  console.log(`spender    ${PERMIT2} (Permit2)`);
  console.log(`allowance  ${existing}`);

  if (existing >= MAX / 2n) {
    console.log("\nAlready approved. Nothing to do.");
    return;
  }
  if (!confirmed) {
    console.log("\nRe-run with --yes to submit the approval.");
    process.exitCode = 1;
    return;
  }

  const walletClient = createWalletClient({ account, chain, transport });
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [PERMIT2, MAX],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`\napprove tx ${hash}  (${receipt.status})`);

  // Read it back: a successful receipt and a correct allowance are
  // different claims.
  const after = await publicClient.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [account.address, PERMIT2],
  });
  console.log(`allowance  ${after}`);
  if (after < MAX / 2n) throw new Error("allowance did not take effect");

  console.log(
    `\nRecord it:\n  pnpm --filter @neuro-pay/altana runbook -- --add approve-token ${account.address} ${hash}`,
  );
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
