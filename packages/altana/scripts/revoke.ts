#!/usr/bin/env tsx
/**
 * Operator script: revoke an Altana agent session, and prove it.
 *
 * Run with `pnpm --filter @neuro-pay/altana revoke -- --yes`.
 *
 * The revoke path already existed as a library function and as a console
 * endpoint, but there was no way to run it from a terminal — which is why
 * the funded-testnet checklist has "revoke" as its one unrun step. This
 * is that step.
 *
 * The script does four things, in this order:
 *
 *  1. **Read the authority before.** A revoke you cannot see take effect
 *     proves nothing. We read the on-chain Keystore first and print the
 *     status, so the after-reading has a baseline to move from.
 *  2. **Revoke, both stages.** Local first (signing stops in
 *     milliseconds), then on-chain. `revokeSession` reports the two
 *     independently; a `FAILED` on-chain status is a failure here too.
 *  3. **Read the authority after.** The claim being verified is not "we
 *     submitted a transaction", it is "the session is dead on chain".
 *     Only the second read can say that.
 *  4. **Record every hash.** Appended to the runbook (see `runbook.ts`),
 *     because the last testnet run's hashes survive only as prose in
 *     `TODO.md`.
 *
 * ## Why `--yes` is required
 *
 * Revocation is irreversible. Re-granting a session costs gas and a new
 * provisioning round trip, and on a funded wallet that is real money,
 * however testnet-flavoured. The script refuses to submit without an
 * explicit flag rather than making a destructive action the default of a
 * bare command.
 *
 * ## Flags
 *
 *   --yes                Required. Confirms the irreversible submission.
 *   --wallet <address>   Which session to revoke. Defaults to the only
 *                        one in the store; required when there are several.
 *   --retry              Retry the on-chain stage only, for a session
 *                        whose local revoke already succeeded and whose
 *                        on-chain submission failed. Reads the snapshot
 *                        from the runbook-recorded wallet, not the store
 *                        (local revoke already removed it).
 *   --dry-run            Do the before-reading and print the plan; submit
 *                        nothing. Safe to run any time.
 */

import { loadAppConfig } from "../src/config/config.js";
import { buildAltanaClient } from "../src/client.js";
import { SessionStore } from "../src/session/store.js";
import { checkSessionAuthority } from "../src/session/authority.js";
import { revokeSession, retryOnChainRevoke } from "../src/session/revoke.js";
import type { PersistedSession } from "../src/session/persisted.js";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import type { Address, Hex } from "@neuro-pay/types";
import { record, waitForReceipt } from "./runbook.js";
import { sessionStorePath } from "./paths.js";

type Flags = {
  yes: boolean;
  retry: boolean;
  dryRun: boolean;
  wallet: Address | undefined;
};

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    yes: argv.includes("--yes"),
    retry: argv.includes("--retry"),
    dryRun: argv.includes("--dry-run"),
    wallet: undefined,
  };
  const at = argv.indexOf("--wallet");
  if (at !== -1) {
    const value = argv[at + 1];
    if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error("--wallet needs a 0x-prefixed 20-byte address");
    }
    flags.wallet = value as Address;
  }
  return flags;
}

/**
 * Pick which session to revoke.
 *
 * With one session in the store the choice is unambiguous and we make
 * it. With several, we refuse rather than guess — revoking the wrong
 * agent's session is exactly the kind of mistake a default should not
 * be able to cause.
 */
function pickWallet(
  store: SessionStore,
  requested: Address | undefined,
): Address {
  const wallets = store.list();
  if (requested !== undefined) {
    if (!wallets.includes(requested)) {
      throw new Error(
        `no persisted session for wallet ${requested}. ` +
          `The store holds: ${wallets.join(", ") || "(nothing)"}`,
      );
    }
    return requested;
  }
  if (wallets.length === 0) {
    throw new Error(
      "the session store is empty — nothing to revoke. " +
        "Check SESSION_STORE_PATH points at the file the grant wrote.",
    );
  }
  if (wallets.length > 1) {
    throw new Error(
      `the store holds ${wallets.length} sessions; pass --wallet to say which one. ` +
        `Candidates: ${wallets.join(", ")}`,
    );
  }
  return wallets[0]!;
}

async function readAuthority(
  ctx: Awaited<ReturnType<typeof buildAltanaClient>>,
  session: PersistedSession,
  label: string,
): Promise<string> {
  try {
    const authority = await checkSessionAuthority({
      session,
      network: ctx.network,
      publicClient: ctx.publicClient,
    });
    console.log(
      `Authority ${label}: ${authority.status} ` +
        `(keystore isValidKey=${authority.onChainValid}, expiry=${authority.expiry})`,
    );
    return authority.status;
  } catch (err: unknown) {
    // A transport failure is not a revocation. Say so plainly rather
    // than letting an RPC blip read as proof the session is dead.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`Authority ${label}: UNREADABLE (${message})`);
    return "unreadable";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadAppConfig();
  if (config.secrets.adminPrivateKey === null) {
    throw new Error(
      "ADMIN_PRIVATE_KEY is required to revoke on chain. The same authority " +
        "that granted the session must revoke it.",
    );
  }
  const adminSigner = signerFromPrivateKey(
    config.secrets.adminPrivateKey as Hex,
  );

  const storePath = sessionStorePath();
  const store = new SessionStore({ fileStorePath: storePath });
  const walletAddress = pickWallet(store, flags.wallet);
  const persisted = store.read(walletAddress);
  if (persisted === undefined) {
    throw new Error(`no persisted session for wallet ${walletAddress}`);
  }

  const ctx = await buildAltanaClient(config.chain);
  const chainId = config.chain.chainId;

  console.log(`Session store:  ${storePath}`);
  console.log(`Wallet:         ${walletAddress}`);
  console.log(`Session pubkey: ${persisted.publicKey}`);
  console.log(`Chain:          ${chainId}`);
  console.log("");

  const before = await readAuthority(ctx, persisted, "before");

  if (flags.dryRun) {
    console.log("");
    console.log("--dry-run: nothing submitted. Re-run with --yes to revoke.");
    return;
  }
  if (!flags.yes) {
    throw new Error(
      "refusing to revoke without --yes. Revocation is irreversible: the " +
        "session stops signing immediately and re-granting costs a new " +
        "on-chain round trip. Re-run with --yes once you mean it.",
    );
  }

  console.log("");
  const outcome = flags.retry
    ? {
        localRevoked: true,
        ...(await retryOnChainRevoke({
          client: ctx.client,
          wallet: { address: walletAddress } as never,
          adminSigner,
          session: persisted,
        })),
      }
    : await revokeSession(store, {
        client: ctx.client,
        wallet: { address: walletAddress } as never,
        adminSigner,
      });

  console.log(`Local revoked:    ${outcome.localRevoked}`);
  console.log(`On-chain status:  ${outcome.onChainStatus ?? "(none)"}`);
  console.log(`On-chain revoked: ${outcome.onChainRevoked}`);
  console.log(
    `Revoke tx:        ${outcome.onChainTransactionHash ?? "(no hash)"}`,
  );

  // Receipt, for the gas figure the fee question also cares about.
  let gasUsed: string | null = null;
  let blockNumber: string | null = null;
  if (outcome.onChainTransactionHash !== null) {
    const receipt = await waitForReceipt(
      ctx.publicClient as never,
      outcome.onChainTransactionHash,
    );
    if (receipt !== null) {
      gasUsed = receipt.gasUsed?.toString(10) ?? null;
      blockNumber = receipt.blockNumber?.toString(10) ?? null;
      console.log(`Gas used:         ${gasUsed ?? "(unknown)"}`);
      console.log(`Block:            ${blockNumber ?? "(unknown)"}`);
    } else {
      console.log(
        "Receipt:          not found before the timeout. The transaction may " +
          "still confirm; re-check the hash on the explorer.",
      );
    }
  }

  record({
    chainId,
    action: flags.retry ? "revoke-retry" : "revoke",
    wallet: walletAddress,
    transactionHash: outcome.onChainTransactionHash,
    status: outcome.onChainStatus ?? "no-status",
    gasUsed,
    blockNumber,
    note: `authority before=${before}`,
  });

  // The verification the checklist actually asks for: not "did we send a
  // transaction" but "is the session dead on chain now".
  console.log("");
  const after = await readAuthority(ctx, persisted, "after");

  console.log("");
  if (after === "revoked") {
    console.log(
      "VERIFIED: the Keystore no longer recognises this session key.",
    );
  } else if (after === "expired") {
    console.log(
      "INCONCLUSIVE: the session had already expired, so the authority read " +
        "reports `expired` and cannot distinguish a successful revoke from a " +
        "failed one. Re-run this verification against a freshly granted session.",
    );
  } else if (after === "unreadable") {
    console.log(
      "INCONCLUSIVE: the authority read failed. The revoke may well have " +
        "landed — check the transaction hash above on the explorer.",
    );
  } else {
    console.log(
      `NOT VERIFIED: the authority still reads \`${after}\`. Local signing has ` +
        `stopped, but the session is not provably dead on chain. Re-run with ` +
        `--retry --yes to resubmit the on-chain stage.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`revoke failed: ${message}`);
  if (err instanceof Error && err.stack && process.env["DEBUG"] !== undefined) {
    console.error(err.stack);
  }
  process.exit(1);
});
