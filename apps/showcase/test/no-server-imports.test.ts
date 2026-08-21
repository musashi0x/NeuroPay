/**
 * Guard: the showcase app must never import the server-only `@neuro-pay/altana`
 * package or read `SESSION_PRIVATE_KEY` from a client bundle.
 *
 * This test shells out to `scripts/check-no-server-imports.mjs`, which
 * scans `apps/showcase/src/` for any reference to `@neuro-pay/altana`,
 * `packages/altana/`, or `SESSION_PRIVATE_KEY`. If the script exits 1
 * (matches found), the test fails with the script's output.
 *
 * The script is also wired as `pnpm -F @neuro-pay/showcase check:no-server`
 * for ad-hoc CI runs; this test is the safety net for `pnpm -r test`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOWCASE_ROOT = join(HERE, "..");
const SCRIPT = join(SHOWCASE_ROOT, "scripts", "check-no-server-imports.mjs");

describe("apps/showcase — server-only import guard", () => {
  it("does not import @neuro-pay/altana, packages/altana/, or SESSION_PRIVATE_KEY", () => {
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      const out = execFileSync("node", [SCRIPT], {
        cwd: SHOWCASE_ROOT,
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
