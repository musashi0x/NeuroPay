#!/usr/bin/env tsx
/**
 * Operator script: end-to-end provisioning of an Altana agent session.
 *
 * Run with: `pnpm --filter @neuro-pay/altana provision` (or
 * `tsx packages/altana/scripts/provision.ts`). Drives the full one-time
 * setup the change requires:
 *
 *  1. Build the Altana client from configuration. Token decimals are
 *     asserted against the token contract; a mismatch is a fatal
 *     startup error.
 *  2. Provision the smart-account wallet from the admin signer. The
 *     wallet address is printed for the operator to fund from the
 *     BNB testnet faucet.
 *  3. Grant a session key with the configured lifetime, spend cap, and
 *     explicit calls allowlist. The grant transaction hash is printed.
 *  4. Provision the permit2 rail (token approval + signature checker
 *     approval). Both transaction hashes are printed.
 *
 * The script is intentionally non-interactive: configuration is read
 * from the environment, every transaction is awaited, and the exit code
 * is 0 on success / 1 on any failure. Operators pipe the output into
 * a runbook or a status file.
 *
 * What it deliberately does NOT do:
 *
 *  - Touch the admin signer after the grant. The admin key is held in
 *    process memory only and is used for grant + rail provisioning,
 *    then dropped.
 *  - Poll the relay for confirmation. The SDK returns the transaction
 *    hash when the relay surfaces a receipt; we print it. The operator
 *    can verify on the explorer.
 *  - Run forever. This is a one-shot. Operators who want a daemon run
 *    `apps/api` instead.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadAppConfig } from "../src/config/config.js";
import { buildAltanaClient } from "../src/client.js";
import { provisionWallet } from "../src/wallet.js";
import { SessionStore } from "../src/session/store.js";
import { grantSession } from "../src/session/grant.js";
import { provisionRail } from "../src/rail.js";
import { PERMIT2_ADDRESS, type CallPermission } from "@altananetwork/sdk";
import type { Address, Hex } from "@neuro-pay/types";

/**
 * The hardcoded calls allowlist for an agent session.
 *
 * Operators who need a different allowlist should edit this constant
 * or pass a JSON array via `ALLOWLIST` in the environment. The spec
 * requires the allowlist to be explicit and non-empty — an omitted
 * allowlist is a policy hole that reads like a default.
 */
const DEFAULT_ALLOWLIST: CallPermission[] = [
  // Permit2's canonical transferFrom — what every b402 payment
  // envelopes. Pre-approving this signature is what makes the
  // signer usable for settlement.
  {
    signature: "transferFrom(address,address,uint256,uint256)",
    to: PERMIT2_ADDRESS,
  },
];

function parseAllowlist(envValue: string | undefined): CallPermission[] {
  if (envValue === undefined || envValue.trim() === "") {
    return DEFAULT_ALLOWLIST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch (err) {
    throw new Error(`ALLOWLIST is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "ALLOWLIST must be a non-empty JSON array of CallPermission objects",
    );
  }
  return parsed as CallPermission[];
}

function asCallPermission(p: CallPermission): {
  signature: string;
  to?: Address;
} {
  // The SDK's CallPermission is a union of three shapes: signature+to,
  // signature alone, and to alone. The persisted session requires a
  // signature, and a target-only entry means "every call to this address"
  // — the implicit policy hole the allowlist exists to close. Refuse it
  // rather than widening the persisted shape to express it.
  if (!("signature" in p)) {
    throw new Error(
      `ALLOWLIST entry ${JSON.stringify(p)} has no \`signature\`: a ` +
        "target-only permission allows every call to that address. List " +
        "the call signatures the session actually needs.",
    );
  }
  if ("to" in p && p.to !== undefined) {
    return { signature: p.signature, to: p.to };
  }
  return { signature: p.signature };
}

async function main(): Promise<void> {
  // 1. Read configuration. Failures bubble up as named ConfigError
  // subclasses — the operator reads the variable name from the first
  // line of the crash.
  const config = loadAppConfig();
  if (config.secrets.adminPrivateKey === null) {
    throw new Error(
      "ADMIN_PRIVATE_KEY is required for the provisioning script. " +
        "A running agent process has no admin key by design; the " +
        "provisioner is the one place that does.",
    );
  }
  const adminPrivateKey: Hex = config.secrets.adminPrivateKey;
  const allowlist = parseAllowlist(process.env["ALLOWLIST"]).map(
    asCallPermission,
  );

  // 2. Build the Altana client. Token decimals are asserted against
  // the contract; a mismatch is a fatal startup error.
  const ctx = await buildAltanaClient(config.chain);

  // 3. Provision the wallet. The address is printed so the operator
  // can fund it from the BNB testnet faucet.
  const wallet = await provisionWallet(ctx.client, adminPrivateKey);
  console.log(`Wallet address: ${wallet.walletAddress}`);
  console.log(
    "  -> Fund this wallet with testnet BNB (for gas) and the payment token (for the spend cap).",
  );

  // 4. Grant the session. The record is written to the same file the API
  // reads at startup (`SESSION_STORE_PATH`), or the store is left in
  // memory when the operator points it at nothing. An in-memory grant
  // dies with this process, and the API then boots against an empty
  // store: `/v1/session`, `/v1/budget`, and the revoke kill switch all
  // answer 404 with a session that exists on chain. Key material is still
  // never written — `SessionStore` persists the public half only.
  const sessionStorePath =
    process.env["SESSION_STORE_PATH"] ?? ".data/session.json";
  mkdirSync(dirname(sessionStorePath), { recursive: true });
  const store = new SessionStore({ fileStorePath: sessionStorePath });
  const result = await grantSession(ctx.client, store, {
    wallet: { address: wallet.walletAddress } as never,
    adminSigner: wallet.adminSigner,
    config: config.session,
    token: config.chain.token,
    tokenDecimals: config.chain.tokenDecimals,
    calls: allowlist,
  });
  const grantTx = result.persisted.grantTransactionHash;
  console.log(
    `Grant transaction: ${grantTx ?? "(pending — relay did not surface a hash)"}`,
  );
  console.log(`Session expiry: ${result.persisted.expiry}`);
  console.log(`Session public key: ${result.persisted.publicKey}`);
  console.log(`Session persisted to: ${sessionStorePath}`);

  // 5. Provision the permit2 rail. The rail is the local gate the
  // payment client asserts against before signing.
  const rail = await provisionRail(ctx.client, ctx.publicClient, store, {
    wallet: { address: wallet.walletAddress } as never,
    adminSigner: wallet.adminSigner,
    session: result.session,
    token: config.chain.token,
  });
  console.log(`Permit2 address: ${rail.permit2Address}`);
  console.log(
    `Approve token tx: ${rail.approveTokenTransactionHash ?? "(pending)"}`,
  );
  console.log(
    `Approve checker tx: ${rail.approveCheckerTransactionHash ?? "(pending)"}`,
  );

  console.log("");
  console.log("Provisioning complete. The session is now ready for payments.");
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : undefined;
    console.error(`provisioning failed: ${message}`);
    if (stack !== undefined && process.env["DEBUG"] !== undefined) {
      console.error(stack);
    }
    process.exit(1);
  },
);
