/**
 * Product copy guard: the showcase chrome must not hardcode a stablecoin.
 *
 * Same shape as `apps/web/test/copy.test.ts` — we ship the rule for
 * both apps so a copy edit cannot accidentally commit "USDC" or
 * "USDT" into the visitor-facing chrome.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOWCASE_ROOT = join(HERE, "..");
const SCAN_ROOTS = [join(SHOWCASE_ROOT, "src"), join(SHOWCASE_ROOT, "public")];

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|html|css)$/.test(entry)) {
      files.push(full);
    }
  }
}

const FILES: string[] = [];
for (const root of SCAN_ROOTS) {
  try {
    if (statSync(root).isDirectory()) walk(root, FILES);
  } catch {
    // the directory may not exist (no public assets yet); skip
  }
}

describe("apps/showcase — product copy", () => {
  it("does not name USDC or USDT in any source file", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      if (/\bUSDC\b/.test(text) || /\bUSDT\b/.test(text)) {
        violations.push(relative(SHOWCASE_ROOT, file));
      }
    }
    expect(violations, `Offending files: ${violations.join(", ")}`).toEqual([]);
  });
});
