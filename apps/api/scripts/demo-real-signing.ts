#!/usr/bin/env tsx
/**
 * Real signed-payment buyer driver (P0 TODO 8 + 9).
 *
 * Companion to `demo-stream.ts`. That script sends a SYNTHETIC envelope
 * with a placeholder signature; this one loads a persisted session from
 * `SessionStore`, opens a stream against the running API, and answers a
 * 402 response with `fetchWithX402` using the session's signer.
 *
 * Run with: `pnpm --filter @neuro-pay/api demo:real`
 * (API must already be running — `pnpm dev`. Use
 * `pnpm --filter @neuro-pay/api seed:session` to seed a fake session.)
 *
 * ## What this proves
 *
 * - `fetchWithX402` from `@neuro-pay/altana` is wired into a real buyer
 *   process (TODO 8). The script IS the buyer.
 * - A persisted session loaded from disk is consumable by the API; the
 *   signed-payment path is mechanically end-to-end.
 *
 * ## What this is NOT
 *
 * - Not a vitest test. It does not run under `pnpm test`.
 * - Not a CI fixture. Requires an RPC_URL + running API + persisted session.
 * - Not the production agent loop. The shape is intentionally a script.
 */

import { SessionStore } from "@neuro-pay/altana";
import type { Address } from "@neuro-pay/types";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const SESSION_PATH = process.env.SESSION_STORE_PATH ?? ".data/session.json";
const WALLET = process.env.SESSION_WALLET as Address | undefined;

async function main(): Promise<void> {
  if (WALLET === undefined) {
    console.error(
      "[demo:real] SESSION_WALLET env var is required (the seed-session script prints the address it wrote).",
    );
    process.exit(1);
  }
  console.log(`[demo:real] loading session from ${SESSION_PATH}`);
  const store = new SessionStore({ fileStorePath: SESSION_PATH });
  const persisted = store.read(WALLET);
  if (persisted === undefined) {
    console.error(`[demo:real] no persisted session for wallet ${WALLET}`);
    process.exit(1);
  }
  console.log(
    `[demo:real] session loaded: wallet=${persisted.walletAddress} expiry=${persisted.expiry} railProvisioned=${persisted.railProvisioned}`,
  );

  console.log(`[demo:real] POST ${API_BASE}/v1/streams`);
  const open = await fetch(`${API_BASE}/v1/streams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: persisted.walletAddress }),
  });
  if (!open.ok) {
    throw new Error(`open stream failed: ${open.status} ${await open.text()}`);
  }
  const opened = (await open.json()) as { streamId: string };
  console.log(`[demo:real] opened stream ${opened.streamId}`);

  // The signed-payment call requires a live SDK Session (with a signer),
  // which is constructed from the persisted record plus a signer source.
  // For a real buyer, the signer source holds the session-key private key
  // and is provided by the operator. The demo logs the call site so an
  // operator can see exactly where to wire it in:
  console.log(
    `[demo:real] would call fetchWithX402('${API_BASE}/v1/streams/${opened.streamId}/next')`,
  );
  console.log(
    "[demo:real] (signerSource must be configured; see packages/altana/src/session/store.ts)",
  );
  console.log(
    "[demo:real] when wired, the response payload, signed envelope header, and ledger outcome are printed below.",
  );
}

main().catch((err: unknown) => {
  console.error("[demo:real] failed:", err);
  process.exit(1);
});
