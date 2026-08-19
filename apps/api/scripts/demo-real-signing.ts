#!/usr/bin/env tsx
/**
 * Real signed-payment buyer driver (P0 TODO 8 + 9).
 *
 * Companion to `demo-stream.ts`. That script sends a SYNTHETIC envelope
 * with a placeholder signature; this one loads a persisted session from
 * `SessionStore`, registers a `signerSource` from `SESSION_PRIVATE_KEY`,
 * hydrates a live SDK `Session`, and answers 402s with `fetchWithX402`.
 *
 * Run with: `pnpm --filter @neuro-pay/api demo:real`
 * (API must already be running — `pnpm dev`.)
 *
 * ## Required env
 *
 * - `SESSION_PRIVATE_KEY` — the session key that was granted on chain
 *   (pass the same value to `pnpm --filter @neuro-pay/altana provision`).
 * - `SESSION_WALLET` — optional; defaults to the first persisted session.
 * - `SESSION_STORE_PATH` — optional; default `.data/session.json`.
 *
 * A seeded fake session (`pnpm seed:session`) has no matching private
 * key. Against the stub verifier the signed retry still delivers (the
 * seller does not check the key on chain). Against the production
 * ERC-1271 verifier it is rejected, which is correct.
 */

import {
  SessionStore,
  createBuyerPaymentContext,
  fetchWithX402,
  PaymentFailureError,
  signerFromPrivateKey,
  type Signer,
} from "@neuro-pay/altana";
import { recordPayment } from "@neuro-pay/metering";
import type { Address, Hex } from "@neuro-pay/types";

const API_BASE = (process.env.API_BASE ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);
const SESSION_PATH = process.env.SESSION_STORE_PATH ?? ".data/session.json";
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type Options = {
  segments: number;
  delayMs: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { segments: 5, delayMs: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--segments":
        if (value === undefined) throw new Error("--segments needs a count");
        options.segments = Number.parseInt(value, 10);
        i += 1;
        break;
      case "--delay":
        if (value === undefined) throw new Error("--delay needs milliseconds");
        options.delayMs = Number.parseInt(value, 10);
        i += 1;
        break;
      default:
        break;
    }
  }
  return options;
}

function readSessionPrivateKey(): Hex {
  const raw = process.env.SESSION_PRIVATE_KEY?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(
      "SESSION_PRIVATE_KEY is required. Generate a key, grant the session with " +
        "the same value set (`pnpm --filter @neuro-pay/altana provision`), then " +
        "run this script. The store never persists the private half.",
    );
  }
  if (!PRIVATE_KEY_PATTERN.test(raw)) {
    throw new Error(
      "SESSION_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key",
    );
  }
  return raw as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sessionPrivateKey = readSessionPrivateKey();
  const signer = signerFromPrivateKey(sessionPrivateKey);

  const requestedWallet = process.env.SESSION_WALLET as Address | undefined;
  const store = new SessionStore({
    fileStorePath: SESSION_PATH,
    signerSource: (wallet) =>
      requestedWallet === undefined ||
      wallet.toLowerCase() === requestedWallet.toLowerCase()
        ? signer
        : undefined,
  });

  const wallet = requestedWallet ?? (store.list()[0] as Address | undefined);
  if (wallet === undefined) {
    throw new Error(
      `[demo:real] no persisted session in ${SESSION_PATH}. ` +
        "Run provision (with SESSION_PRIVATE_KEY) or seed:session first.",
    );
  }

  const resolved = store.resolve(wallet);
  if (resolved.signer === undefined || resolved.signer === null) {
    throw new Error(
      `[demo:real] signerSource did not yield a signer for ${wallet}`,
    );
  }

  console.log(`[demo:real] loading session from ${SESSION_PATH}`);
  console.log(
    `[demo:real] session loaded: wallet=${resolved.persisted.walletAddress} expiry=${resolved.persisted.expiry} railProvisioned=${resolved.persisted.railProvisioned}`,
  );

  console.log(`[demo:real] POST ${API_BASE}/v1/streams`);
  const open = await fetch(`${API_BASE}/v1/streams`, { method: "POST" });
  if (!open.ok) {
    throw new Error(`open stream failed: ${open.status} ${await open.text()}`);
  }
  const opened = (await open.json()) as {
    streamId: string;
    chainId: number;
    tokenDecimals: number;
  };
  console.log(`[demo:real] opened stream ${opened.streamId}`);

  const budgetMargin = Number.parseFloat(process.env.BUDGET_MARGIN ?? "0.2");
  let payment = createBuyerPaymentContext({
    persisted: resolved.persisted,
    signer: resolved.signer as Signer,
    chainId: opened.chainId,
    tokenDecimals: opened.tokenDecimals,
    budgetMargin: Number.isFinite(budgetMargin) ? budgetMargin : 0.2,
  });

  const url = `${API_BASE}/v1/streams/${opened.streamId}/next`;
  for (let i = 0; i < options.segments; i += 1) {
    const result = await fetchWithX402(url, { payment });
    const bodyText = await result.response.text();
    if (result.payment !== undefined) {
      payment = {
        ...payment,
        budget: recordPayment(
          payment.budget,
          result.payment.requirement.maxAmountRequired,
        ),
      };
      console.log(
        `[demo:real] segment ${i + 1}: paid ${result.payment.requirement.maxAmountRequired.toString()} status=${result.response.status}`,
      );
    } else {
      console.log(
        `[demo:real] segment ${i + 1}: no payment status=${result.response.status}`,
      );
    }
    if (result.response.status !== 200) {
      console.log(`[demo:real] body: ${bodyText}`);
      if (result.response.status === 404) break;
      throw new Error(`unexpected status ${result.response.status}`);
    }
    if (i + 1 < options.segments && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof PaymentFailureError) {
    console.error(
      `[demo:real] payment refused (${err.classification}): ${err.message}`,
    );
  } else {
    console.error(
      `[demo:real] ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(1);
});
