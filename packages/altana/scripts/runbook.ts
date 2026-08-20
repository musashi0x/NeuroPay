/**
 * The on-chain runbook: a durable record of every chain-touching
 * operator action.
 *
 * The provisioning script printed its transaction hashes to stdout and
 * nothing else. That is how the 2026-08-19 testnet run ended up
 * documented as prose in `TODO.md`, hand-copied out of a terminal
 * scrollback that no longer exists. The verification tasks ask us to
 * *record* hashes, and scrollback is not a record.
 *
 * So every operator script appends a line here instead. The file is
 * JSONL under `.data/` (gitignored — it names real wallets), append-only,
 * and one line per submitted transaction. `renderRunbook` turns it into
 * the markdown table an operator pastes into a checklist.
 *
 * Deliberately not a database: the whole point is that a human can
 * `cat` it after a failed run and still have the hashes.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataPath } from "./paths.js";

/**
 * What kind of on-chain action a record describes.
 *
 * `wallet-funding` is the one entry no script can submit — the operator
 * funds from a faucet out of band — so it is recorded by passing the
 * faucet's hash to `record` by hand, not produced by a call we made.
 */
export type RunbookAction =
  | "wallet-funding"
  | "grant"
  | "approve-token"
  | "approve-checker"
  | "revoke"
  | "revoke-retry"
  | "fee-probe";

export type RunbookRecord = {
  /** ISO-8601 UTC. */
  at: string;
  chainId: number;
  action: RunbookAction;
  /** The smart-account wallet the action was taken on. */
  wallet: string;
  transactionHash: string | null;
  /** The SDK's `ExecuteResult.status`, or a script-supplied label. */
  status: string;
  /** From the receipt. `null` when the receipt was never fetched or the tx never landed. */
  gasUsed: string | null;
  blockNumber: string | null;
  /** Free-text: what the operator was testing, or why a hash is absent. */
  note?: string;
};

const DEFAULT_PATH = ".data/onchain-runbook.jsonl";

/**
 * Where the runbook lives. `RUNBOOK_PATH` overrides for a scratch run.
 *
 * Resolved through `resolveDataPath` so every operator script writes to
 * one file regardless of which package directory it was invoked from —
 * a runbook split across two `.data` folders is not a record.
 */
export function runbookPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataPath(env["RUNBOOK_PATH"]?.trim() || DEFAULT_PATH);
}

/**
 * Append one record. Creates the parent directory on first write.
 *
 * Never throws on a write failure — a runbook that crashes the script
 * after the transaction already landed would lose the very hash it
 * exists to preserve. A failed append is reported to stderr, where the
 * hash is also still printed.
 */
export function record(
  entry: Omit<RunbookRecord, "at"> & { at?: string },
  env: NodeJS.ProcessEnv = process.env,
): RunbookRecord {
  const full: RunbookRecord = { at: new Date().toISOString(), ...entry };
  const path = runbookPath(env);
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `WARNING: could not append to the runbook at ${path}: ${message}\n` +
        `         The record below is only in this terminal — copy it now:\n` +
        `         ${JSON.stringify(full)}`,
    );
  }
  return full;
}

/** Read every record, oldest first. Missing file reads as empty. */
export function readRunbook(
  env: NodeJS.ProcessEnv = process.env,
): RunbookRecord[] {
  const path = runbookPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunbookRecord);
}

/**
 * The receipt fields the runbook wants. Kept structural so a script can
 * pass a viem receipt without this module importing viem's types.
 */
export type ReceiptLike = {
  gasUsed?: bigint;
  blockNumber?: bigint;
  status?: "success" | "reverted";
};

/**
 * Fetch a receipt, tolerating the transaction never landing.
 *
 * The relay returns a hash before the chain has the transaction, so a
 * receipt read straight after submission legitimately misses. We poll to
 * a deadline and then give up — a missing receipt is reported as such,
 * never as a failure, because the transaction may still confirm later.
 */
export async function waitForReceipt(
  client: {
    getTransactionReceipt: (input: {
      hash: `0x${string}`;
    }) => Promise<ReceiptLike | null>;
  },
  hash: `0x${string}`,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ReceiptLike | null> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt !== null && receipt !== undefined) return receipt;
    } catch {
      // viem throws `TransactionReceiptNotFoundError` while the tx is
      // still in the mempool. Indistinguishable from a transport blip
      // here, and both want the same response: wait and ask again.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** Render the runbook as a markdown table for a checklist or a PR body. */
export function renderRunbook(records: RunbookRecord[]): string {
  if (records.length === 0) {
    return "_No on-chain actions recorded yet._";
  }
  const header =
    "| When (UTC) | Action | Chain | Wallet | Tx | Status | Gas |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |";
  const rows = records.map((r) => {
    const tx = r.transactionHash ?? "—";
    return `| ${r.at} | ${r.action} | ${r.chainId} | \`${r.wallet}\` | \`${tx}\` | ${r.status} | ${r.gasUsed ?? "—"} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Add a record for a transaction this tooling did not submit.
 *
 * Two cases need it: the faucet funding, which no script of ours can
 * send, and the 2026-08-19 provisioning run, whose hashes exist only as
 * prose because the runbook did not exist yet. Both are real on-chain
 * events, and the gas and block come from the chain rather than from
 * whoever is typing — so the entry is as trustworthy as one we wrote
 * ourselves, minus the claim that we were the ones who sent it.
 */
export async function addExisting(input: {
  publicClient: {
    getTransactionReceipt: (a: {
      hash: `0x${string}`;
    }) => Promise<ReceiptLike | null>;
  };
  chainId: number;
  action: RunbookAction;
  wallet: string;
  transactionHash: `0x${string}`;
  note?: string;
}): Promise<RunbookRecord> {
  const receipt = await waitForReceipt(
    input.publicClient,
    input.transactionHash,
    { timeoutMs: 15_000 },
  );
  return record({
    chainId: input.chainId,
    action: input.action,
    wallet: input.wallet,
    transactionHash: input.transactionHash,
    status: receipt?.status ?? "unknown",
    gasUsed: receipt?.gasUsed?.toString(10) ?? null,
    blockNumber: receipt?.blockNumber?.toString(10) ?? null,
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
}

/**
 * CLI entry.
 *
 *   tsx scripts/runbook.ts
 *     Print the table. Exists so "record the hashes" has a single
 *     command that answers "what did we actually run, and when".
 *
 *   tsx scripts/runbook.ts --add <action> <wallet> <txHash> [note...]
 *     Backfill a transaction sent outside this tooling. Fetches the
 *     receipt so gas and block are read from the chain.
 */
async function cli(argv: readonly string[]): Promise<void> {
  if (!argv.includes("--add")) {
    console.log(renderRunbook(readRunbook()));
    return;
  }
  const [action, wallet, hash, ...note] = argv.slice(argv.indexOf("--add") + 1);
  if (action === undefined || wallet === undefined || hash === undefined) {
    throw new Error(
      "usage: runbook --add <action> <wallet> <txHash> [note...]",
    );
  }
  const { loadAppConfig } = await import("../src/config/config.js");
  const { buildAltanaClient } = await import("../src/client.js");
  const config = loadAppConfig();
  const ctx = await buildAltanaClient(config.chain);
  const entry = await addExisting({
    publicClient: ctx.publicClient as never,
    chainId: config.chain.chainId,
    action: action as RunbookAction,
    wallet,
    transactionHash: hash as `0x${string}`,
    ...(note.length > 0 ? { note: note.join(" ") } : {}),
  });
  console.log(
    `recorded ${entry.action} ${entry.transactionHash} ` +
      `status=${entry.status} gas=${entry.gasUsed ?? "unknown"}`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
