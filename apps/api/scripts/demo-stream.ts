#!/usr/bin/env tsx
/**
 * Demo driver: opens a metered stream against a running API and pays the
 * 402s it gets back, so the console at http://localhost:3000/console
 * fills with live streams, payments, and budget movement.
 *
 * Run with: `pnpm --filter @neuro-pay/api demo` (the API must already be
 * running — `pnpm dev`).
 *
 * ## Why this script exists
 *
 * The seller half of the payment loop is mounted by the API; the buyer
 * half (`fetchWithX402` in `@neuro-pay/altana`) is wired into no running
 * process. Without a buyer, `GET /v1/streams/:id/next` returns a 402 that
 * nobody answers, so the console reads a ledger that never gets written
 * and every panel is empty. This script is the missing buyer for a
 * demo — enough of one to exercise open → 402 → pay → deliver → settle
 * end to end.
 *
 * ## What it is NOT
 *
 * It does not sign. A real buyer signs the Permit2 witness with its
 * session key and the seller verifies the 98-byte ERC-1271 envelope by
 * calling `isValidSignature` on the buyer's smart account. This script
 * sends a **synthetic envelope with a placeholder signature**, which
 * works only because the API's composition root currently injects a stub
 * verifier that accepts everything:
 *
 *     verifier: async () => IS_VALID_SIGNATURE_MAGIC   // runtime.ts
 *     settler: createInMemorySettler(...)              // runtime.ts
 *
 * Point this at an API wired to a real ERC-1271 verifier and every
 * payment is rejected as `verification-failed`, which is the correct
 * outcome — the envelope carries no real signature. Use it for UI, ledger,
 * and console work, never as evidence that signing or settlement works.
 *
 * The witness fields (payTo, token, chainId, amount, deadline) ARE filled
 * honestly, because the seller checks each one before it ever reaches the
 * verifier: a mismatch there is a real rejection, not a stubbed one.
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

/** Placeholder for the 98-byte ERC-1271 envelope a real session key produces. */
const PLACEHOLDER_SIGNATURE = `0x${"11".repeat(98)}`;

/** Default payer. Never signs anything, so any well-formed address works. */
const DEFAULT_PAYER = "0x000000000000000000000000000000000000dEaD";

/** How far ahead of now the synthetic witness deadline sits, in seconds. */
const WITNESS_TTL_SECONDS = 300;

/** The wire form of `StreamOpenResponse` — bigints arrive as strings. */
type WireStreamOpen = {
  streamId: string;
  chainId: number;
  token: string;
  tokenDecimals: number;
  payTo: string;
};

/** The wire form of one `accepts[]` entry. `maxAmountRequired` is a string. */
type WireRequirement = {
  scheme: string;
  network: string;
  chainId: number;
  rail: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
};

type WirePaymentRequired = {
  x402Version: number;
  error: string | null;
  accepts: WireRequirement[];
};

/** The wire form of a delivered segment. */
type WireSegment = {
  sequence: number;
  secondsDelivered: number;
  unitsDelivered: number;
  accruedUnpaid: string;
  totalAccrued: string;
  streamEnded: boolean;
  endReason: string | null;
};

type Options = {
  apiUrl: string;
  segments: number;
  delayMs: number;
  payer: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apiUrl: process.env["DEMO_API_URL"] ?? "http://localhost:4000",
    segments: 20,
    delayMs: 500,
    payer: process.env["DEMO_PAYER"] ?? DEFAULT_PAYER,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--api":
        if (value === undefined) throw new Error("--api needs a URL");
        options.apiUrl = value.replace(/\/$/, "");
        i += 1;
        break;
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
      case "--payer":
        if (value === undefined) throw new Error("--payer needs an address");
        options.payer = value;
        i += 1;
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.segments) || options.segments < 1) {
    throw new Error("--segments must be a positive integer");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay must be a non-negative integer");
  }
  return options;
}

function printUsage(): void {
  console.log(
    [
      "Usage: pnpm --filter @neuro-pay/api demo [options]",
      "",
      "  --api <url>        API base URL (default http://localhost:4000)",
      "  --segments <n>     Segments to pull before stopping (default 20)",
      "  --delay <ms>       Pause between segments (default 500)",
      "  --payer <address>  Address to put in the envelope's `from` (default 0x…dEaD)",
      "",
      "The API must be running and its payment runtime mounted. Payments are",
      "synthetic: the envelope carries a placeholder signature and is accepted",
      "only by the stub verifier the API currently injects.",
    ].join("\n"),
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the b402 envelope the seller's parser accepts.
 *
 * The shape mirrors `encodeB402Envelope` in `@neuro-pay/altana`: both the
 * legacy `permit` + `from` fields and the canonical `permit2Authorization`
 * sibling carry the same authorization, so either dialect reader finds it.
 * The witness is what the seller actually checks against its own config.
 */
function buildSyntheticEnvelope(input: {
  payer: string;
  requirement: WireRequirement;
  nonce: string;
  deadline: number;
}): string {
  const authorization = {
    hash: "0x",
    nonce: input.nonce,
    signature: PLACEHOLDER_SIGNATURE,
    witness: {
      payTo: input.requirement.payTo,
      amount: input.requirement.maxAmountRequired,
      token: input.requirement.asset,
      chainId: input.requirement.chainId,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
  const envelope = {
    x402Version: 1,
    scheme: input.requirement.scheme,
    network: input.requirement.network,
    from: input.payer,
    nonce: input.nonce,
    permit: authorization,
    permit2Authorization: { from: input.payer, permit: authorization },
    resource: { url: input.requirement.resource },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

async function openStream(apiUrl: string): Promise<WireStreamOpen> {
  const response = await fetch(`${apiUrl}/v1/streams`, { method: "POST" });
  if (response.status === 404) {
    throw new Error(
      "POST /v1/streams returned 404 — the API's payment runtime is not mounted. " +
        "Check apps/api/.env: loadAppConfig must succeed for the seller routes to attach.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `POST /v1/streams failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as WireStreamOpen;
}

/**
 * Pull one segment, paying if the seller demands payment.
 *
 * Returns the delivered segment, or `null` when the stream is over.
 */
async function pullSegment(input: {
  apiUrl: string;
  streamId: string;
  payer: string;
}): Promise<{ segment: WireSegment | null; paid: bigint }> {
  const url = `${input.apiUrl}/v1/streams/${input.streamId}/next`;
  const first = await fetch(url);

  if (first.status === 200) {
    return { segment: (await first.json()) as WireSegment, paid: 0n };
  }
  if (first.status === 404) {
    return { segment: null, paid: 0n };
  }
  if (first.status === 503) {
    throw new Error(
      "seller returned 503 (exposure limit) — settlements are not clearing; " +
        "delivery stops at SETTLEMENT_THRESHOLD x MAX_IN_FLIGHT_SETTLEMENTS",
    );
  }
  if (first.status !== 402) {
    throw new Error(`unexpected ${first.status}: ${await first.text()}`);
  }

  const body = (await first.json()) as WirePaymentRequired;
  const requirement = body.accepts[0];
  if (requirement === undefined) {
    throw new Error("402 body carried no accepts[] entry");
  }

  const nonce = randomUUID();
  const header = buildSyntheticEnvelope({
    payer: input.payer,
    requirement,
    nonce,
    deadline: Math.floor(Date.now() / 1000) + WITNESS_TTL_SECONDS,
  });

  const retry = await fetch(url, {
    headers: { "X-PAYMENT": header },
  });

  if (retry.status === 402) {
    const rejection = (await retry.json()) as { classification?: string };
    throw new Error(
      `payment rejected: ${rejection.classification ?? "unknown"}. ` +
        "A real verifier rejects this script's placeholder signature by design.",
    );
  }
  if (!retry.ok) {
    throw new Error(
      `paid retry failed with ${retry.status}: ${await retry.text()}`,
    );
  }

  return {
    segment: (await retry.json()) as WireSegment,
    paid: BigInt(requirement.maxAmountRequired),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const stream = await openStream(options.apiUrl);
  console.log(`stream ${stream.streamId} opened`);
  console.log(`  chain ${stream.chainId}, token ${stream.token}`);
  console.log(`  payTo ${stream.payTo}`);
  console.log(`  payer ${options.payer} (synthetic envelope, no signature)`);
  console.log("");

  let delivered = 0;
  let payments = 0;
  let totalPaid = 0n;

  for (let i = 0; i < options.segments; i += 1) {
    const { segment, paid } = await pullSegment({
      apiUrl: options.apiUrl,
      streamId: stream.streamId,
      payer: options.payer,
    });

    if (segment === null) {
      console.log("stream ended by the seller");
      break;
    }

    delivered += 1;
    if (paid > 0n) {
      payments += 1;
      totalPaid += paid;
    }

    const marker = paid > 0n ? `paid ${paid.toString(10)}` : "free";
    console.log(
      `segment ${segment.sequence}: ${segment.unitsDelivered} units, ` +
        `unpaid ${segment.accruedUnpaid}, total ${segment.totalAccrued} (${marker})`,
    );

    if (segment.streamEnded) {
      console.log(`stream ended: ${segment.endReason ?? "no reason given"}`);
      break;
    }

    if (options.delayMs > 0) await sleep(options.delayMs);
  }

  console.log("");
  console.log(
    `done — ${delivered} segments, ${payments} payments, ${totalPaid.toString(10)} smallest units paid`,
  );
  console.log("Watch it land at http://localhost:3000/console");
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`demo failed: ${message}`);
    process.exit(1);
  },
);
