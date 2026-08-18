#!/usr/bin/env tsx
/**
 * Dev-only: write a fake session record so the console has something to
 * render without a chain, an admin key, or a grant fee.
 *
 * Run with: `pnpm --filter @neuro-pay/api seed:session`
 *
 * ## Why this exists
 *
 * `/v1/session`, `/v1/budget`, and `POST /v1/session/revoke` all read the
 * first record in the `SessionStore`. With an empty store the first two
 * answer 404 (the console renders empty panels) and revoke answers 404,
 * which surfaces in the UI as `revoke failed with 404`. The only writer
 * of that store is the provisioning script, which needs an admin key, a
 * funded wallet, and real on-chain fees.
 *
 * This script writes the same `PersistedSession` shape through the same
 * byte-exact codec, so the console's session card, budget meter, and the
 * local half of the kill switch all work offline.
 *
 * ## What it is NOT
 *
 * The record describes a session that does not exist on chain. There is
 * no key material behind it — `SessionStore` never persists a signer, and
 * this script has none to persist. Nothing can sign a payment with it and
 * no on-chain read will confirm it. Use it for console and UI work; run
 * `pnpm --filter @neuro-pay/altana provision` for a session that is real.
 *
 * The seeded record is deliberately marked `railProvisioned: true` and
 * carries a `grantTransactionHash` of `null` — the shape an operator sees
 * between a grant whose hash the relay never surfaced and a completed
 * rail provisioning.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SessionStore,
  loadAppConfig,
  type PersistedSession,
} from "@neuro-pay/altana";
import type { Address, Hex } from "@neuro-pay/types";

/** Canonical Permit2 — the same `to` the real allowlist grants. */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/** The call every b402 payment envelopes. */
const PERMIT2_TRANSFER_FROM = "transferFrom(address,address,uint256,uint256)";

/**
 * Placeholder wallet. Obviously not a real smart account — the leading
 * `0xdead` reads as fake in the console so nobody mistakes a seeded
 * session for a granted one.
 */
const DEFAULT_WALLET = "0xdead0000000000000000000000000000000Seed" as Address;

/** SEC1-uncompressed public key: `0x04` + 64 bytes. No private half exists. */
const PLACEHOLDER_PUBLIC_KEY = `0x04${"11".repeat(64)}` as Hex;

function parseArgs(argv: string[]): { wallet: Address; force: boolean } {
  let wallet = DEFAULT_WALLET;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--wallet") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--wallet needs an address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(
          `--wallet must be a 20-byte hex address (got ${value})`,
        );
      }
      wallet = value as Address;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { wallet, force };
}

function main(): void {
  const { wallet, force } = parseArgs(process.argv.slice(2));

  // Read the same configuration the API reads, so the seeded spend cap,
  // token, and lifetime match what the console will compare against.
  const config = loadAppConfig();

  const storePath = process.env["SESSION_STORE_PATH"] ?? ".data/session.json";
  mkdirSync(dirname(storePath), { recursive: true });
  const store = new SessionStore({ fileStorePath: storePath });

  const existing = store.list();
  if (existing.length > 0 && !force) {
    throw new Error(
      `${storePath} already holds a session for ${existing[0]!}. ` +
        "Pass --force to overwrite it — if it is a real granted session, " +
        "revoke it on chain first rather than dropping the record.",
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const persisted: PersistedSession = {
    walletAddress: wallet,
    publicKey: PLACEHOLDER_PUBLIC_KEY,
    permissions: {
      calls: [{ signature: PERMIT2_TRANSFER_FROM, to: PERMIT2_ADDRESS }],
      spend: [
        {
          limit: config.session.spendCap,
          period: "day",
          token: config.chain.token,
        },
      ],
    },
    expiry: nowSeconds + config.session.lifetimeSeconds,
    grantTransactionHash: null,
    railProvisioned: true,
    createdAt: nowSeconds,
  };

  store.save(persisted);

  console.log(`seeded a fake session in ${storePath}`);
  console.log(`  wallet     ${persisted.walletAddress}`);
  console.log(
    `  spend cap  ${config.session.spendCap.toString(10)} (smallest units of ${config.chain.token})`,
  );
  console.log(
    `  expires    ${new Date(persisted.expiry * 1000).toISOString()}`,
  );
  console.log("");
  console.log(
    "Not a real session: nothing on chain matches it and no signer exists.",
  );
  console.log("Restart the API to pick it up, then open /console.");
}

try {
  main();
  process.exit(0);
} catch (err: unknown) {
  console.error(`seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
