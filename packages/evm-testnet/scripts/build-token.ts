/**
 * Compile `contracts/NeuroPayTestUSD.sol` and regenerate
 * `src/test-token.ts`.
 *
 * `pnpm --filter @neuro-pay/evm-testnet build:token`
 *
 * Only needed when the contract changes. The generated artifact is
 * committed so deploying requires no Solidity toolchain — see the header
 * of the generated file for why.
 *
 * Compilation runs through whichever foundry this machine has: the
 * native `forge` if installed, otherwise the same Docker image the test
 * chain uses. Compilation only — deployment never touches a container,
 * because a private key passed to `docker run` shows up in
 * `docker inspect` and in the daemon's logs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FOUNDRY_IMAGE, resolveRunner } from "../src/runner.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = `${packageRoot}/out/NeuroPayTestUSD.sol/NeuroPayTestUSD.json`;
const OUTPUT = `${packageRoot}/src/test-token.ts`;

function compile(): void {
  const runner = resolveRunner();
  if (runner?.kind === "native") {
    execFileSync("forge", ["build"], { cwd: packageRoot, stdio: "inherit" });
    return;
  }
  if (runner?.kind === "docker") {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${packageRoot}:/w`,
        "-w",
        "/w",
        "--entrypoint",
        "forge",
        FOUNDRY_IMAGE,
        "build",
      ],
      { stdio: "inherit" },
    );
    return;
  }
  throw new Error(
    "no foundry available — install it (`brew install foundry`) or start " +
      "Docker. Only needed to regenerate the artifact; deploying uses the " +
      "committed one.",
  );
}

function generate(): void {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
    bytecode: { object: string };
    metadata?: { compiler?: { version?: string } };
  };
  const compiler = artifact.metadata?.compiler?.version ?? "unknown";

  const source = `/**
 * Compiled artifact for \`contracts/NeuroPayTestUSD.sol\`.
 *
 * Generated — do not edit by hand. Regenerate with:
 *
 *   pnpm --filter @neuro-pay/evm-testnet build:token
 *
 * Checked in on purpose. Deploying should not require a Solidity
 * toolchain: the compile happens once, on a machine that has one, and
 * everyone else deploys the exact bytes that were reviewed. It also
 * means the deploy script has no build step between reading the
 * artifact and broadcasting it.
 *
 * Compiler: solc ${compiler} (optimizer on, 200 runs)
 */

import type { Hex } from "@neuro-pay/types";

export const TEST_TOKEN_ABI = ${JSON.stringify(artifact.abi, null, 2)} as const;

export const TEST_TOKEN_BYTECODE: Hex =
  "${artifact.bytecode.object}";

/** Matches the constants in the contract. */
export const TEST_TOKEN_METADATA = {
  name: "NeuroPay Test USD",
  symbol: "npUSD",
  decimals: 18,
} as const;
`;

  writeFileSync(OUTPUT, source);
  const size = (artifact.bytecode.object.length - 2) / 2;
  console.log(`wrote ${OUTPUT} (${size} bytes of bytecode, solc ${compiler})`);
}

compile();
generate();
