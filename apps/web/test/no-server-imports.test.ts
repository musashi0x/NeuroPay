/**
 * Guard: the web app must never import the server-only `@neuro-pay/altana`
 * package (which wraps `@altananetwork/sdk` and `viem` — key material).
 *
 * This test shells out to `scripts/check-no-server-imports.mjs`, which
 * scans `apps/web/src/` for any import statement referencing
 * `@neuro-pay/altana` or `packages/altana/`. If the script exits 1
 * (matches found), the test fails with the script's output.
 *
 * The script is also wired as `pnpm -F @neuro-pay/web check:no-server`
 * for ad-hoc CI runs; this test is the safety net for `pnpm -r test`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const SCRIPT = join(WEB_ROOT, "scripts", "check-no-server-imports.mjs");

describe("apps/web — server-only import guard", () => {
  it("does not import @neuro-pay/altana or packages/altana/", () => {
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      const out = execFileSync("node", [SCRIPT], {
        cwd: WEB_ROOT,
        encoding: "utf8",
      });
      stdout = out;
      stderr = "";
      exitCode = 0;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      exitCode = e.status ?? 1;
    }

    expect(
      exitCode,
      `check-no-server-imports.mjs exited ${exitCode}.\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
    ).toBe(0);
  });
});
