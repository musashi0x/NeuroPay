/**
 * Resolving the paths an operator script shares with the running API.
 *
 * `SESSION_STORE_PATH` and `LEDGER_PATH` live in `apps/api/.env` and are
 * written relative to `apps/api` — that is where the API process runs,
 * so `.data/session.json` is correct *there*. An operator script in
 * `packages/altana` loads the same env file and resolves the same
 * relative path against its own directory, landing on a file that does
 * not exist. The script then reports an empty session store, which reads
 * like "there is nothing to revoke" when the truth is "you are looking
 * in the wrong folder".
 *
 * So a relative path is tried against a few plausible roots and the
 * first one that exists wins. An absolute path is used verbatim and
 * never searched — an operator who spelled out a path meant it.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/altana/scripts` -> the repo root. */
const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPTS_DIR, "../../..");

/**
 * Where a relative data path might live, in the order we try them:
 * the current directory (an operator who cd'd somewhere deliberate),
 * `apps/api` (the API's own working directory, where the env file's
 * paths were written for), then the repo root.
 */
function candidateRoots(): string[] {
  return [process.cwd(), resolve(REPO_ROOT, "apps/api"), REPO_ROOT];
}

/**
 * Resolve a data path that may have been written for another package's
 * working directory.
 *
 * Returns the first candidate that exists. When none does, returns the
 * path resolved against `apps/api` — the location a fresh run should
 * *create*, so a caller that is about to write lands next to the API's
 * other data rather than scattering a second `.data` folder.
 */
export function resolveDataPath(path: string): string {
  if (isAbsolute(path)) return path;
  for (const root of candidateRoots()) {
    const candidate = resolve(root, path);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(REPO_ROOT, "apps/api", path);
}

/**
 * The session store the API reads, resolved for a script's working
 * directory. Mirrors the API's own default when the env is unset.
 */
export function sessionStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataPath(env["SESSION_STORE_PATH"] ?? ".data/session.json");
}
