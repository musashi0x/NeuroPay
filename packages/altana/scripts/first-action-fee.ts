#!/usr/bin/env tsx
/**
 * Operator probe: does the first admin action on a fresh wallet really
 * cost double?
 *
 * Run with `pnpm --filter @neuro-pay/altana probe:fee -- --yes`.
 *
 * ## What was wrong with the existing evidence
 *
 * The 2026-08-19 run noted that the grant transaction burned 968,320 gas
 * while each approve burned ~120,000–130,000, and read that as the
 * doubled first-action fee. It is not evidence for that claim: a grant
 * writes a session key, its spend caps, and its call allowlist, while an
 * approve flips one storage slot. Those two costs would differ by a
 * large factor whether or not `initialRegisterKey` rides along with the
 * first action. Comparing them measures how much more work a grant does.
 *
 * ## The experiment this runs
 *
 * Hold the action constant and vary only whether it is first.
 *
 *   A. On a **fresh** wallet, grant a session key. This is the wallet's
 *      first admin action, so any one-time registration is bundled into
 *      it.                                       -> gasFirstGrant
 *   B. On the **same** wallet, grant a second session key with a
 *      different signer. Identical operation, no longer first.
 *                                                -> gasSecondGrant
 *
 * `gasFirstGrant / gasSecondGrant` is the ratio the doubling claim is
 * about, and `gasFirstGrant - gasSecondGrant` is the one-time cost in
 * gas. A grant is the right operation to measure because the observed
 * 968,320-gas figure that started this question was a grant.
 *
 * As a control, the probe then approves two different signature
 * checkers and reports their gas too. If the surcharge were charged per
 * action rather than once per wallet, the first approval would carry it
 * and the second would not.
 *
 * Two *different* session keys and two *different* checker addresses,
 * rather than the same one twice: repeating an identical call writes an
 * unchanged storage slot and costs less for a reason that has nothing to
 * do with registration.
 *
 * ## What it needs
 *
 * A **fresh** wallet, funded with testnet BNB for gas and nothing else.
 * Freshness is the whole experiment — reusing a wallet that has already
 * taken an admin action measures nothing, so the script derives the
 * wallet from `FEE_PROBE_ADMIN_KEY` (never `ADMIN_PRIVATE_KEY`) and
 * refuses to run if that wallet has already been used.
 *
 * ## Flags
 *
 *   --yes        Required. Submits four real transactions (two grants, two approvals).
 *   --address    Print the wallet address to fund, then exit. Run this
 *                first, fund the address, then run again with --yes.
 */

import { loadAppConfig } from "../src/config/config.js";
import { buildAltanaClient } from "../src/client.js";
import { provisionWallet } from "../src/wallet.js";
import { SessionStore } from "../src/session/store.js";
import { grantSession } from "../src/session/grant.js";
import {
  approveSignatureChecker,
  signerFromPrivateKey,
  PERMIT2_ADDRESS,
  type ExecuteResult,
} from "@altananetwork/sdk";
import { generatePrivateKey } from "viem/accounts";
import type { Address, Hex } from "@neuro-pay/types";
import { record, waitForReceipt } from "./runbook.js";

/**
 * The second checker address.
 *
 * Any address works — the Keystore stores an approval flag against it
 * and never calls it during this probe. A burn address keeps the
 * approval inert if the probe wallet is ever reused for something else.
 */
const SECOND_CHECKER: Address = "0x000000000000000000000000000000000000dEaD";

function requireFreshAdminKey(): Hex {
  const key = process.env["FEE_PROBE_ADMIN_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error(
      "FEE_PROBE_ADMIN_KEY is required and must be a NEW key whose wallet has " +
        "never taken an admin action. The probe measures what the first " +
        "action costs, so a reused wallet cannot answer it. Deliberately not " +
        "ADMIN_PRIVATE_KEY: that wallet is already provisioned.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "FEE_PROBE_ADMIN_KEY must be a 0x-prefixed 32-byte hex private key",
    );
  }
  if (key === process.env["ADMIN_PRIVATE_KEY"]?.trim()) {
    throw new Error(
      "FEE_PROBE_ADMIN_KEY is the same key as ADMIN_PRIVATE_KEY. That wallet " +
        "has already taken its first admin action, so the measurement would " +
        "be meaningless. Generate a fresh key and fund it.",
    );
  }
  return key as Hex;
}

/**
 * Submit one approval and return its gas.
 *
 * A missing receipt is fatal here, unlike in the revoke script: a probe
 * whose whole output is a gas number cannot report a result without one.
 */
async function timedApproval(
  ctx: Awaited<ReturnType<typeof buildAltanaClient>>,
  wallet: { address: Address },
  adminSigner: Parameters<typeof approveSignatureChecker>[1],
  session: Parameters<typeof approveSignatureChecker>[2]["session"],
  checker: Address,
  label: string,
): Promise<{ gasUsed: bigint; transactionHash: Hex }> {
  console.log(`Submitting ${label}: approveSignatureChecker(${checker}) ...`);
  const result: ExecuteResult = await approveSignatureChecker(
    wallet as never,
    adminSigner,
    { session, checker },
    { network: ctx.network },
  );
  const hash = result.transactionHash;
  if (hash === undefined) {
    throw new Error(
      `${label}: the relay returned status ${result.status} with no transaction ` +
        `hash, so gas cannot be measured. Re-run once the relay is healthy.`,
    );
  }
  const receipt = await waitForReceipt(ctx.publicClient as never, hash);
  if (receipt === null || receipt.gasUsed === undefined) {
    throw new Error(
      `${label}: no receipt for ${hash} before the timeout. The measurement is ` +
        `incomplete; check the hash on the explorer and re-run.`,
    );
  }
  if (receipt.status === "reverted") {
    throw new Error(`${label}: transaction ${hash} reverted.`);
  }
  console.log(`  ${label}: ${receipt.gasUsed.toString(10)} gas  (${hash})`);
  record({
    chainId: ctx.chain.chainId,
    action: "fee-probe",
    wallet: wallet.address,
    transactionHash: hash,
    status: result.status,
    gasUsed: receipt.gasUsed.toString(10),
    blockNumber: receipt.blockNumber?.toString(10) ?? null,
    note: `${label}: approveSignatureChecker(${checker})`,
  });
  return { gasUsed: receipt.gasUsed, transactionHash: hash };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadAppConfig();
  const adminPrivateKey = requireFreshAdminKey();
  const ctx = await buildAltanaClient(config.chain);
  const wallet = await provisionWallet(ctx.client, adminPrivateKey);

  console.log(`Probe wallet: ${wallet.walletAddress}`);

  if (argv.includes("--address")) {
    console.log(
      "Fund this address with testnet BNB for gas, then re-run with --yes.\n" +
        "Do not use it for anything else: the probe only measures a wallet " +
        "whose first admin action has not happened yet.",
    );
    return;
  }

  const balance = await ctx.publicClient.getBalance({
    address: wallet.walletAddress as Address,
  });
  console.log(`Balance:      ${balance.toString(10)} wei`);
  if (balance === 0n) {
    throw new Error(
      "the probe wallet has no gas. Run with --address, fund it from the " +
        "BNB testnet faucet, then re-run with --yes.",
    );
  }

  if (!argv.includes("--yes")) {
    throw new Error(
      "refusing to submit without --yes. This probe sends four real " +
        "transactions and spends testnet gas.",
    );
  }

  // --- The measurement: the same operation, first vs not-first. ---
  const store = new SessionStore();
  const allowlist = [
    {
      signature: "transferFrom(address,address,uint256,uint256)",
      to: PERMIT2_ADDRESS,
    },
  ];

  const grantOnce = async (
    label: string,
  ): Promise<{
    gasUsed: bigint;
    session: Awaited<ReturnType<typeof grantSession>>["session"];
  }> => {
    console.log(`Submitting ${label}: grantSession ...`);
    const granted = await grantSession(ctx.client, store, {
      wallet: { address: wallet.walletAddress } as never,
      adminSigner: wallet.adminSigner,
      config: config.session,
      token: config.chain.token,
      tokenDecimals: config.chain.tokenDecimals,
      calls: allowlist,
      // A distinct key each time. Re-granting the same key would touch
      // an already-written slot and undercount the second grant.
      sessionSigner: signerFromPrivateKey(generatePrivateKey()),
    });
    const hash = granted.persisted.grantTransactionHash;
    if (hash === null || hash === undefined) {
      throw new Error(
        `${label}: the relay surfaced no transaction hash, so gas cannot be ` +
          `measured. Re-run once the relay is healthy.`,
      );
    }
    const receipt = await waitForReceipt(ctx.publicClient as never, hash);
    if (receipt === null || receipt.gasUsed === undefined) {
      throw new Error(
        `${label}: no receipt for ${hash} before the timeout. Check the hash ` +
          `on the explorer and re-run.`,
      );
    }
    console.log(`  ${label}: ${receipt.gasUsed.toString(10)} gas  (${hash})`);
    record({
      chainId: config.chain.chainId,
      action: "fee-probe",
      wallet: wallet.walletAddress,
      transactionHash: hash,
      status: receipt.status ?? "unknown",
      gasUsed: receipt.gasUsed.toString(10),
      blockNumber: receipt.blockNumber?.toString(10) ?? null,
      note: `${label}: grantSession`,
    });
    return { gasUsed: receipt.gasUsed, session: granted.session };
  };

  const firstGrant = await grantOnce("grant #1 (wallet's first admin action)");
  const secondGrant = await grantOnce("grant #2 (same wallet, not first)");

  // --- The control: does the surcharge recur per action type? ---
  const first = await timedApproval(
    ctx,
    { address: wallet.walletAddress as Address },
    wallet.adminSigner,
    firstGrant.session,
    PERMIT2_ADDRESS as Address,
    "approval #1",
  );
  const second = await timedApproval(
    ctx,
    { address: wallet.walletAddress as Address },
    wallet.adminSigner,
    firstGrant.session,
    SECOND_CHECKER,
    "approval #2",
  );

  const grantDelta = firstGrant.gasUsed - secondGrant.gasUsed;
  const grantRatio = Number(firstGrant.gasUsed) / Number(secondGrant.gasUsed);

  console.log("");
  console.log("=== Result: is the first admin action doubled? ===");
  console.log(
    `Grant #1 (first admin action): ${firstGrant.gasUsed.toString(10)} gas`,
  );
  console.log(
    `Grant #2 (same wallet):        ${secondGrant.gasUsed.toString(10)} gas`,
  );
  console.log(`Delta:                         ${grantDelta.toString(10)} gas`);
  console.log(`Ratio:                         ${grantRatio.toFixed(3)}x`);
  console.log("");
  if (grantRatio >= 1.8) {
    console.log(
      `VERIFIED: the first grant costs ${grantRatio.toFixed(2)}x the second — a ` +
        `one-time registration rides along with a fresh wallet's first admin ` +
        `action, as documented.`,
    );
  } else if (grantDelta > 0n) {
    console.log(
      `NOT DOUBLED: the first grant costs ${grantDelta.toString(10)} gas more ` +
        `than the second, but at ${grantRatio.toFixed(2)}x that is a surcharge, ` +
        `not a doubling. Replace the documented "doubled" claim with this figure.`,
    );
  } else {
    console.log(
      `REFUTED: the first grant costs no more than the second ` +
        `(${grantRatio.toFixed(2)}x). There is no first-action surcharge on ` +
        `this wallet. Remove the documented claim.`,
    );
  }

  console.log("");
  console.log("=== Control: does the surcharge recur per action type? ===");
  console.log(
    `Approval #1:                   ${first.gasUsed.toString(10)} gas`,
  );
  console.log(
    `Approval #2:                   ${second.gasUsed.toString(10)} gas`,
  );
  console.log(
    `Ratio:                         ${(Number(first.gasUsed) / Number(second.gasUsed)).toFixed(3)}x`,
  );
  console.log(
    "A ratio near 1.0 here means the one-time cost is charged once per wallet, " +
      "not once per kind of action.",
  );
  console.log("");
  console.log("Recorded to the runbook. Paste the figures into TODO.md.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`fee probe failed: ${message}`);
  if (err instanceof Error && err.stack && process.env["DEBUG"] !== undefined) {
    console.error(err.stack);
  }
  process.exit(1);
});
